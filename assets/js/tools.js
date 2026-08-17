/**
 * tools.js — the hands of the fort.
 *
 * Tool schemas in OpenAI/Mistral function-calling shape, plus the dispatcher
 * that actually performs each call against the workspace, the shell and
 * Pyodide. Every handler returns a plain string, which is what goes back to
 * the model as the tool message and into the shared stream for the others.
 */

import { vfs, normalize } from './vfs.js';
import { Shell } from './shell.js';
import * as py from './python.js';
import * as supa from './supabase.js';

const RESULT_LIMIT = 6000;

/* ------------------------------------------------------------- definitions */

const def = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
});

export const TOOL_DEFS = [
  def('think', 'Post a short note to the shared stream so the other two models can read your reasoning. Use it for decisions, assumptions and hand-offs — not for narrating every keystroke.', {
    note: { type: 'string', description: 'One or two sentences.' }
  }, ['note']),

  def('list_files', 'List the workspace as a tree.', {
    path: { type: 'string', description: 'Directory to list. Defaults to /.' }
  }),

  def('read_file', 'Read a file from the workspace.', {
    path: { type: 'string', description: 'Absolute path, e.g. /index.html' }
  }, ['path']),

  def('write_file', 'Create a file, or replace an existing file ENTIRELY. Parent folders are created automatically.', {
    path: { type: 'string', description: 'Absolute path, e.g. /assets/app.js' },
    content: { type: 'string', description: 'The complete new contents of the file.' }
  }, ['path', 'content']),

  def('edit_file', 'Replace an exact snippet inside a file. Cheaper and safer than rewriting a large file.', {
    path: { type: 'string' },
    find: { type: 'string', description: 'Exact text to find. Must be unique unless all=true.' },
    replace: { type: 'string', description: 'Text to put in its place.' },
    all: { type: 'boolean', description: 'Replace every occurrence. Default false.' }
  }, ['path', 'find', 'replace']),

  def('create_folder', 'Create a folder (and any missing parents).', {
    path: { type: 'string' }
  }, ['path']),

  def('delete_path', 'Delete a file, or a folder and everything inside it.', {
    path: { type: 'string' }
  }, ['path']),

  def('move_path', 'Move or rename a file or folder.', {
    from: { type: 'string' },
    to: { type: 'string' }
  }, ['from', 'to']),

  def('run_shell', 'Run a shell command over the workspace. Supports pipes, > and >> redirects, && and ||, and: ls cat echo mkdir touch rm cp mv head tail wc grep find tree sed sort uniq which env date python.', {
    command: { type: 'string', description: 'e.g. grep -rn "TODO" /  |  wc -l' }
  }, ['command']),

  def('run_python', 'Run Python 3 (Pyodide). The workspace is mounted at /work and is the working directory; files you write there are synced back. The standard library is available; third-party packages generally are not.', {
    code: { type: 'string', description: 'Python source to execute.' }
  }, ['code']),

  def('publish_site', 'Publish the current workspace to a public URL under a name of your choosing. Call this once, after the work is verified.', {
    name: { type: 'string', description: 'The name to publish under — yours, or one the task specified.' },
    title: { type: 'string', description: 'Short title of the site.' },
    description: { type: 'string', description: 'One-line description.' }
  }, ['name']),

  def('end_turn', 'End your turn and hand off to the next agent. Required exactly once per turn.', {
    summary: { type: 'string', description: 'What you did this turn, in one or two sentences.' },
    done: { type: 'boolean', description: 'true only if the whole task is finished and verified. The run ends when all three agents vote true in the same round.' },
    reason: { type: 'string', description: 'Why it is done, or what still remains.' }
  }, ['summary', 'done', 'reason'])
];

/* -------------------------------------------------------------- dispatcher */

export class Toolbox {
  /**
   * @param {object} ctx
   * @param {() => object} ctx.getSettings
   * @param {() => object|null} [ctx.getSession]  the signed-in account
   * @param {(line: string, cls?: string) => void} ctx.log  console sink
   * @param {(info: object) => void} [ctx.onPublish]
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.shell = new Shell({
      runPython: async (code, opts) => py.run(code, { ...opts, onProgress: (m) => ctx.log(m) })
    });
    this.published = null;
  }

  has(name) { return typeof this[`tool_${name}`] === 'function'; }

  /**
   * @returns {Promise<{ok: boolean, text: string, control?: object}>}
   * `control` carries out-of-band signals (currently end_turn's verdict).
   */
  async call(name, args, agent) {
    const fn = this[`tool_${name}`];
    if (!fn) return { ok: false, text: `unknown tool: ${name}` };
    try {
      const out = await fn.call(this, args || {}, agent);
      if (typeof out === 'object' && out !== null) {
        return { ok: out.ok !== false, text: clip(out.text ?? ''), control: out.control };
      }
      return { ok: true, text: clip(String(out ?? 'ok')) };
    } catch (err) {
      return { ok: false, text: `error: ${err.message}` };
    }
  }

  // ------------------------------------------------------------- workspace

  tool_think({ note }) {
    return { ok: true, text: 'noted', control: { thought: String(note || '').trim() } };
  }

  tool_list_files({ path = '/' }) {
    const p = normalize(path);
    if (!vfs.isDir(p)) throw new Error(`not a directory: ${p}`);
    const tree = vfs.tree(p);
    const { files, dirs, bytes } = vfs.stats();
    return `${p}\n${tree}\n(${files} files, ${dirs} folders, ${bytes} bytes)`;
  }

  tool_read_file({ path }) {
    const text = vfs.read(path);
    if (!text) return `${normalize(path)} is empty`;
    const lines = text.split('\n');
    const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
    return `${normalize(path)} (${lines.length} lines)\n${numbered}`;
  }

  tool_write_file({ path, content }) {
    if (content == null) throw new Error('content is required (pass "" for an empty file)');
    const existed = vfs.isFile(path);
    const p = vfs.write(path, content);
    const lines = String(content).split('\n').length;
    return `${existed ? 'rewrote' : 'created'} ${p} (${lines} lines, ${String(content).length} bytes)`;
  }

  tool_edit_file({ path, find, replace, all = false }) {
    const n = vfs.edit(path, find, replace ?? '', all);
    return `edited ${normalize(path)} — ${n} replacement${n === 1 ? '' : 's'}`;
  }

  tool_create_folder({ path }) {
    return `created folder ${vfs.mkdir(path)}`;
  }

  tool_delete_path({ path }) {
    const n = vfs.remove(path, true);
    return `deleted ${normalize(path)} (${n} entr${n === 1 ? 'y' : 'ies'})`;
  }

  tool_move_path({ from, to }) {
    return `moved ${normalize(from)} -> ${vfs.move(from, to)}`;
  }

  // ---------------------------------------------------------- code running

  async tool_run_shell({ command }) {
    if (!command || !String(command).trim()) throw new Error('command is required');
    this.ctx.log(`$ ${command}`, 'c-cmd');

    const r = await this.shell.run(command);
    if (r.stdout) this.ctx.log(r.stdout.replace(/\n$/, ''));
    if (r.stderr) this.ctx.log(r.stderr.replace(/\n$/, ''), 'c-err');

    const body = [
      r.stdout && r.stdout.trim() ? r.stdout.replace(/\n$/, '') : '',
      r.stderr && r.stderr.trim() ? `stderr:\n${r.stderr.replace(/\n$/, '')}` : ''
    ].filter(Boolean).join('\n');

    return {
      ok: r.code === 0,
      text: `exit ${r.code} (cwd ${this.shell.cwd})\n${body || '(no output)'}`
    };
  }

  async tool_run_python({ code }) {
    if (!code || !String(code).trim()) throw new Error('code is required');
    this.ctx.log('$ python', 'c-cmd');

    const r = await py.run(code, { onProgress: (m) => this.ctx.log(m) });
    if (r.stdout) this.ctx.log(r.stdout.replace(/\n$/, ''));
    if (r.stderr) this.ctx.log(r.stderr.replace(/\n$/, ''), 'c-err');

    const parts = [`${r.ok ? 'ran' : 'raised'} in ${r.elapsedMs}ms`];
    if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.replace(/\n$/, '')}`);
    if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.replace(/\n$/, '')}`);
    if (r.changed.length) parts.push(`workspace changed: ${r.changed.join(', ')}`);
    if (!r.stdout.trim() && !r.stderr.trim() && !r.changed.length) parts.push('(no output, no file changes)');

    return { ok: r.ok, text: parts.join('\n') };
  }

  // -------------------------------------------------------------- publish

  async tool_publish_site({ name, title, description }, agent) {
    const settings = this.ctx.getSettings();
    const files = vfs.snapshot();

    const result = await supa.publish({
      settings,
      session: this.ctx.getSession?.(),
      files,
      name: name || agent?.name || 'CodeFort',
      title,
      description
    });

    this.published = { ...result, name: name || agent?.name, title, description, at: Date.now() };
    this.ctx.onPublish?.(this.published);
    this.ctx.log(`published -> ${result.url}`, 'c-ok');

    return `published under "${name}" at ${result.url} (id: ${result.slug}). Anyone with that link sees this workspace.`;
  }

  // ------------------------------------------------------------- hand-off

  tool_end_turn({ summary, done, reason }) {
    return {
      ok: true,
      text: `turn ended (done=${Boolean(done)})`,
      control: {
        endTurn: true,
        summary: String(summary || '').trim(),
        done: Boolean(done),
        reason: String(reason || '').trim()
      }
    };
  }
}

function clip(text) {
  const s = String(text);
  return s.length > RESULT_LIMIT
    ? s.slice(0, RESULT_LIMIT) + `\n…(result truncated at ${RESULT_LIMIT} chars)`
    : s;
}
