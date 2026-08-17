/**
 * tasks.js — many tasks, one fort.
 *
 * A task is a named brief plus its own workspace. Switching tasks swaps the
 * whole VFS: the outgoing workspace is snapshotted into storage, the incoming
 * one is restored over it. The agents never know — they always see whatever
 * the VFS currently holds.
 *
 * This module owns persistence. The VFS itself is deliberately memory-only so
 * there is exactly one writer and no chance of a snapshot landing under the
 * wrong task.
 */

import { vfs } from './vfs.js';

const LS_KEY = 'codefort.tasks.v1';
const LEGACY_WORKSPACE_KEY = 'codefort.workspace.v1';
const MAX_TASKS = 40;
const SAVE_DEBOUNCE_MS = 400;

const newId = () =>
  't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/**
 * Bring a stored task up to the current shape. Builds before unpublish kept a
 * single `published` object; that becomes the first entry of `publications` so
 * an already-live site can still be taken down.
 */
function migrate(task) {
  if (!Array.isArray(task.publications)) {
    task.publications = task.published?.slug ? [{ ...task.published }] : [];
  }
  delete task.published;
  return task;
}

/** A brief like "build a pomodoro timer" becomes the name "Build a pomodoro timer". */
export function nameFromBrief(brief, fallback = 'Untitled task') {
  const flat = String(brief || '').replace(/\s+/g, ' ').trim();
  if (!flat) return fallback;
  const cut = flat.length > 42 ? flat.slice(0, 42).replace(/\s\S*$/, '') + '…' : flat;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

export class TaskStore extends EventTarget {
  constructor() {
    super();
    /** @type {Array<object>} */
    this.tasks = [];
    this.activeId = null;
    this._saveTimer = null;
    this.quotaHit = false;

    // Whatever the workspace does, the active task owns it.
    vfs.addEventListener('change', () => this.#scheduleSave());
  }

  /* ---------------------------------------------------------------- state */

  get active() {
    return this.tasks.find((t) => t.id === this.activeId) || null;
  }

  /** Newest activity first — the order the list is drawn in. */
  list() {
    return [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { tasks: this.list(), activeId: this.activeId }
    }));
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Load from storage, migrating a single pre-tasks workspace if one is there.
   * Always ends with exactly one active task.
   */
  hydrate() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch {
      saved = null;
    }

    if (saved?.tasks?.length) {
      this.tasks = saved.tasks.filter((t) => t && t.id).map(migrate);
      this.activeId = this.tasks.some((t) => t.id === saved.activeId)
        ? saved.activeId
        : this.tasks[0].id;
    } else {
      const migrated = this.#migrateLegacyWorkspace();
      this.tasks = [migrated];
      this.activeId = migrated.id;
    }

    vfs.restore(this.active.files || {});
    this.#emit();
    return this.active;
  }

  /** The build before tasks existed kept one workspace under its own key. */
  #migrateLegacyWorkspace() {
    let files = {};
    try {
      files = JSON.parse(localStorage.getItem(LEGACY_WORKSPACE_KEY) || '{}') || {};
    } catch {
      files = {};
    }
    const hadWork = Object.keys(files).length > 0;
    if (hadWork) {
      try { localStorage.removeItem(LEGACY_WORKSPACE_KEY); } catch { /* ignore */ }
    }
    return this.#blank(hadWork ? 'Imported workspace' : 'First task', files);
  }

  #blank(name, files = {}) {
    const now = Date.now();
    return {
      id: newId(),
      name,
      brief: '',
      files,
      publications: [],
      createdAt: now,
      updatedAt: now
    };
  }

  /* -------------------------------------------------------------- actions */

  /** Create a task and switch to it. Its workspace starts empty. */
  create(name = 'New task') {
    if (this.tasks.length >= MAX_TASKS) {
      throw new Error(`That is ${MAX_TASKS} tasks — delete one before starting another.`);
    }
    this.#captureActive();

    const task = this.#blank(String(name).trim() || 'New task');
    this.tasks.push(task);
    this.activeId = task.id;

    vfs.restore({});
    this.#save();
    this.#emit();
    return task;
  }

  /** Make `id` the active task, swapping the workspace under it. */
  switchTo(id) {
    if (id === this.activeId) return this.active;
    const next = this.tasks.find((t) => t.id === id);
    if (!next) throw new Error('no such task');

    this.#captureActive();
    this.activeId = id;

    vfs.restore(next.files || {});
    this.#save();
    this.#emit();
    return next;
  }

  rename(id, name) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error('no such task');
    task.name = String(name).trim().slice(0, 80) || task.name;
    task.updatedAt = Date.now();
    this.#save();
    this.#emit();
    return task;
  }

  /**
   * Delete a task. Deleting the last one leaves a fresh empty task rather than
   * no task at all, so the studio always has somewhere to put files.
   */
  remove(id) {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) throw new Error('no such task');

    this.tasks.splice(index, 1);

    if (!this.tasks.length) {
      const fresh = this.#blank('First task');
      this.tasks.push(fresh);
      this.activeId = fresh.id;
      vfs.restore({});
    } else if (id === this.activeId) {
      const next = this.list()[0];
      this.activeId = next.id;
      vfs.restore(next.files || {});
    }

    this.#save();
    this.#emit();
    return this.active;
  }

  /** Remember the brief the user typed, so switching back restores it. */
  setBrief(brief, { rename = false } = {}) {
    const task = this.active;
    if (!task) return;

    task.brief = String(brief || '');
    // A task still called "New task" takes its name from the first real brief.
    if (rename && task.brief.trim() && /^(new task|first task|untitled task)$/i.test(task.name)) {
      task.name = nameFromBrief(task.brief, task.name);
    }
    task.updatedAt = Date.now();
    this.#save();
    this.#emit();
  }

  /**
   * Record a publication. Each publish mints a fresh slug, so a task can own
   * several live sites; keeping them all is what makes unpublishing possible
   * for anything but the most recent one.
   */
  addPublication(info) {
    const task = this.active;
    if (!task || !info?.slug) return null;

    const entry = {
      slug: info.slug,
      url: info.url,
      name: info.name || null,
      title: info.title || null,
      at: Date.now()
    };
    task.publications = [entry, ...(task.publications || []).filter((p) => p.slug !== entry.slug)];
    task.updatedAt = Date.now();
    this.#save();
    this.#emit();
    return entry;
  }

  /** Forget a publication locally. The server-side delete is supabase.unpublish. */
  removePublication(slug) {
    let found = null;
    for (const task of this.tasks) {
      const before = task.publications || [];
      const after = before.filter((p) => p.slug !== slug);
      if (after.length === before.length) continue;
      found = task;
      task.publications = after;
      task.updatedAt = Date.now();
    }
    if (found) {
      this.#save();
      this.#emit();
    }
    return found;
  }

  /** Publications of the active task, newest first. */
  publications() {
    return [...(this.active?.publications || [])];
  }

  /* ---------------------------------------------------------- persistence */

  #captureActive() {
    clearTimeout(this._saveTimer);   // a pending save is about to be superseded
    const task = this.active;
    if (!task) return;
    task.files = vfs.snapshot();
    task.updatedAt = Date.now();
  }

  #scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.#captureActive();
      this.#save();
      this.#emit();
    }, SAVE_DEBOUNCE_MS);
  }

  #save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ tasks: this.tasks, activeId: this.activeId }));
      this.quotaHit = false;
    } catch (err) {
      // Out of localStorage. The in-memory workspace still works; say so once.
      if (!this.quotaHit) {
        this.quotaHit = true;
        this.dispatchEvent(new CustomEvent('quota', { detail: { error: err } }));
      }
    }
  }

  /** Total bytes across every task's files — shown so a full store isn't a surprise. */
  usage() {
    let bytes = 0;
    for (const task of this.tasks) {
      for (const content of Object.values(task.files || {})) {
        if (typeof content === 'string') bytes += content.length;
      }
    }
    return bytes;
  }
}

export const tasks = new TaskStore();
