/**
 * auth.js — accounts, via Supabase Auth (GoTrue) over plain fetch.
 *
 * The studio is gated: no session, no fort. Published sites stay public —
 * a link you have to sign up to open is not a published site.
 *
 * The session lives in localStorage and is refreshed before it expires. The
 * access token is what publishing authenticates with, so a publication can be
 * tied to the account that made it.
 */

const LS_KEY = 'codefort.session.v1';
const REFRESH_MARGIN_MS = 60_000; // refresh a minute before expiry

export class AuthError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class Auth extends EventTarget {
  /** @param {() => object} getSettings */
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.session = readStored();
    this._timer = null;
  }

  /* ---------------------------------------------------------------- state */

  get user() { return this.session?.user || null; }

  get email() { return this.session?.user?.email || null; }

  get accessToken() { return this.session?.access_token || null; }

  isConfigured() {
    const s = this.getSettings();
    return Boolean(s.supabaseUrl && s.supabaseKey);
  }

  isSignedIn() {
    return Boolean(this.session?.access_token && this.session.expires_at > Date.now());
  }

  #base() {
    return this.getSettings().supabaseUrl.replace(/\/+$/, '') + '/auth/v1';
  }

  #headers(extra = {}) {
    return {
      apikey: this.getSettings().supabaseKey,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  #store(session) {
    this.session = session;
    if (session) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(session)); } catch { /* quota */ }
      this.#scheduleRefresh();
    } else {
      try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      clearTimeout(this._timer);
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { session } }));
  }

  #scheduleRefresh() {
    clearTimeout(this._timer);
    if (!this.session?.refresh_token) return;
    const delay = Math.max(5_000, this.session.expires_at - Date.now() - REFRESH_MARGIN_MS);
    // setTimeout overflows past ~24.8 days and fires immediately; clamp well short of that.
    this._timer = setTimeout(() => {
      this.refresh().catch(() => this.#store(null));
    }, Math.min(delay, 2_000_000_000));
  }

  /* ----------------------------------------------------------- operations */

  /**
   * Restore a stored session, refreshing it if it has expired.
   * @returns {Promise<boolean>} whether we ended up signed in
   */
  async restore() {
    if (!this.isConfigured() || !this.session) return false;
    if (this.isSignedIn()) {
      this.#scheduleRefresh();
      return true;
    }
    try {
      await this.refresh();
      return true;
    } catch {
      this.#store(null);
      return false;
    }
  }

  /**
   * Create an account.
   * @returns {Promise<{signedIn: boolean, needsConfirmation: boolean, email: string}>}
   * When the project requires email confirmation, signup succeeds without a
   * session and the caller has to tell the user to go and click the link.
   */
  async signUp(email, password) {
    this.#assertUsable(email, password);

    const data = await this.#post('/signup', { email, password });
    const session = toSession(data);

    if (session) {
      this.#store(session);
      return { signedIn: true, needsConfirmation: false, email };
    }
    return { signedIn: false, needsConfirmation: true, email };
  }

  /** Sign in to an existing account. */
  async signIn(email, password) {
    this.#assertUsable(email, password);

    const data = await this.#post('/token?grant_type=password', { email, password });
    const session = toSession(data);
    if (!session) throw new AuthError('Signed in, but no session came back. Try again.');

    this.#store(session);
    return session;
  }

  /** Exchange the refresh token for a fresh access token. */
  async refresh() {
    const token = this.session?.refresh_token;
    if (!token) throw new AuthError('nothing to refresh');

    const data = await this.#post('/token?grant_type=refresh_token', { refresh_token: token });
    const session = toSession(data);
    if (!session) throw new AuthError('refresh returned no session');

    this.#store(session);
    return session;
  }

  /** Sign out locally, and revoke on the server when we can reach it. */
  async signOut() {
    const token = this.accessToken;
    this.#store(null);
    if (!token || !this.isConfigured()) return;
    try {
      await fetch(this.#base() + '/logout', {
        method: 'POST',
        headers: this.#headers({ Authorization: `Bearer ${token}` })
      });
    } catch {
      /* already signed out locally, which is what matters here */
    }
  }

  /** Send a password-reset email. */
  async requestPasswordReset(email) {
    if (!this.isConfigured()) throw new AuthError(NOT_CONFIGURED);
    if (!isEmail(email)) throw new AuthError('That does not look like an email address.');
    await this.#post('/recover', { email });
  }

  /* -------------------------------------------------------------- plumbing */

  #assertUsable(email, password) {
    if (!this.isConfigured()) throw new AuthError(NOT_CONFIGURED);
    if (!isEmail(email)) throw new AuthError('That does not look like an email address.');
    if (!password || password.length < 8) {
      throw new AuthError('Password must be at least 8 characters.');
    }
  }

  async #post(path, body) {
    let res;
    try {
      res = await fetch(this.#base() + path, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body)
      });
    } catch {
      throw new AuthError('Could not reach the account service. Check your connection.');
    }

    const text = await res.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }

    if (!res.ok) throw new AuthError(friendlyError(data, res.status), { status: res.status });
    return data;
  }
}

/* -------------------------------------------------------------- helpers */

const NOT_CONFIGURED =
  'Accounts are unavailable: this CodeFort has no Supabase configured. ' +
  'Set the SUP_URL and SUP_PB repository secrets and redeploy.';

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/** GoTrue returns the session at the top level or nested, depending on the call. */
export function toSession(data) {
  const src = data?.access_token ? data : data?.session;
  if (!src?.access_token) return null;

  const lifetimeMs = (Number(src.expires_in) || 3600) * 1000;
  return {
    access_token: src.access_token,
    refresh_token: src.refresh_token || null,
    expires_at: src.expires_at ? Number(src.expires_at) * 1000 : Date.now() + lifetimeMs,
    user: {
      id: src.user?.id || data?.user?.id || null,
      email: src.user?.email || data?.user?.email || null
    }
  };
}

/** Turn GoTrue's error shapes into one sentence a person can act on. */
export function friendlyError(data, status) {
  const raw = String(
    data?.error_description || data?.msg || data?.message || data?.error || ''
  ).trim();

  const lower = raw.toLowerCase();
  if (lower.includes('invalid login credentials')) return 'Wrong email or password.';
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'That email already has an account — sign in instead.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Confirm your email first — check your inbox for the link.';
  }
  if (lower.includes('password should be')) return 'Password must be at least 8 characters.';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status === 404) return 'The account service is not reachable at that Supabase URL.';

  return raw || `Account service error (HTTP ${status}).`;
}

function readStored() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session?.access_token ? session : null;
  } catch {
    return null;
  }
}
