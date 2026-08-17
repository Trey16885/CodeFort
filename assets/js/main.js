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
import { tasks } from './tasks.js';
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

  /* ---------------------------------------------------------------- tasks */

  // Streams are per-task but not persisted — switching back inside a session
  // brings the discussion with it; a reload starts the log fresh.
  const streams = new Map();

  tasks.addEventListener('change', (e) => {
    ui.renderTasks(e.detail.tasks, e.detail.activeId, pickTask);
  });

  tasks.addEventListener('quota', () => {
    ui.log('browser storage is full — tasks will stop saving until you delete one', 'c-err');
  });

  tasks.hydrate();
  $('#task-input').value = tasks.active?.brief || '';
  refreshTree();

  function pickTask(id) {
    if (id === tasks.activeId) return;
    if (orch.running) {
      ui.hint('Finish or stop the run before switching tasks.');
      return;
    }
    streams.set(tasks.activeId, bus.entries);
    ui.setDirty(false);

    const next = tasks.switchTo(id);
    bus.entries = streams.get(id) || [];
    replayStream(ui);

    $('#task-input').value = next.brief || '';
    verdicts.clear();
    ui.renderRoster(getSettings(), { verdicts });
    ui.setStatus({ round: 0, agent: '—' });
  }

  /* --------------------------------------------------------------- stream */

  bus.addEventListener('post', (e) => ui.renderEntry(e.detail));
  bus.addEventListener('clear', () => ui.clearStream());

  /* --------------------------------------------------------- orchestrator */

  orch.addEventListener('start', () => {
    ui.setRunning(true);
    ui.setTasksLocked(true);
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
    ui.setTasksLocked(false);
    ui.setStatus({ agent: outcomeLabel(e.detail.outcome) });
    ui.renderRoster(getSettings(), { verdicts });
    ui.renderPreview();
    // announcePublication already recorded it via the toolbox's onPublish hook.
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
    tasks.setBrief(task, { rename: true });   // an unnamed task takes its name from the brief

    try {
      await orch.run(task);
    } catch (err) {
      ui.log(err.message, 'c-err');
      ui.setRunning(false);
      ui.setTasksLocked(false);
    }
  });

  // Keep the brief with its task even if the run is never started — and let it
  // name a still-unnamed task, so the list doesn't fill up with "New task".
  $('#task-input').addEventListener('change', () => {
    tasks.setBrief($('#task-input').value, { rename: true });
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

  /* -------------------------------------------------------- task controls */

  $('#btn-new-task').addEventListener('click', async () => {
    const name = await askFor('New task', 'Name', 'e.g. Landing page', { raw: true });
    if (name === null) return;

    streams.set(tasks.activeId, bus.entries);
    try {
      tasks.create(name || 'New task');
    } catch (err) {
      ui.hint(err.message);
      return;
    }
    bus.entries = [];
    replayStream(ui);

    $('#task-input').value = '';
    $('#task-input').focus();
    verdicts.clear();
    ui.setDirty(false);
    ui.renderRoster(getSettings(), { verdicts });
    ui.setStatus({ round: 0, agent: '—' });
  });

  $('#btn-rename-task').addEventListener('click', async () => {
    const current = tasks.active;
    if (!current) return;
    const name = await askFor('Rename task', 'Name', current.name, { raw: true });
    if (name) tasks.rename(current.id, name);
  });

  $('#btn-delete-task').addEventListener('click', () => {
    const current = tasks.active;
    if (!current) return;
    if (!confirm(`Delete "${current.name}" and its workspace? This cannot be undone.`)) return;

    streams.delete(current.id);
    ui.setDirty(false);
    tasks.remove(current.id);

    bus.entries = streams.get(tasks.activeId) || [];
    replayStream(ui);
    $('#task-input').value = tasks.active?.brief || '';
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
      maxRounds: clampInt($('#set-rounds').value, 1, 40, 8),
      maxStepsPerTurn: clampInt($('#set-steps').value, 1, 20, 8),
      temperature: clampFloat($('#set-temp').value, 0, 1.5, 0.35)
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
      result.textContent = 'Supabase is not configured. Set the SUP_URL and SUP_PB repository secrets and redeploy.';
    }
    // Publishing again mints a new slug rather than overwriting, so without
    // this the task quietly accumulates duplicate live sites.
    const live = tasks.publications();
    $('#pub-replace-wrap').hidden = live.length === 0;
    $('#pub-replace-label').textContent = live.length === 1
      ? 'This task already has a live site. Take it down once the new one is up.'
      : `This task already has ${live.length} live sites. Take them down once the new one is up.`;

    renderLivePublications();
    $('#dlg-publish').showModal();
  });

  /**
   * One row: the link, a subtitle, and a take-down button.
   * Shared by the per-task list and the account-wide "My sites" list.
   */
  function publicationRow(entry, onError) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'pub-meta';

    const link = document.createElement('a');
    link.className = 'pub-url';
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = entry.url;

    const when = document.createElement('span');
    when.className = 'pub-when';
    const stamp = entry.at || entry.created_at;
    when.textContent = [entry.title, stamp ? new Date(stamp).toLocaleString() : null]
      .filter(Boolean).join(' · ');

    meta.append(link, when);

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'btn danger sm';
    kill.textContent = 'Unpublish';

    kill.addEventListener('click', async () => {
      if (!confirm(`Take down ${entry.url}?\n\nThe link stops working for everyone. This cannot be undone.`)) return;

      kill.disabled = true;
      li.classList.add('going');
      kill.textContent = 'Taking down…';

      try {
        const { removed } = await supa.unpublish({
          settings: getSettings(),
          session: auth.session,
          slug: entry.slug
        });

        tasks.removePublication(entry.slug);
        li.classList.remove('going');
        li.classList.add('gone');
        kill.remove();
        when.textContent = removed
          ? 'taken down'
          : 'already gone from the server — removed from this list';
        ui.log(`unpublished ${entry.url}${removed ? '' : ' (was already gone)'}`, 'c-ok');
        bus.post({ who: 'CodeFort', text: `Unpublished ${entry.url}` });
      } catch (err) {
        li.classList.remove('going');
        kill.disabled = false;
        kill.textContent = 'Unpublish';
        onError?.(err);
        ui.log(err.message, 'c-err');
      }
    });

    li.append(meta, kill);
    return li;
  }

  /** The list of this task's live sites, each with a way to take it down. */
  function renderLivePublications() {
    const list = $('#pub-live');
    const entries = tasks.publications();

    $('#pub-live-wrap').hidden = entries.length === 0;
    list.innerHTML = '';

    for (const entry of entries) {
      list.appendChild(publicationRow(entry, (err) => {
        const result = $('#pub-result');
        result.hidden = false;
        result.textContent = err.message;
      }));
    }
  }

  /* -------------------------------------------------------------- my sites */

  $('#btn-sites').addEventListener('click', async () => {
    const list = $('#sites-list');
    const status = $('#sites-status');
    list.innerHTML = '';
    status.hidden = false;
    status.textContent = 'Loading…';
    $('#dlg-sites').showModal();

    try {
      const rows = await supa.listPublications({ settings: getSettings(), session: auth.session });
      if (!rows.length) {
        status.textContent = 'Nothing published yet.';
        return;
      }
      status.hidden = true;
      for (const row of rows) {
        list.appendChild(publicationRow(row, (err) => {
          status.hidden = false;
          status.textContent = err.message;
        }));
      }
    } catch (err) {
      status.textContent = err.message;
      ui.log(err.message, 'c-err');
    }
  });

  $('#dlg-publish').addEventListener('close', async (ev) => {
    if (ev.target.returnValue !== 'publish') return;

    // Snapshot before publishing: these are the ones being replaced.
    const replacing = $('#pub-replace').checked && !$('#pub-replace-wrap').hidden
      ? tasks.publications()
      : [];

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

      // Only after the new one is confirmed up — a failed publish must not
      // leave the task with nothing live.
      for (const old of replacing) {
        try {
          await supa.unpublish({ settings: getSettings(), session: auth.session, slug: old.slug });
          tasks.removePublication(old.slug);
          ui.log(`replaced: took down ${old.url}`, 'c-ok');
        } catch (err) {
          ui.log(`could not take down ${old.url}: ${err.message}`, 'c-err');
        }
      }
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

  $('#set-account').innerHTML =
    `<dt>Email</dt><dd>${escapeHtml(auth.email || 'not signed in')}</dd>` +
    `<dt>Owner ID</dt><dd class="pick">${escapeHtml(auth.user?.id || '—')}</dd>` +
    `<dt>Database</dt><dd>${escapeHtml(hostOf(s.supabaseUrl))}</dd>`;

  // The lineup is shown, not offered — it is what CodeFort is.
  $('#set-models').innerHTML = AGENTS.map((a) =>
    `<dt>${escapeHtml(a.name)}</dt><dd>${escapeHtml(s.models[a.modelKey])}</dd>`
  ).join('');

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
  tasks.addPublication(info);
}

function replayStream(ui) {
  ui.clearStream();
  for (const entry of bus.entries) ui.renderEntry(entry);
}

/**
 * Promise-based replacement for window.prompt, using the shared dialog.
 * Answers are normalised as workspace paths unless `raw` is set — a task name
 * is prose, not a path.
 */
function askFor(title, label, placeholder = '', { raw = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    const input = $('#prompt-input');
    input.value = raw ? placeholder : '';
    input.placeholder = placeholder;

    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue !== 'ok') return resolve(null);
      const value = input.value.trim();
      if (raw) return resolve(value);
      resolve(value ? normalize(value) : null);
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

/** Just the host, so the Settings row stays readable on a phone. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || 'not configured';
  }
}
