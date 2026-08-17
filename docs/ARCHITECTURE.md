# Architecture

CodeFort is a static site with no build step. `index.html` loads one generated
config script and one ES module; everything else is imported from there. The
whole thing runs in the tab.

## Two modes, one page

`main.js` looks at the URL first:

| URL | Mode |
| --- | --- |
| `/CodeFort/` | **Studio** — the agent workbench |
| `/CodeFort/?=k7m2xq9d4npv` | **Viewer** — renders that published workspace |

`?=slug` is a query string whose key is the empty string, which
`URLSearchParams.get('')` reads directly. `?p=slug`, `?site=slug` and `#slug`
work too. The slug is validated against `^[A-Za-z0-9_-]{4,64}$` before it is
used, so a path like `?=../etc/passwd` is rejected rather than sent anywhere.

## The run loop

```
run(task)
└── for round in 1..maxRounds
    ├── for agent in [Architect, Builder, Scout]
    │   └── takeTurn()
    │       ├── build messages: [system charter, turn prompt]
    │       │      turn prompt = workspace tree
    │       │                  + recent shared stream (all three agents)
    │       │                  + any nudge the orchestrator wants to add
    │       └── for step in 1..maxStepsPerTurn
    │           ├── POST /v1/chat/completions with the tool schemas
    │           ├── assistant text  -> shared stream as a thought
    │           ├── tool call       -> dispatch, result back as a tool message
    │           │                      and into the shared stream
    │           └── end_turn        -> record the verdict, hand off
    └── consensus? -> stop
```

### Why the models actually cooperate

Each agent gets a fresh two-message conversation every turn: its charter, and
a turn prompt rebuilt from the shared stream. It does not carry a private
history across turns. Everything it knows about what the others did, it knows
because `ThoughtBus.transcriptFor()` rendered it into the prompt — with its own
lines marked `(you)`.

That has two useful consequences. Context stays bounded no matter how long the
run goes, and there is exactly one version of events, so two agents cannot
proceed from different beliefs about what has already been built.

### The done rule

A run ends when **all three agents vote `done: true` in the same round, and
nobody has changed the workspace since the earliest of those votes.**

The second half matters. Without it, this sequence would end the run:

1. Architect votes done.
2. Builder rewrites `index.html` and votes done.
3. Scout votes done.

The Architect approved a state that no longer exists. The orchestrator counts
workspace mutations and stamps each verdict with the count at the time it was
cast; if the earliest stamp is behind the current count, the votes are stale
and the fort works another round. The agent whose vote went stale is told so in
its next turn's nudge.

### Nudges

Small, deterministic steering the orchestrator adds to a turn prompt:

- name any agent that is not satisfied, and quote its reason,
- tell an agent when its done vote went stale,
- point the Architect at `/PLAN.md` in round 1,
- point the Builder at the missing `/index.html` from round 2 on.

These are cheap rules, not another model call.

## Modules

| Module | Responsibility |
| --- | --- |
| `main.js` | Mode selection, DOM wiring, dialogs |
| `orchestrator.js` | Rounds, turns, tool loop, consensus, abort |
| `agents.js` | The three roles, charters, shared rules, prompt assembly |
| `thoughts.js` | The shared stream and its prompt rendering |
| `tools.js` | Tool schemas and dispatch |
| `vfs.js` | Virtual workspace |
| `shell.js` | Shell interpreter over the VFS |
| `python.js` | Pyodide bridge |
| `mistral.js` | HTTP, retries, token accounting |
| `supabase.js` | Publish, fetch, and the single-file bundler |
| `ui.js` | Every DOM write |
| `config.js` | Settings precedence |

Only `main.js` and `ui.js` touch the DOM, which is why `vfs.js`, `shell.js` and
`supabase.js` can be tested under plain Node in `tests/smoke.mjs`.

## The virtual filesystem

A flat `Map` of absolute path to node. Directories are stored explicitly, so an
empty folder is a real thing an agent can create. Mutations dispatch a `change`
event, which the UI listens to for the tree, editor and preview, and which the
orchestrator counts for the staleness rule.

The workspace is mirrored into `localStorage` on every change, so a reload
picks up where the fort left off.

## The shell

`run_shell` is an interpreter, not a process. It handles quoting, globs, pipes,
`>`/`>>`, `&&`/`||`/`;`, a working directory, and these builtins:

```
ls cd pwd cat echo mkdir touch rm rmdir cp mv head tail wc
grep find tree sed sort uniq which env date true false help
python python3
```

Quoted words skip glob expansion, so `find . -name "*.js"` reaches `find`
intact — the same reason you quote it in a real shell.

`python`/`python3` hand off to the Pyodide bridge, so `python -c "print(6*7)" |
cat` works as a single pipeline.

## Python

Pyodide loads lazily from a CDN on the first `run_python` call (~10 MB, once
per session) and is reused after. Around each run:

1. `/work` is wiped and rebuilt from the workspace,
2. cwd and `sys.path` are set to `/work`,
3. the code runs, with stdout and stderr captured,
4. `/work` is diffed back into the workspace — new and modified files are
   written, files the script deleted are removed, and the changed paths are
   reported back to the agent.

Set `window.__CODEFORT_PYODIDE_URL__` before the modules load to self-host the
runtime instead of using the CDN.

## Publishing

`publish_site` writes one row: `{slug, name, title, description, entry, files}`,
where `files` is the workspace snapshot as `{path: content}`. The slug is 12
random characters from a 33-character alphabet with the ambiguous glyphs
removed.

The viewer fetches the row and calls `bundleToHtml()`, which folds the whole
workspace into a single document:

- `<link rel="stylesheet">` to a local file becomes an inline `<style>`,
- `<script src>` to a local file becomes an inline `<script>`,
- other local `src`/`href` values become `data:` URLs,
- remote URLs are left alone.

This is what makes a published site work inside a sandboxed iframe with an
opaque origin, where a relative request would have nowhere to go.

## Settings precedence

1. What the user typed into **Settings** (`localStorage`, that browser only)
2. What the deploy workflow baked in from the repository secrets
3. Built-in defaults

Saving a value identical to the baked-in one stores nothing, so a later deploy
with a rotated secret takes effect instead of being shadowed by a stale copy.
