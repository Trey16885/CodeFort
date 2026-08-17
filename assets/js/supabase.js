/**
 * supabase.js — publishing.
 *
 * A published workspace is one row in the `publications` table. The slug is a
 * random string, and the fort is served back at:
 *
 *     https://<host>/CodeFort/?=<slug>
 *
 * Talks to PostgREST over plain fetch — no SDK, no build step. The key used
 * here is the publishable/anon key, which is designed to be public and is
 * gated by row-level security (see supabase/schema.sql).
 */

const TABLE = 'publications';
const SLUG_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l/1/0/o
const SLUG_LENGTH = 12;

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

export function makeSlug(length = SLUG_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

/** The slug in the current URL, supporting `?=slug`, `?p=slug` and `#slug`. */
export function slugFromLocation(loc = window.location) {
  const params = new URLSearchParams(loc.search);
  const bare = params.get('');            // the `?=randomstring` form
  const named = params.get('p') || params.get('site') || params.get('id');
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : '';
  const raw = (bare || named || hash || '').trim();
  return /^[A-Za-z0-9_-]{4,64}$/.test(raw) ? raw : null;
}

export function publicUrlFor(slug, loc = window.location) {
  return `${loc.origin}${loc.pathname}?=${slug}`;
}

export function isConfigured(settings) {
  return Boolean(settings.supabaseUrl && settings.supabaseKey);
}

/**
 * `apikey` is always the publishable key — it identifies the project. The
 * bearer token is what identifies the *caller*: a user's access token when we
 * have one (so row-level security sees `auth.uid()`), the anon key otherwise
 * for public reads.
 */
function headers(settings, { token, ...extra } = {}) {
  return {
    apikey: settings.supabaseKey,
    Authorization: `Bearer ${token || settings.supabaseKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

function restBase(settings) {
  return settings.supabaseUrl.replace(/\/+$/, '') + '/rest/v1';
}

/**
 * Turn a PostgREST error into something with a next step in it.
 *
 * The raw messages are accurate but assume you know PostgREST: "Could not find
 * the table 'public.publications' in the schema cache" is what you get when the
 * schema was never applied, and it does not mention the file that would fix it.
 */
export function friendlyRestError(data, status) {
  const code = data?.code || '';
  const raw = String(data?.message || data?.hint || data?.error_description || '').trim();

  // PGRST205: table missing. PGRST106: schema not exposed.
  if (code === 'PGRST205' || /schema cache/i.test(raw)) {
    return 'this deployment\'s database has no "publications" table yet — ' +
           'run supabase/schema.sql in the Supabase SQL editor, then try again';
  }
  if (code === 'PGRST106') {
    return 'the "public" schema is not exposed through the Supabase API — ' +
           'enable it under Project Settings → API';
  }
  // 42501 is Postgres "insufficient privilege"; RLS refusals surface as 401/403.
  if (code === '42501' || status === 401 || status === 403) {
    return 'the database refused that — check you are signed in, and that the ' +
           'row-level security policies from supabase/schema.sql are applied';
  }
  if (code === '23505') {
    return 'that publication id is already taken — try again';
  }
  if (status === 404) {
    return 'the Supabase REST endpoint was not found — check SUP_URL points at the right project';
  }

  return raw || `HTTP ${status}`;
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    return friendlyRestError(JSON.parse(text), res.status);
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

/**
 * Store the workspace under a fresh slug, owned by the signed-in account.
 * @returns {Promise<{slug: string, url: string}>}
 */
export async function publish({ settings, session, files, name, title, description, entry = '/index.html' }) {
  if (!isConfigured(settings)) {
    throw new PublishError('Supabase is not configured — set the SUP_URL and SUP_PB repository secrets and redeploy.');
  }
  if (!session?.access_token || !session.user?.id) {
    throw new PublishError('Publishing needs an account. Sign in and try again.');
  }
  if (!files || !Object.keys(files).length) {
    throw new PublishError('nothing to publish: the workspace is empty');
  }

  const payload = {
    slug: makeSlug(),
    user_id: session.user.id,
    name: (name || session.user.email || 'CodeFort').slice(0, 120),
    title: (title || 'A CodeFort build').slice(0, 200),
    description: (description || '').slice(0, 500),
    entry,
    files
  };

  const res = await fetch(`${restBase(settings)}/${TABLE}`, {
    method: 'POST',
    headers: headers(settings, { token: session.access_token, Prefer: 'return=representation' }),
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new PublishError(`publish failed: ${await readError(res)}`);

  const rows = await res.json().catch(() => []);
  const slug = rows[0]?.slug || payload.slug;

  // Return the name and title too: they are what distinguishes one publication
  // of a task from another in the take-down list.
  return { slug, url: publicUrlFor(slug), name: payload.name, title: payload.title };
}

/**
 * Take a published site down.
 *
 * The delete policy is `user_id = auth.uid()`, so a row belonging to someone
 * else simply matches nothing rather than erroring — which is indistinguishable
 * from a row that was already deleted. `removed` reports which happened so the
 * caller can say something true rather than claiming a success it didn't get.
 *
 * @returns {Promise<{slug: string, removed: boolean}>}
 */
export async function unpublish({ settings, session, slug }) {
  if (!isConfigured(settings)) {
    throw new PublishError('Supabase is not configured — set the SUP_URL and SUP_PB repository secrets and redeploy.');
  }
  if (!session?.access_token) {
    throw new PublishError('Unpublishing needs an account. Sign in and try again.');
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(slug || ''))) {
    throw new PublishError(`"${slug}" is not a valid publication id`);
  }

  const res = await fetch(`${restBase(settings)}/${TABLE}?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: headers(settings, { token: session.access_token, Prefer: 'return=representation' })
  });

  if (!res.ok) throw new PublishError(`unpublish failed: ${await readError(res)}`);

  const rows = await res.json().catch(() => []);
  return { slug, removed: Array.isArray(rows) && rows.length > 0 };
}

/** Fetch a publication by slug. */
export async function fetchPublication(slug, settings) {
  if (!isConfigured(settings)) {
    throw new PublishError('This CodeFort deployment has no Supabase configured, so published sites cannot be loaded.');
  }
  const url = `${restBase(settings)}/${TABLE}?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`;
  const res = await fetch(url, { headers: headers(settings) });
  if (!res.ok) throw new PublishError(`could not load "${slug}": ${await readError(res)}`);

  const rows = await res.json();
  if (!rows.length) throw new PublishError(`no published site with the id "${slug}"`);
  return rows[0];
}

/* --------------------------------------------------------------- rendering */

const MIME = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  html: 'text/html',
  txt: 'text/plain'
};

/**
 * Turn a `{path: content}` bundle into one self-contained HTML document.
 *
 * Published sites run inside a sandboxed iframe with no same-origin access,
 * so relative <link>/<script>/<img src> requests would 404. Instead every
 * local reference is inlined or rewritten to a data: URL.
 */
export function bundleToHtml(files, entry = '/index.html') {
  const norm = {};
  for (const [p, c] of Object.entries(files)) {
    if (c === null) continue;
    norm[p.startsWith('/') ? p : '/' + p] = c;
  }

  const entryPath = norm[entry] !== undefined
    ? entry
    : Object.keys(norm).find((p) => p.toLowerCase().endsWith('index.html')) ||
      Object.keys(norm).find((p) => p.toLowerCase().endsWith('.html'));

  if (!entryPath) {
    const listing = Object.keys(norm).sort().map((p) => `  ${p}`).join('\n');
    return `<!doctype html><meta charset="utf-8"><title>CodeFort bundle</title>
<body style="font:14px ui-monospace,monospace;padding:24px;background:#0b0e14;color:#dbe3f0">
<h1>No HTML entry point</h1><p>This publication contains:</p><pre>${escapeHtml(listing)}</pre></body>`;
  }

  const resolve = (ref) => {
    const clean = ref.split('#')[0].split('?')[0];
    const candidates = clean.startsWith('/')
      ? [clean]
      : [
          '/' + clean.replace(/^\.\//, ''),
          '/' + clean.replace(/^\.\.\//, ''),
          clean.replace(/^\.\//, '/')
        ];
    for (const c of candidates) if (norm[c] !== undefined) return norm[c];
    return null;
  };

  const dataUrl = (ref, text) => {
    const ext = ref.split('.').pop().toLowerCase();
    return `data:${MIME[ext] || 'text/plain'};charset=utf-8,${encodeURIComponent(text)}`;
  };

  let html = norm[entryPath];

  // <link rel="stylesheet" href="..."> -> <style>
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^(https?:|data:|\/\/)/i.test(href)) return tag;
    const css = resolve(href);
    return css === null ? tag : `<style>\n${css}\n</style>`;
  });

  // <script src="..."></script> -> inline
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, pre, src, post) => {
    if (/^(https?:|data:|\/\/)/i.test(src)) return tag;
    const js = resolve(src);
    if (js === null) return tag;
    const attrs = `${pre} ${post}`.replace(/\bsrc=["'][^"']*["']/i, '').trim();
    return `<script ${attrs}>\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
  });

  // img/audio/video/iframe/anchor srcs -> data: URLs
  html = html.replace(/\b(src|href)=["']([^"':][^"']*)["']/gi, (attr, name, ref) => {
    if (/^(https?:|data:|mailto:|#|\/\/)/i.test(ref)) return attr;
    const body = resolve(ref);
    return body === null ? attr : `${name}="${dataUrl(ref, body)}"`;
  });

  return html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
