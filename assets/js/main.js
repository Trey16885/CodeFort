/**
 * main.js — bootstrap and wiring.
 *
 * Three modes on the same page:
 *   ?=<slug>   viewer  — render a published workspace (public, no account)
 *   signed out gate    — create an account or sign in
 *   signed in  studio  — the multi-model agent workbench
 */

import { getSettings, saveSettings, credentialSource, buildInfo } from './config.js';
import { AGENTS } from './agents.js';
import { bus } from './thoughts.js';
import { vfs, normalize } from './vfs.js';
import { Orchestrator } from './orchestrator.js';
import { Auth } from './auth.js';
import { UI, $ } from './ui.js';
import * as supa from './supabase.js';

const auth = new Auth(getSettings);

/* ==================================================================== boot */

const slug = supa.slugFromLocation();
if (slug) {
  // A published link is public by design — an account requirement here would
  // make "publish" meaningless.
  startViewer(slug);
} else if (await auth.restore()) {
  startStudio();
} else {
  startGate();
}

/* ================================================================== viewer */

async function startViewer(slug) {
  const root = $('#viewer');
  root.hidden = false;
  document.title = `CodeFort — ${slug}`;

  const titleEl = $('#viewer-title');
  const bylineEl = $('#viewer-byline');
  const frame = $('#viewer-frame');
  const codeEl = $('#viewer-code');

  try {
    const pub = await supa.fetchPublication(slug, getSettings());
    const html = supa.bundleToHtml(pub.files, pub.entry || '/index.html');

    document.title = `${pub.title || 'CodeFort'} — by ${pub.name}`;
    titleEl.textContent = pub.title || 'Untitled build';
    bylineEl.textContent =
      `published by ${pub.name}` +
      (pub.created_at ? ` · ${new Date(pub.created_at).toLocaleDateString()}` : '') +
      (pub.description ? ` · ${pub.description}` : '');

    frame.srcdoc = html;
    codeEl.textContent = Object.entries(pub.files)
      .filter(([, c]) => c !== null)
      .map(([p, c]) => `===== ${p} =====\n${c}`)
      .join('\n\n');

    $('#viewer-source').addEventListener('click', () => {
      const showing = !codeEl.hidden;
      codeEl.hidden = showing;
      frame.hidden = !showing;
      $('#viewer-source').textContent = showing ? 'View source' : 'View site';
    });
  } catch (err) {
    titleEl.textContent = 'Could not load this build';
    bylineEl.textContent = err.message;
    frame.srcdoc = `<!doctype html><meta charset="utf-8">
<body style="margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui;background:#11151f;color:#f87171;text-align:center;padding:24px">
${escapeHtml(err.message)}</body>`;
  }
}

/* ==================================================================== gate */

function startGate() {
  const gate = $('#gate');
  const form = $('#gate-form');
  const submit = $('#gate-submit');
  const message = $('#gate-message');
  const emailEl = $('#gate-email');
  const passwordEl = $('#gate-password');

  gate.hidden = false;
  let mode = 'signup';

  const say = (text, kind = 'error') => {
    message.hidden = false;
    message.className = `gate-message${kind === 'error' ? '' : ' ' + kind}`;
    message.textContent = text;
  };
  const quiet = () => { message.hidden = true; };

  const setMode = (next) => {
    mode = next;
    quiet();
    for (const tab of document.querySelectorAll('.gate-tab')) {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    }
    submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    passwordEl.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    passwordEl.placeholder = mode === 'signup' ? 'at least 8 characters' : 'your password';
    $('#gate-swap-hint').innerHTML = mode === 'signup'
      ? 'Already have one? <button class="linklike" data-mode="signin" type="button">Sign in</button>'
      : 'New here? <button class="linklike" data-mode="signup" type="button">Create an account</button>';
  };

  // Both the tabs and the swap link carry data-mode, so one listener covers them.
  gate.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-mode]');
    if (target) setMode(target.dataset.mode);
  });

  if (!auth.isConfigured()) {
    say('Accounts are unavailable: this CodeFort has no Supabase project configured. ' +
        'Set the SUP_URL and SUP_PB repository secrets and redeploy.', 'info');
    submit.disabled = true;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    quiet();

    const email = emailEl.value.trim();
    const password = passwordEl.value;

    submit.disabled = true;
    submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';

    try {
      if (mode === 'signup') {
        const result = await auth.signUp(email, password);
        if (!result.signedIn) {
          say(`Account created. Check ${email} for a confirmation link, then sign in.`, 'ok');
          setMode('signin');
          return;
        }
      } else {
        await auth.signIn(email, password);
      }
      enterStudio();
    } catch (err) {
      say(err.message);
    } finally {
      submit.disabled = !auth.isConfigured();
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    }
  });

  $('#gate-forgot').addEventListener('click', async () => {
    const email = emailEl.value.trim();
    if (!email) {
      say('Type your email above first, then press this.', 'info');
      emailEl.focus();
      return;
    }
    try {
      await auth.requestPasswordReset(email);
      say(`If ${email} has an account, a reset link is on its way.`, 'ok');
    } catch (err) {
      say(err.message);
    }
  });

  function enterStudio() {
    gate.hidden = true;
    form.reset();
    startStudio();
  }

  setMode('signup');
  emailEl.focus();
}

/* ================================================================== studio */

function startStudio() {
  $('#studio').hidden = false;

  const ui = new UI();
  const orch = new Orchestrator({
    getSettings,
    getSession: () => auth.session,
    log: (text, cls) => ui.log(text, cls),
    onPublish: (info) => announcePublication(ui, info)
  });

  const verdicts = new Map();
  let activeAgentId = null;

  /* ------------------------------------------------------------ workspace */

  const refreshTree = () => {
    ui.renderTree(
      (path) => ui.openFile(path),
      (path) => {
        if (!confirm(`Delete ${path}?`)) return;
        vfs.remove(path, true);
      }
    );
  };

  vfs.addEventListener('change', (e) => {
    refreshTree();
    ui.syncOpenFile();
    if (e.detail?.path && e.detail.action !== 'delete') ui.flashNode(e.detail.path);
    if ($('.tab.active')?.dataset.tab === 'preview') ui.renderPreview();
  });

  vfs.hydrate();
  refreshTree();

  /* --------------------------------------------------------------- stream */

  bus.addEventListener('post', (e) => ui.renderEntry(e.detail));
  bus.addEventListener('clear', () => ui.clearStream());

  /* --------------------------------------------------------- orchestrator */

  orch.addEventListener('start', () => {
    ui.setRunning(true);
    ui.setStatus({ round: 0, agent: '—' });
  });

  orch.addEventListener('round', (e) => ui.setStatus({ round: e.detail.round }));

  orch.addEventListener('turn', (e) => {
    activeAgentId = e.detail.agent.id;
    ui.setStatus({ agent: `${e.detail.agent.name} is working` });
    ui.renderRoster(getSettings(), { activeId: activeAgentId, verdicts });
  });

  orch.addEventListener('verdict', (e) => {
    verdicts.set(e.detail.agent.id, e.detail);
    ui.renderRoster(getSettings(), { activeId: activeAgentId, verdicts });
  });

  orch.addEventListener('usage', (e) => ui.setStatus({ tokens: e.detail.total }));

  orch.addEventListener('end', (e) => {
    activeAgentId = null;
    ui.setRunning(false);
    ui.setStatus({ agent: outcomeLabel(e.detail.outcome) });
    ui.renderRoster(getSettings(), { verdicts });
    ui.renderPreview();
  });

  /* ------------------------------------------------------------ run / stop */

  $('#task-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();

    const task = $('#task-input').value.trim();
    if (!task) {
      ui.hint('Describe what you want built first.');
      $('#task-input').focus();
      return;
    }

    const settings = getSettings();
    if (!settings.mistralKey) {
      ui.hint('No Mistral API key yet — add one to start.');
      ui.log('cannot start: no Mistral API key configured', 'c-err');
      openSettings(ui, 'Add a Mistral API key to start a run.');
      return;
    }

    verdicts.clear();
    try {
      await orch.run(task);
    } catch (err) {
      ui.log(err.message, 'c-err');
      ui.setRunning(false);
    }
  });

  $('#task-input').addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      $('#task-form').requestSubmit();
    }
  });

  $('#btn-stop').addEventListener('click', () => {
    orch.stop();
    ui.log('stop requested — finishing the current step', 'c-err');
  });

  /* -------------------------------------------------------- file controls */

  $('#btn-new-file').addEventListener('click', async () => {
    const path = await askFor('New file', 'Path', '/index.html');
    if (!path) return;
    if (vfs.exists(path)) { ui.openFile(path); return; }
    vfs.write(path, '');
    ui.openFile(path);
  });

  $('#btn-new-folder').addEventListener('click', async () => {
    const path = await askFor('New folder', 'Path', '/assets');
    if (path) vfs.mkdir(path);
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Clear the whole workspace? This cannot be undone.')) return;
    ui.setDirty(false);              // drop the unsaved buffer with the file
    vfs.clear();
  });

  /* -------------------------------------------------------------- editor */

  ui.el.editor.addEventListener('input', () => ui.setDirty(true));

  ui.el.editor.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
      ev.preventDefault();
      saveEditor();
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const el = ui.el.editor;
      const { selectionStart: a, selectionEnd: b } = el;
      el.value = el.value.slice(0, a) + '  ' + el.value.slice(b);
      el.selectionStart = el.selectionEnd = a + 2;
      ui.setDirty(true);
    }
  });

  $('#btn-save').addEventListener('click', saveEditor);

  function saveEditor() {
    if (!ui.selected || !ui.dirty) return;
    vfs.write(ui.selected, ui.el.editor.value);
    ui.setDirty(false);
  }

  /* ---------------------------------------------------------------- tabs */

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const p of document.querySelectorAll('.tabpane')) {
        p.classList.toggle('active', p.dataset.pane === tab.dataset.tab);
      }
      if (tab.dataset.tab === 'preview') ui.renderPreview();
    });
  }

  $('#btn-refresh-preview').addEventListener('click', () => ui.renderPreview());
  $('#btn-clear-console').addEventListener('click', () => ui.clearConsole());
  $('#btn-clear-stream').addEventListener('click', () => bus.clear());

  $('#filter-tools').addEventListener('change', (e) => {
    ui.streamFilters.tools = e.target.checked;
    replayStream(ui);
  });
  $('#filter-thoughts').addEventListener('change', (e) => {
    ui.streamFilters.thoughts = e.target.checked;
    replayStream(ui);
  });

  /* ------------------------------------------------------------- account */

  $('#account').textContent = auth.email || 'signed in';
  $('#account').title = `Signed in as ${auth.email || 'this account'}`;

  $('#btn-signout').addEventListener('click', async () => {
    if (orch.running && !confirm('A run is in progress. Sign out anyway?')) return;
    orch.stop();
    ui.setDirty(false);          // don't fight the unload warning on the way out
    await auth.signOut();
  });

  // Covers both the sign-out button and a refresh token that stopped working.
  auth.addEventListener('change', (ev) => {
    if (!ev.detail.session) location.reload();
  });

  /* ------------------------------------------------------------ settings */

  $('#btn-settings').addEventListener('click', () => openSettings(ui));

  $('#dlg-settings').addEventListener('close', (ev) => {
    if (ev.target.returnValue !== 'save') return;
    saveSettings({
      mistralKey: $('#set-key').value.trim(),
      supabaseUrl: $('#set-sup-url').value.trim(),
      supabaseKey: $('#set-sup-key').value.trim(),
      maxRounds: clampInt($('#set-rounds').value, 1, 40, 8),
      maxStepsPerTurn: clampInt($('#set-steps').value, 1, 20, 8),
      temperature: clampFloat($('#set-temp').value, 0, 1.5, 0.35),
      models: {
        architect: $('#set-model-architect').value.trim() || 'mistral-large-latest',
        builder: $('#set-model-builder').value.trim() || 'mistral-medium-latest',
        scout: $('#set-model-scout').value.trim() || 'mistral-small-latest'
      }
    });
    syncHeader(ui);
  });

  /* ------------------------------------------------------------- publish */

  $('#btn-publish').addEventListener('click', () => {
    const settings = getSettings();
    const result = $('#pub-result');
    result.hidden = true;
    $('#pub-name').value = $('#pub-name').value || auth.email || 'CodeFort';
    $('#pub-title').value = $('#pub-title').value || 'A CodeFort build';

    if (!supa.isConfigured(settings)) {
      result.hidden = false;
      result.textContent = 'Supabase is not configured. Set SUP_URL and SUP_PB as repository secrets, or fill them in under Settings.';
    }
    $('#dlg-publish').showModal();
  });

  $('#dlg-publish').addEventListener('close', async (ev) => {
    if (ev.target.returnValue !== 'publish') return;
    try {
      const info = await supa.publish({
        settings: getSettings(),
        session: auth.session,
        files: vfs.snapshot(),
        name: $('#pub-name').value.trim() || auth.email || 'CodeFort',
        title: $('#pub-title').value.trim(),
        description: $('#pub-desc').value.trim()
      });
      announcePublication(ui, info);
    } catch (err) {
      ui.log(err.message, 'c-err');
      alert(err.message);
    }
  });

  /* ---------------------------------------------------------------- init */

  syncHeader(ui);
  ui.renderRoster(getSettings(), { verdicts });
  ui.renderPreview();

  ui.log('CodeFort ready.');
  if (buildInfo.builtAt) ui.log(`build ${buildInfo.commit?.slice(0, 7) || ''} — ${buildInfo.builtAt}`);
  ui.log(`agents: ${AGENTS.map((a) => a.name).join(', ')}`);
  if (!getSettings().mistralKey) ui.log('no Mistral key configured — open Settings to add one', 'c-err');

  window.addEventListener('beforeunload', (ev) => {
    if (orch.running || ui.dirty) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
}

/* ================================================================ helpers */

function syncHeader(ui) {
  const settings = getSettings();
  ui.setKeyState(Boolean(settings.mistralKey), credentialSource('mistralKey'));
  ui.renderRoster(settings, {});
}

function openSettings(ui, message) {
  const s = getSettings();
  $('#set-key').value = credentialSource('mistralKey') === 'browser' ? s.mistralKey : '';
  $('#set-sup-url').value = credentialSource('supabaseUrl') === 'browser' ? s.supabaseUrl : '';
  $('#set-sup-key').value = credentialSource('supabaseKey') === 'browser' ? s.supabaseKey : '';
  $('#set-model-architect').value = s.models.architect;
  $('#set-model-builder').value = s.models.builder;
  $('#set-model-scout').value = s.models.scout;
  $('#set-rounds').value = s.maxRounds;
  $('#set-steps').value = s.maxStepsPerTurn;
  $('#set-temp').value = s.temperature;

  const hint = $('#set-key-hint');
  const source = credentialSource('mistralKey');
  hint.textContent = message ||
    (source === 'deploy'
      ? 'A key is already baked in from the deploy. Type one here to use your own instead.'
      : source === 'browser'
        ? 'Using the key stored in this browser.'
        : 'No key yet. Get one at console.mistral.ai.');

  $('#dlg-settings').showModal();
}

function announcePublication(ui, info) {
  const result = $('#pub-result');
  if (result) {
    result.hidden = false;
    result.innerHTML = `Published: <a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">${escapeHtml(info.url)}</a>`;
  }
  ui.log(`published: ${info.url}`, 'c-ok');
  bus.post({ who: 'CodeFort', text: `Published to ${info.url}` });
}

function replayStream(ui) {
  ui.clearStream();
  for (const entry of bus.entries) ui.renderEntry(entry);
}

/** Promise-based replacement for window.prompt, using the shared dialog. */
function askFor(title, label, placeholder = '') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    const input = $('#prompt-input');
    input.value = '';
    input.placeholder = placeholder;

    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' && input.value.trim() ? normalize(input.value.trim()) : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
  });
}

function outcomeLabel(outcome) {
  return {
    done: 'consensus — all agents done',
    exhausted: 'round limit reached',
    stopped: 'stopped',
    error: 'run failed'
  }[outcome] || outcome;
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function clampFloat(v, lo, hi, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
