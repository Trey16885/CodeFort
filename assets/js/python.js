/**
 * python.js — real Python in the tab, via Pyodide.
 *
 * The workspace is copied into Pyodide's filesystem under /work before each
 * run and copied back afterwards, so a script that writes a file actually
 * creates it in the fort. Pyodide is ~10 MB, so it loads lazily on the first
 * run_python call and is reused for the rest of the session.
 */

import { vfs, dirname } from './vfs.js';

const PYODIDE_VERSION = '0.26.4';

/**
 * Where the runtime is fetched from. Set `window.__CODEFORT_PYODIDE_URL__` to
 * a directory holding pyodide.js and friends to self-host it instead — useful
 * behind a network that will not reach a public CDN.
 */
const CDN = (globalThis.__CODEFORT_PYODIDE_URL__ ||
  `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`).replace(/\/?$/, '/');

const MOUNT = '/work';
const MAX_OUTPUT = 20000;

let loading = null;
let pyodide = null;

export function isReady() { return !!pyodide; }

/** Load Pyodide once; concurrent callers share the same promise. */
export async function boot(onProgress = () => {}) {
  if (pyodide) return pyodide;
  if (loading) return loading;

  loading = (async () => {
    onProgress('downloading pyodide…');
    if (!globalThis.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = CDN + 'pyodide.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('could not load Pyodide from the CDN'));
        document.head.appendChild(s);
      });
    }
    onProgress('starting interpreter…');
    pyodide = await globalThis.loadPyodide({ indexURL: CDN });
    pyodide.FS.mkdirTree(MOUNT);
    onProgress('python ready');
    return pyodide;
  })();

  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

/* ------------------------------------------------------------- FS bridging */

function pushWorkspace(py) {
  // Wipe the mount so deleted files don't linger between runs.
  try {
    for (const name of py.FS.readdir(MOUNT)) {
      if (name === '.' || name === '..') continue;
      rmrf(py, `${MOUNT}/${name}`);
    }
  } catch { /* first run, nothing to clear */ }

  for (const path of vfs.files()) {
    const target = MOUNT + path;
    py.FS.mkdirTree(dirname(target));
    py.FS.writeFile(target, vfs.read(path), { encoding: 'utf8' });
  }
}

function rmrf(py, path) {
  const stat = py.FS.stat(path);
  if (py.FS.isDir(stat.mode)) {
    for (const name of py.FS.readdir(path)) {
      if (name === '.' || name === '..') continue;
      rmrf(py, `${path}/${name}`);
    }
    py.FS.rmdir(path);
  } else {
    py.FS.unlink(path);
  }
}

/** Copy /work back into the VFS; returns the paths that changed. */
function pullWorkspace(py) {
  const seen = new Set();
  const changed = [];

  const walk = (dir) => {
    for (const name of py.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      const stat = py.FS.stat(full);
      if (py.FS.isDir(stat.mode)) { walk(full); continue; }

      const rel = full.slice(MOUNT.length);
      seen.add(rel);
      let text;
      try {
        text = py.FS.readFile(full, { encoding: 'utf8' });
      } catch {
        continue; // binary output — not representable in the text workspace
      }
      if (!vfs.exists(rel) || vfs.read(rel) !== text) {
        vfs.write(rel, text);
        changed.push(rel);
      }
    }
  };
  walk(MOUNT);

  for (const path of vfs.files()) {
    if (!seen.has(path)) {
      vfs.remove(path);
      changed.push(path + ' (deleted)');
    }
  }
  return changed;
}

/* ---------------------------------------------------------------- running */

/**
 * Execute Python. Returns {ok, stdout, stderr, changed, elapsedMs}.
 * Never throws for user-code errors — the traceback comes back in stderr.
 */
export async function run(code, { onProgress = () => {}, stdin = '' } = {}) {
  const started = performance.now();
  let py;
  try {
    py = await boot(onProgress);
  } catch (err) {
    return { ok: false, stdout: '', stderr: `python runtime unavailable: ${err.message}`, changed: [], elapsedMs: 0 };
  }

  let out = '';
  let err = '';
  py.setStdout({ batched: (s) => { out += s + '\n'; } });
  py.setStderr({ batched: (s) => { err += s + '\n'; } });
  if (stdin) {
    let cursor = 0;
    const bytes = new TextEncoder().encode(stdin);
    py.setStdin({ stdin: () => (cursor < bytes.length ? bytes[cursor++] : null) });
  }

  pushWorkspace(py);

  let ok = true;
  try {
    await py.runPythonAsync(`import os, sys\nos.chdir(${JSON.stringify(MOUNT)})\nif ${JSON.stringify(MOUNT)} not in sys.path: sys.path.insert(0, ${JSON.stringify(MOUNT)})`);
    await py.runPythonAsync(code);
  } catch (e) {
    ok = false;
    err += String(e.message || e);
  }

  let changed = [];
  try {
    changed = pullWorkspace(py);
  } catch (e) {
    err += `\n(workspace sync failed: ${e.message})`;
  }

  py.setStdout({});
  py.setStderr({});

  return {
    ok,
    stdout: cap(out),
    stderr: cap(err),
    changed,
    elapsedMs: Math.round(performance.now() - started)
  };
}

function cap(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…(truncated at ${MAX_OUTPUT} chars)` : s;
}
