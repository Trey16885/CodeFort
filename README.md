# CodeFort

CodeFort is your new Web Agent of Coding — multiple models working together to bring you the best agentic time.

**[Meet us here!](https://trey16885.github.io/CodeFort/)**

It runs entirely in the browser: no server, no build step, no install. Open the page, describe what you want, and three Mistral models plan, build, verify, argue, and keep going until all three agree the job is finished.

---

## CodeFort Agent Models

| Role | Model | What it does |
| --- | --- | --- |
| **Architect** | `mistral-large-latest` | Plans the work, writes `/PLAN.md`, keeps the others on course, owns the final call on "done" |
| **Builder** | `mistral-medium-latest` | Writes and rewrites the actual files |
| **Scout** | `mistral-small-latest` | Runs the code, breaks it, reports concrete defects, pushes back on premature "done" |

Every time Mistral updates, CodeFort is already updated — the `-latest` aliases mean the fort picks up each new release automatically, with no code change. Any three models can be swapped in from **Settings** if you'd rather.

## What CodeFort can do

- **Edit, create and delete files and folders.** A full virtual workspace with a tree view, an editor, and a live preview of `/index.html`.
- **Share thought processes between models.** Every reasoning line, tool call, result and verdict from all three agents goes into one stream, and each agent's next prompt is rebuilt from it. They read each other rather than working blind.
- **Run Python and shell.** Real Python 3 via Pyodide, with the workspace mounted at `/work` so scripts can read and write project files. A POSIX-flavoured shell with pipes, redirects, `&&`/`||`, globs and about two dozen builtins.
- **Work until they're done — not until a round counter runs out.** The run ends when all three vote done in the same round. One holdout keeps the fort working.
- **Publish under their own name.** Any agent can call `publish_site`, which stores the workspace in Supabase under a random id and hands back a link:

  ```
  https://trey16885.github.io/CodeFort/?=k7m2xq9d4npv
  ```

  That link renders the built site for anyone who opens it, with the publisher's name on it. You can also publish by hand from the **Publish** button.

## Setup

CodeFort is a static site. It reads three repository secrets, injected at deploy time by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

| Secret | Purpose |
| --- | --- |
| `KEY_TOKEN` | Mistral API key — what the agents think with |
| `SUP_URL` | Supabase project URL — where published sites live |
| `SUP_PB` | Supabase publishable (anon) key |

1. Add those three under **Settings → Secrets and variables → Actions**.
2. Run [`supabase/schema.sql`](supabase/schema.sql) once in your Supabase SQL editor to create the `publications` table and its row-level security policies.
3. Set **Settings → Pages → Source** to **GitHub Actions**.
4. Push to `main`. The workflow syntax-checks every module, writes `assets/js/config.generated.js` from the secrets, and deploys.

Visitors can always override the baked-in key with their own under **Settings** — it's stored in their browser only.

> ⚠️ **A key shipped to a static page is a public key.** Anything injected into the Pages build is readable by every visitor, `KEY_TOKEN` included. Read [`docs/SECURITY.md`](docs/SECURITY.md) before you deploy with a key that has real spend behind it.

## Running it locally

```bash
git clone https://github.com/trey16885/CodeFort.git
cd CodeFort
python3 -m http.server 8080     # any static server; file:// won't work with ES modules
```

Then open <http://localhost:8080> and add your own Mistral key under **Settings**. No key is needed to browse the workspace, editor, shell or Python.

```bash
npm test        # 40 headless checks over the VFS, shell and publish bundler
npm run check   # syntax-check the modules
```

## How it fits together

```
index.html ──► main.js ──► Orchestrator ──► Mistral API (3 models, in turn)
                  │              │
                  │              ├── ThoughtBus   shared stream all three read
                  │              └── Toolbox      file ops · shell · python · publish
                  │                      │
                  └── UI ◄── VFS ◄───────┘
                              │
                              └──► Supabase ──► /?=<slug>
```

Longer version in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```
index.html                 studio + published-site viewer
assets/css/style.css       the whole theme
assets/js/
  main.js                  bootstrap and wiring
  orchestrator.js          rounds, turns, consensus
  agents.js                the three roles and their charters
  thoughts.js              the shared stream
  tools.js                 tool schemas and dispatch
  vfs.js                   virtual workspace
  shell.js                 shell interpreter
  python.js                Pyodide bridge
  mistral.js               API client
  supabase.js              publish, load, and the bundler
  ui.js                    all DOM rendering
  config.js                settings resolution
  config.generated.js      written at deploy time from the secrets
scripts/build-config.mjs   the injector
supabase/schema.sql        publications table + RLS
tests/smoke.mjs            headless test suite
```

---

CodeFort is multiple AI, and these models can make mistakes. Check what they build before you trust it.
