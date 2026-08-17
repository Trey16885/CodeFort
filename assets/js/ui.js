/**
 * ui.js — everything that touches the DOM.
 *
 * Keeps rendering (tree, stream, console, editor, preview, roster) away from
 * the agent logic so the orchestrator only ever emits events.
 */

import { AGENTS } from './agents.js';
import { KIND } from './thoughts.js';
import { vfs, normalize } from './vfs.js';
import { bundleToHtml } from './supabase.js';

export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = { html: '◧', css: '◔', js: '◈', json: '❏', md: '✎', py: '✦', sh: '❯', txt: '·' };

function iconFor(name) {
  return ICONS[name.split('.').pop().toLowerCase()] || '·';
}

export class UI {
  constructor() {
    this.selected = null;
    this.dirty = false;
    this.streamFilters = { tools: true, thoughts: true };
    this.lastRound = 0;

    this.el = {
      roster: $('#roster'),
      tree: $('#tree'),
      fsStats: $('#fs-stats'),
      stream: $('#stream'),
      console: $('#console'),
      editor: $('#editor'),
      editorPath: $('#editor-path'),
      save: $('#btn-save'),
      preview: $('#preview'),
      runState: $('#run-state'),
      statusRound: $('#status-round'),
      statusAgent: $('#status-agent'),
      statusTokens: $('#status-tokens'),
      keyState: $('#key-state'),
      run: $('#btn-run'),
      stop: $('#btn-stop')
    };
  }

  /* ------------------------------------------------------------- roster */

  renderRoster(settings, { activeId = null, verdicts = new Map() } = {}) {
    this.el.roster.innerHTML = '';
    for (const agent of AGENTS) {
      const chip = document.createElement('div');
      chip.className = 'agent-chip' + (agent.id === activeId ? ' active' : '');
      chip.style.setProperty('--role-color', agent.color);
      chip.title = agent.blurb;

      const v = verdicts.get(agent.id);
      const voteText = v ? (v.done ? '✓ done' : '… working') : '—';

      chip.innerHTML = `
        <span class="dot"></span>
        <span class="who">${esc(agent.name)}</span>
        <span class="msg-model">${esc(settings.models[agent.modelKey] || '')}</span>
        <span class="vote${v?.done ? ' done' : ''}">${esc(voteText)}</span>`;
      this.el.roster.appendChild(chip);
    }
  }

  /* --------------------------------------------------------------- tree */

  renderTree(onOpen, onDelete) {
    const root = this.el.tree;
    root.innerHTML = '';

    const build = (dir, depth) => {
      for (const entry of vfs.list(dir)) {
        const row = document.createElement('div');
        row.className = 'node' + (entry.type === 'dir' ? ' dir' : '') +
          (entry.path === this.selected ? ' selected' : '');
        row.style.paddingLeft = `${8 + depth * 13}px`;
        row.dataset.path = entry.path;
        row.setAttribute('role', 'treeitem');

        const glyph = entry.type === 'dir' ? '▾' : iconFor(entry.name);
        row.innerHTML = `<span class="glyph">${glyph}</span><span class="name"></span>` +
          `<button class="kill" title="Delete" type="button">✕</button>`;
        row.querySelector('.name').textContent = entry.name;

        row.addEventListener('click', (e) => {
          if (e.target.closest('.kill')) return;
          if (entry.type === 'file') onOpen(entry.path);
        });
        row.querySelector('.kill').addEventListener('click', (e) => {
          e.stopPropagation();
          onDelete(entry.path);
        });

        root.appendChild(row);
        if (entry.type === 'dir') build(entry.path, depth + 1);
      }
    };

    build('/', 0);

    if (!root.children.length) {
      root.innerHTML = '<div class="tree-empty">Empty. The agents will fill this in — or add a file yourself.</div>';
    }

    const { files, dirs, bytes } = vfs.stats();
    this.el.fsStats.textContent = files || dirs
      ? `${files} file${files === 1 ? '' : 's'}, ${dirs} folder${dirs === 1 ? '' : 's'}, ${fmtBytes(bytes)}`
      : 'empty';
  }

  flashNode(path) {
    const row = this.el.tree.querySelector(`[data-path="${cssEscape(path)}"]`);
    if (!row) return;
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  }

  /* ------------------------------------------------------------- editor */

  openFile(path) {
    const p = normalize(path);
    if (!vfs.isFile(p)) return;
    this.selected = p;
    this.el.editor.value = vfs.read(p);
    this.el.editorPath.textContent = p;
    this.el.editorPath.classList.remove('muted');
    this.setDirty(false);
    this.el.save.disabled = true;
  }

  /** Refresh the open buffer when an agent rewrites the same file. */
  syncOpenFile() {
    if (!this.selected) return;
    if (!vfs.isFile(this.selected)) {
      this.selected = null;
      this.el.editor.value = '';
      this.el.editorPath.textContent = 'no file selected';
      this.el.editorPath.classList.add('muted');
      this.el.save.disabled = true;
      return;
    }
    if (this.dirty) return; // never clobber unsaved human edits
    const text = vfs.read(this.selected);
    if (text !== this.el.editor.value) this.el.editor.value = text;
  }

  setDirty(dirty) {
    this.dirty = dirty;
    this.el.save.disabled = !dirty;
    if (this.selected) {
      this.el.editorPath.textContent = this.selected + (dirty ? ' •' : '');
    }
  }

  /* ------------------------------------------------------------ preview */

  renderPreview() {
    const files = vfs.snapshot();
    if (!Object.keys(files).length) {
      this.el.preview.srcdoc = emptyPreview('The workspace is empty.');
      return;
    }
    try {
      this.el.preview.srcdoc = bundleToHtml(files, '/index.html');
    } catch (err) {
      this.el.preview.srcdoc = emptyPreview(`Preview failed: ${esc(err.message)}`);
    }
  }

  /* ------------------------------------------------------------- stream */

  renderEntry(entry) {
    if (entry.kind === KIND.TOOL_CALL || entry.kind === KIND.TOOL_RESULT) {
      if (!this.streamFilters.tools) return;
    }
    if (entry.kind === KIND.THOUGHT && !this.streamFilters.thoughts) return;

    const stream = this.el.stream;
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;

    if (entry.round && entry.round !== this.lastRound) {
      this.lastRound = entry.round;
      const rule = document.createElement('div');
      rule.className = 'round-rule';
      rule.textContent = `round ${entry.round}`;
      stream.appendChild(rule);
    }

    const node = this.#buildEntry(entry);
    if (node) stream.appendChild(node);
    if (nearBottom) stream.scrollTop = stream.scrollHeight;
  }

  #buildEntry(entry) {
    const agent = AGENTS.find((a) => a.id === entry.agent);
    const div = document.createElement('div');
    div.className = 'msg';
    if (agent) div.style.setProperty('--role-color', agent.color);

    const head = (tag) => `
      <div class="msg-head">
        <span class="msg-who">${esc(entry.who)}</span>
        ${entry.model ? `<span class="msg-model">${esc(entry.model)}</span>` : ''}
        <span class="msg-tag">${esc(tag)}</span>
      </div>`;

    switch (entry.kind) {
      case KIND.TASK:
        div.className += ' system';
        div.innerHTML = head('task') + `<div class="msg-text"></div>`;
        div.querySelector('.msg-text').textContent = entry.text;
        return div;

      case KIND.SYSTEM:
        if (/^— round/.test(entry.text)) return null; // the rule already says it
        div.className += ' system';
        div.innerHTML = `<div class="msg-text"></div>`;
        div.querySelector('.msg-text').textContent = entry.text;
        return div;

      case KIND.ERROR:
        div.className += ' error';
        div.innerHTML = head('error') + `<div class="msg-text"></div>`;
        div.querySelector('.msg-text').textContent = entry.text;
        return div;

      case KIND.THOUGHT:
        div.className += ' thought';
        div.innerHTML = head('thinking') + `<div class="msg-text"></div>`;
        div.querySelector('.msg-text').textContent = entry.text;
        return div;

      case KIND.TOOL_CALL: {
        div.className += ' tool';
        div.innerHTML = head('tool') +
          `<div class="tool-line"><span class="tool-name">${esc(entry.tool)}</span><span class="tool-args"></span></div>`;
        div.querySelector('.tool-args').textContent = summarizeArgs(entry.tool, entry.args);
        return div;
      }

      case KIND.TOOL_RESULT: {
        div.className += ' tool';
        div.innerHTML = head(entry.ok ? 'result' : 'failed') +
          `<pre class="tool-out${entry.ok ? '' : ' err'}"></pre>`;
        div.querySelector('.tool-out').textContent = entry.result;
        return div;
      }

      case KIND.VERDICT: {
        const done = entry.text.startsWith('DONE');
        div.innerHTML = head('verdict') +
          `<div class="verdict ${done ? 'done' : 'more'}"></div>`;
        div.querySelector('.verdict').textContent = entry.text;
        return div;
      }

      default:
        div.className += ' system';
        div.innerHTML = `<div class="msg-text"></div>`;
        div.querySelector('.msg-text').textContent = entry.text;
        return div;
    }
  }

  clearStream() {
    this.el.stream.innerHTML = '';
    this.lastRound = 0;
  }

  /* ------------------------------------------------------------ console */

  log(text, cls = '') {
    const line = document.createElement('span');
    if (cls) line.className = cls;
    line.textContent = String(text) + '\n';
    this.el.console.appendChild(line);
    this.el.console.scrollTop = this.el.console.scrollHeight;
  }

  clearConsole() { this.el.console.innerHTML = ''; }

  /* ------------------------------------------------------------- status */

  /** Say why a click did nothing, in the one spot next to the button. */
  hint(message) {
    clearTimeout(this._hintTimer);
    this.el.runState.textContent = message;
    this.el.runState.classList.add('hint');
    this._hintTimer = setTimeout(() => {
      this.el.runState.classList.remove('hint');
      this.el.runState.textContent = 'idle';
    }, 4000);
  }

  setRunning(running) {
    clearTimeout(this._hintTimer);
    this.el.runState.classList.remove('hint');
    this.el.run.disabled = running;
    this.el.stop.disabled = !running;
    this.el.run.textContent = running ? 'Working…' : 'Start the fort';
    this.el.runState.textContent = running ? 'running' : 'idle';
  }

  setStatus({ round, agent, tokens }) {
    if (round !== undefined) this.el.statusRound.textContent = `round ${round}`;
    if (agent !== undefined) this.el.statusAgent.textContent = agent || '—';
    if (tokens !== undefined) this.el.statusTokens.textContent = `${tokens.toLocaleString()} tokens`;
  }

  setKeyState(hasKey, source) {
    this.el.keyState.textContent = hasKey ? `key: ${source}` : 'no key';
    this.el.keyState.className = 'pill ' + (hasKey ? 'ok' : 'warn');
    this.el.keyState.title = hasKey
      ? source === 'deploy' ? 'Key baked in at deploy time' : 'Key stored in this browser'
      : 'Add a Mistral API key under Settings';
  }
}

/* -------------------------------------------------------------- helpers */

function summarizeArgs(tool, args = {}) {
  if (!args) return '';
  switch (tool) {
    case 'write_file': return `${args.path} (${String(args.content ?? '').length} bytes)`;
    case 'edit_file': return `${args.path}: ${clip(args.find, 40)} → ${clip(args.replace, 40)}`;
    case 'run_shell': return clip(args.command, 160);
    case 'run_python': return clip(args.code, 160);
    case 'publish_site': return `as “${args.name}”`;
    default:
      return Object.entries(args).map(([k, v]) => `${k}=${clip(v, 60)}`).join('  ');
  }
}

function clip(v, n) {
  const s = (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function emptyPreview(message) {
  return `<!doctype html><meta charset="utf-8">
<body style="margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui;background:#11151f;color:#8c97ad">
${message}</body>`;
}
