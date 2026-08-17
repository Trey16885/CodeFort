# Security notes

## The Mistral key is public once you deploy it

CodeFort is a static site. There is no server between the visitor and the
Mistral API, so the API key has to reach the browser to be used at all. The
deploy workflow writes `KEY_TOKEN` into `assets/js/config.generated.js`, which
is served to every visitor of the Pages site.

That means:

- Anyone who opens the site can read the key from the page source or the
  network tab. Obfuscation does not change this — the browser needs the real
  value to send the request.
- Anyone who reads it can spend against your Mistral account from anywhere,
  not just from CodeFort.

This is a deliberate trade-off of the "static site with repo secrets" design,
not a bug. Deploy that way only with a key you are willing to treat as public.

### The account gate does not protect the key

Requiring sign-up gates the *studio*, not the *files*. `config.generated.js` is
a static asset on the Pages site: anyone can fetch it directly, without an
account, without ever loading the app.

```
curl https://<user>.github.io/CodeFort/assets/js/config.generated.js
```

That returns the key. There is no arrangement of front-end code that changes
this, because GitHub Pages serves files to whoever asks.

So accounts are worth having — they stop strangers spending your Mistral quota
through the UI, and they give publishing a real owner — but they are not a
reason to relax about a baked-in key. Everything below still applies.

### How to keep the spend bounded

1. **Use a dedicated key.** Create a Mistral key used by nothing else, so
   rotating it breaks nothing but CodeFort.
2. **Cap it.** Set the lowest spend limit on that key that still lets the fort
   work, in the Mistral console.
3. **Rotate on a schedule.** Update the `KEY_TOKEN` secret and re-run the
   deploy; the new value ships with the next build.
4. **Watch usage.** A key on a public page is found by scanners quickly. Treat
   an unexplained jump as a compromise and rotate.

### The alternative: don't ship a key at all

Leave `KEY_TOKEN` unset. The workflow warns and deploys with an empty key, the
site loads normally, and each visitor supplies their own key under
**Settings** — stored in their own browser's `localStorage`, never sent
anywhere but `api.mistral.ai`. Everything except the agent loop (workspace,
editor, shell, Python, preview) works with no key at all.

This is the right default for a fort that other people will visit. Ship a key
only when the site is effectively for you.

### If you want a shared key without exposing it

You need something in front of the API that holds the key: a Supabase Edge
Function, a Cloudflare Worker, a small server. Point CodeFort's endpoint at
that proxy, have the proxy attach the key and enforce whatever rate limit or
auth you want. That stops being a purely static site, which is why it isn't
the default here.

## The Supabase key is a different case

`SUP_PB` is the publishable (anon) key. It is *designed* to be public — every
Supabase browser client ships it. What protects the data is row-level
security, not the secrecy of the key.

That is why the project URL and publishable key are **committed** in
`assets/js/config.js` rather than left to the secrets. Two reasons:

1. They are public either way. Committing them exposes nothing that opening
   the deployed site would not.
2. Accounts keep working when `config.generated.js` is missing or stale — a
   failure that has actually happened, and which otherwise takes the whole
   sign-in screen down.

`SUP_URL` and `SUP_PB` still override the built-ins when set, so a fork can
point at its own project without editing code.

The Mistral key gets no such treatment. It is a real secret: it stays in
`KEY_TOKEN`, or in the visitor's own browser, and is never committed.

[`supabase/schema.sql`](../supabase/schema.sql) sets policies so that through
the public API:

- anyone may **read** a publication, signed in or not — that's what publishing
  means, and it's why a `?=<slug>` link needs no account,
- only an **authenticated** account may insert, and only with its own
  `user_id`, so nobody can publish in someone else's name,
- **nobody** may update. Publications are immutable once written, so a stranger
  cannot rewrite someone else's published site,
- an account may **delete** its own publications, and only its own.

Never put the `service_role` key in `SUP_PB`, or in any repository secret this
workflow reads. It bypasses row-level security entirely.

### Abuse surface on publishing

Requiring an account is what bounds this. Before accounts, insert was open to
anyone who found the endpoint; now a writer needs a confirmed email and every
row is attributable. The schema limits the rest:

- a size check caps one publication at ~2 MB,
- the slug format is constrained,
- name, title and description have length limits.

What's left is a determined person creating accounts to spam rows. If that
matters for your deployment, Supabase's own rate limits and CAPTCHA protection
(**Authentication → Rate Limits / Attack Protection**) are the right lever, and
there's a commented `pg_cron` job in the schema that expires old publications.

### Passwords

CodeFort never sees a password beyond passing it to `/auth/v1`. There is no
password storage, hashing or comparison in this codebase — Supabase Auth owns
all of it. The app enforces a minimum length of 8 before making the request,
which is a courtesy check, not the security boundary; set the real policy in
the Supabase dashboard.

The session in `localStorage` is a bearer token. Anything that can run script
on the CodeFort origin can read it — which is the other reason published sites
render in a sandboxed iframe with no same-origin access.

## Published sites run as untrusted code

A published workspace is other people's HTML, CSS and JavaScript. CodeFort
renders it inside an iframe with `sandbox="allow-scripts allow-forms
allow-modals allow-popups"` and **no** `allow-same-origin`, so the page:

- gets a unique opaque origin,
- cannot read the parent document, its `localStorage`, or your Mistral key,
- cannot make same-origin requests back to the CodeFort deployment.

`allow-scripts` without `allow-same-origin` is the combination that matters —
together they would let sandboxed code remove its own sandbox.

The bundler inlines every local reference into the document (styles into
`<style>`, scripts inline, other assets as `data:` URLs) so that a published
site never depends on files fetched from the CodeFort origin.

## Agent tools are scoped to the workspace

Everything the models can touch lives in the in-memory virtual filesystem:

- there is no access to the real disk — the "filesystem" is a `Map` in a tab,
- `run_shell` is an interpreter written for this app, not a spawned process,
- `run_python` runs in Pyodide's WebAssembly sandbox with only `/work` mounted,
  and `/work` is rebuilt from the workspace before every run,
- `publish_site` is the only tool that reaches the network, and it writes to
  exactly one table.

The realistic risks are spend (a loop that burns tokens — bounded by
**Max rounds** and **Tool steps / turn**) and nonsense output, not host
compromise.
