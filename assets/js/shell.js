/**
 * shell.js — a POSIX-flavoured shell over the virtual workspace.
 *
 * There is no real /bin in a browser tab, so this implements the commands
 * agents actually reach for, over the VFS: pipes, redirects, `&&`/`||`/`;`,
 * quoting, globs, and about two dozen builtins. `python`/`python3` are handed
 * off to the Pyodide runner so a shell line can drive real Python.
 */

import { vfs, normalize, dirname, basename, join } from './vfs.js';

const MAX_OUTPUT = 20000;

export class Shell {
  constructor({ runPython } = {}) {
    this.cwd = '/';
    this.env = { HOME: '/', PWD: '/', SHELL: 'codefort-sh', USER: 'codefort' };
    this.runPython = runPython; // async (code) => {stdout, stderr, ok}
  }

  /** Run one command line. Never throws; failures come back as stderr + code. */
  async run(line) {
    const out = { stdout: '', stderr: '', code: 0 };
    try {
      const chains = splitTop(String(line ?? ''), [';']);
      for (const chain of chains) {
        if (!chain.trim()) continue;
        const r = await this.#runChain(chain);
        out.stdout += r.stdout;
        out.stderr += r.stderr;
        out.code = r.code;
      }
    } catch (err) {
      out.stderr += `sh: ${err.message}\n`;
      out.code = 1;
    }
    out.stdout = cap(out.stdout);
    out.stderr = cap(out.stderr);
    this.env.PWD = this.cwd;
    return out;
  }

  // --------------------------------------------------------------- internals

  /** `a && b || c` */
  async #runChain(chain) {
    const parts = splitLogical(chain);
    let last = { stdout: '', stderr: '', code: 0 };
    const acc = { stdout: '', stderr: '', code: 0 };

    for (const { op, text } of parts) {
      if (op === '&&' && last.code !== 0) continue;
      if (op === '||' && last.code === 0) continue;
      last = await this.#runPipeline(text);
      acc.stdout += last.stdout;
      acc.stderr += last.stderr;
      acc.code = last.code;
    }
    return acc;
  }

  /** `a | b | c > file` */
  async #runPipeline(text) {
    const stages = splitTop(text, ['|']).map((s) => s.trim()).filter(Boolean);
    if (!stages.length) return { stdout: '', stderr: '', code: 0 };

    let stdin = '';
    let stderr = '';
    let code = 0;

    for (let i = 0; i < stages.length; i++) {
      const { argv, redirect } = parseRedirects(stages[i]);
      if (!argv.length) continue;

      const r = await this.#exec(argv, stdin);
      stderr += r.stderr || '';
      code = r.code ?? 0;
      stdin = r.stdout || '';

      if (redirect) {
        const target = this.#resolve(redirect.path);
        try {
          const prior = redirect.append && vfs.isFile(target) ? vfs.read(target) : '';
          vfs.write(target, prior + stdin);
          stdin = '';
        } catch (err) {
          stderr += `sh: ${redirect.path}: ${err.message}\n`;
          code = 1;
        }
      }
      if (code !== 0 && i < stages.length - 1) break;
    }
    return { stdout: stdin, stderr, code };
  }

  #resolve(p) {
    const s = String(p);
    return s.startsWith('/') ? normalize(s) : join(this.cwd, s);
  }

  /** Expand `*` / `?` globs against the workspace; unmatched patterns stay literal. */
  #glob(pattern) {
    if (!/[*?]/.test(pattern)) return [pattern];
    const abs = this.#resolve(pattern);
    const dir = dirname(abs);
    if (!vfs.isDir(dir)) return [pattern];
    const rx = new RegExp('^' + basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    const hits = vfs.list(dir).filter((e) => rx.test(e.name)).map((e) => e.path);
    return hits.length ? hits : [pattern];
  }

  /**
   * @param {Array<{value: string, quoted: boolean}>} words
   * Quoted words are passed through verbatim, the way a real shell suppresses
   * globbing inside quotes — `find -name "*.js"` must reach `find` intact.
   */
  async #exec(words, stdin) {
    const argv = words.flatMap((w, i) =>
      i === 0 || w.quoted ? [w.value] : this.#glob(w.value));
    const cmd = argv[0];
    const args = argv.slice(1);
    const fn = this.builtins[cmd];

    if (!fn) return { stdout: '', stderr: `sh: ${cmd}: command not found\n`, code: 127 };
    try {
      const r = await fn.call(this, args, stdin);
      return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.code ?? 0 };
    } catch (err) {
      return { stdout: '', stderr: `${cmd}: ${err.message}\n`, code: 1 };
    }
  }

  /** Read the operands of a file-taking command, or fall back to stdin. */
  #inputs(paths, stdin) {
    if (!paths.length) return [{ name: '-', text: stdin }];
    return paths.map((p) => {
      const abs = this.#resolve(p);
      if (!vfs.exists(abs)) throw new Error(`${p}: No such file or directory`);
      if (vfs.isDir(abs)) throw new Error(`${p}: Is a directory`);
      return { name: p, text: vfs.read(abs) };
    });
  }

  // --------------------------------------------------------------- builtins

  builtins = {
    pwd() { return { stdout: this.cwd + '\n' }; },

    cd(args) {
      const target = this.#resolve(args[0] || '/');
      if (!vfs.exists(target)) return { stderr: `cd: ${args[0]}: No such file or directory\n`, code: 1 };
      if (!vfs.isDir(target)) return { stderr: `cd: ${args[0]}: Not a directory\n`, code: 1 };
      this.cwd = target;
      return { stdout: '' };
    },

    ls(args) {
      const flags = args.filter((a) => a.startsWith('-')).join('');
      const paths = args.filter((a) => !a.startsWith('-'));
      const long = flags.includes('l');
      const all = flags.includes('a');
      const targets = paths.length ? paths : ['.'];
      let out = '';

      for (const p of targets) {
        const abs = this.#resolve(p);
        if (!vfs.exists(abs)) return { stderr: `ls: ${p}: No such file or directory\n`, code: 1 };
        if (targets.length > 1) out += `${p}:\n`;

        if (vfs.isFile(abs)) {
          out += long ? `-rw-r--r--  ${vfs.read(abs).length}\t${p}\n` : `${p}\n`;
          continue;
        }
        const entries = vfs.list(abs);
        if (all) out += './\n../\n';
        for (const e of entries) {
          const name = e.type === 'dir' ? e.name + '/' : e.name;
          out += long ? `${e.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--'}  ${e.size}\t${name}\n` : `${name}\n`;
        }
        if (targets.length > 1) out += '\n';
      }
      return { stdout: out };
    },

    tree(args) {
      const abs = this.#resolve(args[0] || '.');
      if (!vfs.isDir(abs)) return { stderr: `tree: ${args[0]}: Not a directory\n`, code: 1 };
      return { stdout: `${abs}\n` + vfs.tree(abs) };
    },

    cat(args, stdin) {
      const files = args.filter((a) => !a.startsWith('-'));
      return { stdout: this.#inputs(files, stdin).map((i) => i.text).join('') };
    },

    echo(args) {
      const noNewline = args[0] === '-n';
      const words = noNewline ? args.slice(1) : args;
      return { stdout: words.join(' ') + (noNewline ? '' : '\n') };
    },

    mkdir(args) {
      const paths = args.filter((a) => !a.startsWith('-'));
      if (!paths.length) return { stderr: 'mkdir: missing operand\n', code: 1 };
      for (const p of paths) vfs.mkdir(this.#resolve(p));
      return { stdout: '' };
    },

    touch(args) {
      for (const p of args.filter((a) => !a.startsWith('-'))) {
        const abs = this.#resolve(p);
        if (!vfs.exists(abs)) vfs.write(abs, '');
      }
      return { stdout: '' };
    },

    rm(args) {
      const flags = args.filter((a) => a.startsWith('-')).join('');
      const paths = args.filter((a) => !a.startsWith('-'));
      const recursive = flags.includes('r') || flags.includes('R');
      const force = flags.includes('f');
      if (!paths.length && !force) return { stderr: 'rm: missing operand\n', code: 1 };

      for (const p of paths) {
        const abs = this.#resolve(p);
        if (!vfs.exists(abs)) {
          if (force) continue;
          return { stderr: `rm: ${p}: No such file or directory\n`, code: 1 };
        }
        if (vfs.isDir(abs) && !recursive) return { stderr: `rm: ${p}: is a directory\n`, code: 1 };
        vfs.remove(abs, true);
      }
      return { stdout: '' };
    },

    rmdir(args) {
      for (const p of args) vfs.remove(this.#resolve(p), false);
      return { stdout: '' };
    },

    cp(args) {
      const paths = args.filter((a) => !a.startsWith('-'));
      if (paths.length < 2) return { stderr: 'cp: missing destination\n', code: 1 };
      const dest = paths.pop();
      const absDest = this.#resolve(dest);
      for (const src of paths) {
        const target = vfs.isDir(absDest) ? join(absDest, basename(src)) : absDest;
        vfs.copy(this.#resolve(src), target);
      }
      return { stdout: '' };
    },

    mv(args) {
      const paths = args.filter((a) => !a.startsWith('-'));
      if (paths.length < 2) return { stderr: 'mv: missing destination\n', code: 1 };
      const dest = paths.pop();
      const absDest = this.#resolve(dest);
      for (const src of paths) {
        const target = vfs.isDir(absDest) ? join(absDest, basename(src)) : absDest;
        vfs.move(this.#resolve(src), target);
      }
      return { stdout: '' };
    },

    head(args, stdin) { return this.#headTail(args, stdin, 'head'); },
    tail(args, stdin) { return this.#headTail(args, stdin, 'tail'); },

    wc(args, stdin) {
      const flags = args.filter((a) => a.startsWith('-')).join('');
      const files = args.filter((a) => !a.startsWith('-'));
      const inputs = this.#inputs(files, stdin);
      let out = '';
      for (const i of inputs) {
        const lines = i.text ? i.text.replace(/\n$/, '').split('\n').length : 0;
        const words = i.text.trim() ? i.text.trim().split(/\s+/).length : 0;
        const chars = i.text.length;
        const cols = [];
        if (flags.includes('l') || !flags) cols.push(lines);
        if (flags.includes('w') || !flags) cols.push(words);
        if (flags.includes('c') || !flags) cols.push(chars);
        out += `${cols.join(' ')}${i.name !== '-' ? ' ' + i.name : ''}\n`;
      }
      return { stdout: out };
    },

    grep(args, stdin) {
      const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
      const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
      const pattern = rest.shift();
      if (pattern == null) return { stderr: 'grep: missing pattern\n', code: 1 };

      const recursive = flags.includes('r') || flags.includes('R');
      const rx = new RegExp(pattern, flags.includes('i') ? 'i' : '');
      const invert = flags.includes('v');
      const showNum = flags.includes('n');
      const countOnly = flags.includes('c');
      const namesOnly = flags.includes('l');

      let inputs;
      if (recursive) {
        const root = this.#resolve(rest[0] || '.');
        inputs = vfs.files()
          .filter((f) => f === root || f.startsWith((root === '/' ? '' : root) + '/'))
          .map((f) => ({ name: f, text: vfs.read(f) }));
      } else {
        inputs = this.#inputs(rest, stdin);
      }

      const many = inputs.length > 1;
      let out = '';
      let hits = 0;

      for (const i of inputs) {
        let fileHits = 0;
        const lines = i.text.split('\n');

        lines.forEach((ln, idx) => {
          if (idx === lines.length - 1 && ln === '') return;   // trailing newline
          if (rx.test(ln) === invert) return;                  // not a hit
          fileHits++;
          hits++;
          if (namesOnly || countOnly) return;
          const prefix = many && i.name !== '-' ? i.name + ':' : '';
          out += `${prefix}${showNum ? idx + 1 + ':' : ''}${ln}\n`;
        });
        if (countOnly) out += `${many && i.name !== '-' ? i.name + ':' : ''}${fileHits}\n`;
        if (namesOnly && fileHits) out += `${i.name}\n`;
      }
      return { stdout: out, code: hits ? 0 : 1 };
    },

    find(args) {
      const start = this.#resolve(args.find((a) => !a.startsWith('-')) || '.');
      const nameIdx = args.indexOf('-name');
      const typeIdx = args.indexOf('-type');
      const namePat = nameIdx >= 0 ? args[nameIdx + 1] : null;
      const type = typeIdx >= 0 ? args[typeIdx + 1] : null;

      const rx = namePat
        ? new RegExp('^' + namePat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
        : null;

      const walk = (dir, acc) => {
        for (const e of vfs.list(dir)) {
          const okType = !type || (type === 'f' ? e.type === 'file' : e.type === 'dir');
          if (okType && (!rx || rx.test(e.name))) acc.push(e.path);
          if (e.type === 'dir') walk(e.path, acc);
        }
        return acc;
      };

      if (!vfs.exists(start)) return { stderr: `find: ${start}: No such file or directory\n`, code: 1 };
      if (vfs.isFile(start)) return { stdout: start + '\n' };
      return { stdout: walk(start, []).join('\n') + '\n' };
    },

    sed(args, stdin) {
      const inPlace = args.includes('-i');
      const rest = args.filter((a) => a !== '-i' && a !== '-n' && a !== '-e');
      const script = rest.shift() || '';
      const m = /^s(.)(.*)$/.exec(script);
      if (!m) return { stderr: 'sed: only s/find/replace/[g] is supported\n', code: 1 };

      const delim = m[1];
      const parts = splitUnescaped(m[2], delim);
      const [pat, rep = '', flags = ''] = parts;
      const rx = new RegExp(pat, flags.includes('g') ? 'g' : '');

      if (inPlace) {
        for (const p of rest) {
          const abs = this.#resolve(p);
          vfs.write(abs, vfs.read(abs).replace(rx, rep));
        }
        return { stdout: '' };
      }
      return { stdout: this.#inputs(rest, stdin).map((i) => i.text.replace(rx, rep)).join('') };
    },

    sort(args, stdin) {
      const files = args.filter((a) => !a.startsWith('-'));
      const text = this.#inputs(files, stdin).map((i) => i.text).join('');
      const lines = text.replace(/\n$/, '').split('\n');
      lines.sort((a, b) => (args.includes('-n') ? Number(a) - Number(b) : a.localeCompare(b)));
      if (args.includes('-r')) lines.reverse();
      return { stdout: lines.join('\n') + '\n' };
    },

    uniq(args, stdin) {
      const files = args.filter((a) => !a.startsWith('-'));
      const lines = this.#inputs(files, stdin).map((i) => i.text).join('').replace(/\n$/, '').split('\n');
      const out = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
      return { stdout: out.join('\n') + '\n' };
    },

    env() {
      return { stdout: Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' };
    },

    which(args) {
      const found = args.filter((a) => this.builtins[a]);
      return {
        stdout: found.map((a) => `/bin/${a}`).join('\n') + (found.length ? '\n' : ''),
        code: found.length === args.length ? 0 : 1
      };
    },

    date() { return { stdout: new Date().toISOString() + '\n' }; },
    true() { return { stdout: '', code: 0 }; },
    false() { return { stdout: '', code: 1 }; },

    help() {
      return { stdout: 'builtins: ' + Object.keys(this.builtins).sort().join(' ') + '\n' };
    },

    async python(args, stdin) {
      if (!this.runPython) return { stderr: 'python: runtime unavailable\n', code: 1 };
      let code;
      const ci = args.indexOf('-c');
      if (ci >= 0) {
        code = args[ci + 1] ?? '';
      } else {
        const file = args.find((a) => !a.startsWith('-'));
        if (!file) return { stderr: 'python: reading a script from stdin is not supported; use -c or a file\n', code: 1 };
        const abs = this.#resolve(file);
        if (!vfs.isFile(abs)) return { stderr: `python: can't open file '${file}'\n`, code: 2 };
        code = vfs.read(abs);
      }
      const r = await this.runPython(code, { stdin });
      return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.ok ? 0 : 1 };
    },

    async python3(args, stdin) { return this.builtins.python.call(this, args, stdin); }
  };

  #headTail(args, stdin, which) {
    const nIdx = args.indexOf('-n');
    const n = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) || 10 : 10;
    const files = args.filter((a, i) => !a.startsWith('-') && i !== nIdx + 1);
    const inputs = this.#inputs(files, stdin);
    let out = '';
    for (const i of inputs) {
      const lines = i.text.replace(/\n$/, '').split('\n');
      const slice = which === 'head' ? lines.slice(0, n) : lines.slice(-n);
      if (inputs.length > 1) out += `==> ${i.name} <==\n`;
      out += slice.join('\n') + '\n';
    }
    return { stdout: out };
  }
}

/* ------------------------------------------------------------------ parsing */

/** Split on top-level operators, honouring quotes. */
function splitTop(text, ops) {
  const out = [];
  let buf = '';
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (ops.includes(c)) {
      // don't split `||` when asked for `|`
      if (c === '|' && (text[i + 1] === '|' || text[i - 1] === '|')) { buf += c; continue; }
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/** Break a chain into `{op, text}` segments on `&&` / `||`. */
function splitLogical(text) {
  const parts = [];
  let buf = '';
  let op = null;
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }

    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push({ op, text: buf });
      buf = '';
      op = two;
      i++;
      continue;
    }
    buf += c;
  }
  parts.push({ op, text: buf });
  return parts.filter((p) => p.text.trim());
}

/** Pull `> file` / `>> file` off the end and tokenise the rest. */
function parseRedirects(segment) {
  let redirect = null;
  const text = segment.replace(/\s*(>>?)\s*("[^"]*"|'[^']*'|\S+)\s*$/, (_, op, path) => {
    redirect = { append: op === '>>', path: unquote(path) };
    return '';
  });
  return { argv: tokenizeWords(text), redirect };
}

/**
 * Word-split honouring quotes and backslash escapes.
 * Each word remembers whether any of it was quoted, so glob expansion can
 * skip it later.
 * @returns {Array<{value: string, quoted: boolean}>}
 */
export function tokenizeWords(text) {
  const out = [];
  let buf = '';
  let quote = null;
  let started = false;
  let quoted = false;

  const flush = () => {
    if (started || buf) out.push({ value: buf, quoted });
    buf = '';
    started = false;
    quoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '\\' && quote !== "'" && i + 1 < text.length) {
      buf += text[++i];
      started = true;
      quoted = true;
      continue;
    }
    if (quote) {
      if (c === quote) { quote = null; continue; }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; quoted = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }

    buf += c;
    started = true;
  }
  flush();
  return out;
}

/** Plain word-split — the values only. */
export function tokenize(text) {
  return tokenizeWords(text).map((w) => w.value);
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Split `a/b/g` on an unescaped delimiter. */
function splitUnescaped(text, delim) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === delim) { buf += delim; i++; continue; }
    if (text[i] === delim) { out.push(buf); buf = ''; continue; }
    buf += text[i];
  }
  out.push(buf);
  return out;
}

function cap(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…(output truncated at ${MAX_OUTPUT} chars)` : s;
}
