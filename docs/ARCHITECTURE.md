# Architecture

CodeFort is a static site with no build step. `index.html` loads one generated
config script and one ES module; everything else is imported from there. The
whole thing runs in the tab.

## Three modes, one page

`main.js` looks at the URL, then at the session:

| URL / state | Mode |
| --- | --- |
| `/CodeFort/?=k7m2xq9d4npv` | **Viewer** — renders that published workspace, no account |
| `/CodeFort/`, signed out | **Gate** — create an account or sign in |
| `/CodeFort/`, signed in | **Studio** — the agent workbench |

The viewer is checked first and deliberately skips the gate. Publishing that
produced a link only account holders could open would not be publishing.

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

A run ends when **all three agents vote `done: true` in the same round.** A
verdict from an earlier round does not carry forward — each agent re-votes on
its own turn, every round, so the check always reflects what all three think
right now.

One holdout keeps the run going. Nothing else stops it early; the round limit
is the backstop.

Keeping agents honest about that vote is the charters' job, not the
orchestrator's. Rule 8 in the shared rules tells each agent to vote done only
after verifying, and the Scout's charter is explicitly to push back on a
premature "done" — which works because the holdout's reason is in the shared
stream the other two read on their next turn.

## Modules

| Module | Responsibility |
| --- | --- |
| `main.js` | Mode selection, DOM wiring, dialogs |
| `auth.js` | Accounts, session storage, token refresh |
| `tasks.js` | The task list, workspace swapping, persistence |
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

## Tasks

A task is a named brief plus its own workspace. There is one VFS, and switching
tasks swaps what is in it: the outgoing workspace is snapshotted into the task
record, the incoming one is restored over the top. The agents never learn about
any of this — they always see whatever the VFS currently holds, which is why
nothing in `orchestrator.js` or `tools.js` changed when tasks arrived.

`tasks.js` is the *only* writer to storage. The VFS is deliberately memory-only:
with one writer there is no way for a snapshot to land under the wrong task.
A `change` on the VFS schedules a debounced save; an explicit switch, create or
delete captures immediately and cancels the pending one.

Two rules keep it honest:

- **Switching is locked during a run.** Swapping the filesystem out from under
  three agents mid-turn would corrupt whatever they were doing. The list is
  `aria-disabled` and carries the reason as a tooltip — a disabled control
  can't explain itself when clicked.
- **Deleting the last task leaves a fresh empty one.** The studio always has
  somewhere to put files, so no code path has to handle "no active task".

Streams are per-task but held in memory only, keyed by task id in `main.js`.
Switching back inside a session brings the discussion with it; a reload starts
the log fresh. Persisting every stream would blow the `localStorage` budget
that the workspaces themselves need.

A pre-tasks deployment kept one workspace under `codefort.workspace.v1`; on
first load that is imported as a task called "Imported workspace" and the old
key removed.

## The virtual filesystem

A flat `Map` of absolute path to node. Directories are stored explicitly, so an
empty folder is a real thing an agent can create. Mutations dispatch a `change`
event, which the UI listens to for the tree, editor and preview, and which
`tasks.js` listens to for persistence.

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

## Accounts

Supabase Auth (GoTrue) over plain fetch — `/auth/v1/signup`, `/token`,
`/logout`, `/recover`. No SDK, in keeping with the rest.

The session — access token, refresh token, absolute expiry, user id and email —
lives in `localStorage` under `codefort.session.v1`. On boot, `Auth.restore()`
either finds a live session, silently refreshes an expired one, or gives up and
hands over to the gate. While the studio is open a timer refreshes the token a
minute before it expires.

Sign-out and a refresh that stops working are the same event: the session goes
to `null`, `Auth` dispatches `change`, and `main.js` reloads the page back to
the gate. That is why the gate's listeners are only ever attached once.

GoTrue returns a session at the top level for `/token` but nested under
`session` in some signup responses, and returns *no* session at all when the
project requires email confirmation. `toSession()` normalises all three, and a
null result is what tells the gate to say "check your inbox" instead of
dropping the user into the studio.

## Publishing

`publish_site` writes one row: `{slug, user_id, name, title, description,
entry, files}`, where `files` is the workspace snapshot as `{path: content}`.
The slug is 12 random characters from a 33-character alphabet with the
ambiguous glyphs removed.

The insert is authenticated with the user's access token rather than the anon
key, so row-level security sees a real `auth.uid()` and can require that a row's
`user_id` matches the account writing it. Reads stay anonymous.

The viewer fetches the row and calls `bundleToHtml()`, which folds the whole
workspace into a single document:

- `<link rel="stylesheet">` to a local file becomes an inline `<style>`,
- `<script src>` to a local file becomes an inline `<script>`,
- other local `src`/`href` values become `data:` URLs,
- remote URLs are left alone.

This is what makes a published site work inside a sandboxed iframe with an
opaque origin, where a relative request would have nowhere to go.

## Settings

Only four things are the visitor's to set: their own Mistral key, and the three
run bounds (max rounds, tool steps per turn, temperature). Those are per-person
— the key is theirs, and the bounds only ever cap their own spend.

Everything else is the deployment's and comes from the repository secrets: the
agent lineup and the Supabase project. Neither is offered as an input. The
lineup is shown read-only in the dialog, because knowing which models are
running is useful even when changing them is not on the table.

`config.js` enforces this rather than relying on the absence of a form field.
`getSettings()` reads `models`, `supabaseUrl` and `supabaseKey` only from the
baked config, and `saveSettings()` filters every patch through a
`USER_EDITABLE` allowlist, so a value hand-written into `localStorage` is
ignored. A one-time prune drops the `models` and Supabase keys that older
builds allowed, so they don't linger as a confusing artefact.

For the Mistral key alone, precedence is:

1. What the user typed into **Settings** (`localStorage`, that browser only)
2. What the deploy workflow baked in from `KEY_TOKEN`

Saving a key identical to the baked-in one stores nothing, so a later deploy
with a rotated secret takes effect instead of being shadowed by a stale copy.
