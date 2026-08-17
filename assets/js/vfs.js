/**
 * vfs.js — the workspace the agents build in.
 *
 * A flat map of absolute path -> node. Directories are stored explicitly so
 * an empty folder is a real thing the agents can create.
 *
 * This is memory-only. Persistence belongs to tasks.js, which snapshots the
 * VFS into whichever task is active — one writer, so a snapshot can never
 * land under the wrong task.
 */

const TEXT_LIMIT = 512 * 1024; // per-file guard, keeps localStorage sane

/** Collapse `a//b`, `./`, `../` and leading/trailing slashes into `/a/b`. */
export function normalize(path) {
  const raw = String(path ?? '').trim();
  const parts = raw.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

export function dirname(path) {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(path) {
  const p = normalize(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

export function join(...parts) {
  return normalize(parts.join('/'));
}

export class VFS extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, {type:'file'|'dir', content?:string, mtime:number}>} */
    this.nodes = new Map();
    this.nodes.set('/', { type: 'dir', mtime: Date.now() });
  }

  // ---------------------------------------------------------------- events

  #changed(action, path, extra = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { action, path, ...extra } }));
  }

  // ---------------------------------------------------------------- queries

  exists(path) { return this.nodes.has(normalize(path)); }

  isDir(path) { return this.nodes.get(normalize(path))?.type === 'dir'; }

  isFile(path) { return this.nodes.get(normalize(path))?.type === 'file'; }

  read(path) {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new Error(`no such file: ${p}`);
    if (node.type === 'dir') throw new Error(`${p} is a directory`);
    return node.content;
  }

  /** All file paths, sorted. */
  files() {
    return [...this.nodes.entries()]
      .filter(([, n]) => n.type === 'file')
      .map(([p]) => p)
      .sort();
  }

  /** Immediate children of a directory, dirs first. */
  list(path = '/') {
    const dir = normalize(path);
    if (!this.isDir(dir)) throw new Error(`not a directory: ${dir}`);
    const prefix = dir === '/' ? '/' : dir + '/';
    const out = [];
    for (const [p, node] of this.nodes) {
      if (p === dir || !p.startsWith(prefix)) continue;
      if (p.slice(prefix.length).includes('/')) continue;
      out.push({ path: p, name: basename(p), type: node.type, size: node.content?.length ?? 0 });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return out;
  }

  /** Whole tree as an indented string — what the models see each turn. */
  tree(path = '/', indent = '') {
    const entries = this.list(path);
    if (!entries.length && indent === '') return '(workspace is empty)';
    let out = '';
    for (const e of entries) {
      if (e.type === 'dir') {
        out += `${indent}${e.name}/\n` + this.tree(e.path, indent + '  ');
      } else {
        out += `${indent}${e.name}  (${e.size} bytes)\n`;
      }
    }
    return out;
  }

  stats() {
    let files = 0, dirs = 0, bytes = 0;
    for (const [p, n] of this.nodes) {
      if (p === '/') continue;
      if (n.type === 'dir') dirs++;
      else { files++; bytes += n.content.length; }
    }
    return { files, dirs, bytes };
  }

  // ---------------------------------------------------------------- mutation

  mkdir(path) {
    const p = normalize(path);
    if (p === '/') return p;
    const existing = this.nodes.get(p);
    if (existing) {
      if (existing.type === 'file') throw new Error(`${p} exists and is a file`);
      return p;
    }
    // materialise every missing ancestor
    const segs = p.slice(1).split('/');
    let cur = '';
    for (const seg of segs) {
      cur += '/' + seg;
      const node = this.nodes.get(cur);
      if (node?.type === 'file') throw new Error(`${cur} exists and is a file`);
      if (!node) this.nodes.set(cur, { type: 'dir', mtime: Date.now() });
    }
    this.#changed('mkdir', p);
    return p;
  }

  write(path, content) {
    const p = normalize(path);
    if (p === '/') throw new Error('cannot write to /');
    const text = content == null ? '' : String(content);
    if (text.length > TEXT_LIMIT) throw new Error(`file too large (${text.length} bytes, limit ${TEXT_LIMIT})`);
    if (this.nodes.get(p)?.type === 'dir') throw new Error(`${p} is a directory`);

    const parent = dirname(p);
    if (parent !== '/' && !this.exists(parent)) this.mkdir(parent);

    const isNew = !this.nodes.has(p);
    this.nodes.set(p, { type: 'file', content: text, mtime: Date.now() });
    this.#changed(isNew ? 'create' : 'write', p);
    return p;
  }

  /** Literal find/replace inside a file. Returns the number of hits. */
  edit(path, find, replace, all = false) {
    const p = normalize(path);
    const text = this.read(p);
    if (find === '') throw new Error('`find` must not be empty');
    const count = text.split(find).length - 1;
    if (count === 0) throw new Error(`\`find\` text not present in ${p}`);
    if (count > 1 && !all) {
      throw new Error(`\`find\` matches ${count} times in ${p} — pass all=true or use a longer, unique snippet`);
    }
    const next = all ? text.split(find).join(replace) : text.replace(find, replace);
    this.nodes.set(p, { type: 'file', content: next, mtime: Date.now() });
    this.#changed('write', p);
    return count;
  }

  remove(path, recursive = true) {
    const p = normalize(path);
    if (p === '/') throw new Error('refusing to delete /');
    if (!this.nodes.has(p)) throw new Error(`no such path: ${p}`);

    const victims = [p];
    if (this.isDir(p)) {
      const prefix = p + '/';
      const kids = [...this.nodes.keys()].filter((k) => k.startsWith(prefix));
      if (kids.length && !recursive) throw new Error(`${p} is not empty`);
      victims.push(...kids);
    }
    for (const v of victims) this.nodes.delete(v);
    this.#changed('delete', p, { count: victims.length });
    return victims.length;
  }

  move(from, to) {
    const src = normalize(from);
    const dst = normalize(to);
    if (!this.nodes.has(src)) throw new Error(`no such path: ${src}`);
    if (src === '/') throw new Error('refusing to move /');
    if (dst === src) return dst;
    if (dst.startsWith(src + '/')) throw new Error('cannot move a directory into itself');

    const parent = dirname(dst);
    if (parent !== '/' && !this.exists(parent)) this.mkdir(parent);

    const moves = [[src, dst]];
    if (this.isDir(src)) {
      for (const k of this.nodes.keys()) {
        if (k.startsWith(src + '/')) moves.push([k, dst + k.slice(src.length)]);
      }
    }
    for (const [a, b] of moves) {
      this.nodes.set(b, { ...this.nodes.get(a), mtime: Date.now() });
      this.nodes.delete(a);
    }
    this.#changed('move', dst, { from: src });
    return dst;
  }

  copy(from, to) {
    const src = normalize(from);
    if (this.isDir(src)) {
      const dst = this.mkdir(to);
      for (const k of [...this.nodes.keys()]) {
        if (k.startsWith(src + '/')) {
          const target = dst + k.slice(src.length);
          const n = this.nodes.get(k);
          if (n.type === 'dir') this.mkdir(target);
          else this.write(target, n.content);
        }
      }
      return dst;
    }
    return this.write(to, this.read(src));
  }

  // ---------------------------------------------------------------- bulk I/O

  /** Snapshot as a plain `{path: content}` object of files only. */
  snapshot() {
    const out = {};
    for (const [p, n] of this.nodes) {
      if (n.type === 'file') out[p] = n.content;
      else if (p !== '/' && !this.#hasDescendants(p)) out[p + '/'] = null; // keep empty dirs
    }
    return out;
  }

  #hasDescendants(dir) {
    const prefix = dir + '/';
    for (const k of this.nodes.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** Replace the whole workspace from a snapshot. */
  restore(snapshot) {
    this.nodes = new Map([['/', { type: 'dir', mtime: Date.now() }]]);
    for (const [p, content] of Object.entries(snapshot || {})) {
      if (content === null || p.endsWith('/')) this.mkdir(p);
      else this.write(p, content);
    }
    this.#changed('restore', '/');
  }

  clear() {
    this.nodes = new Map([['/', { type: 'dir', mtime: Date.now() }]]);
    this.#changed('clear', '/');
  }
}

export const vfs = new VFS();
