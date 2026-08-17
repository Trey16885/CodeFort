/**
 * smoke.mjs — headless checks for the parts that have real logic:
 * the virtual filesystem, the shell interpreter and the publish bundler.
 *
 *   node tests/smoke.mjs
 *
 * These modules are deliberately free of DOM dependencies so they can run
 * here as well as in the browser.
 */

import assert from 'node:assert/strict';
import { VFS, normalize, dirname, basename } from '../assets/js/vfs.js';
import { Shell, tokenize, tokenizeWords } from '../assets/js/shell.js';
import { vfs } from '../assets/js/vfs.js';
import { bundleToHtml, makeSlug, slugFromLocation } from '../assets/js/supabase.js';
import { Auth, toSession, friendlyError } from '../assets/js/auth.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ paths */

console.log('\npaths');

test('normalize collapses . .. and doubled slashes', () => {
  assert.equal(normalize('a//b/./c'), '/a/b/c');
  assert.equal(normalize('/a/b/../c'), '/a/c');
  assert.equal(normalize(''), '/');
  assert.equal(normalize('/a/b/'), '/a/b');
});

test('dirname and basename', () => {
  assert.equal(dirname('/a/b/c.txt'), '/a/b');
  assert.equal(dirname('/top.txt'), '/');
  assert.equal(basename('/a/b/c.txt'), 'c.txt');
});

/* -------------------------------------------------------------------- vfs */

console.log('\nvfs');

test('write creates missing parents', () => {
  const fs = new VFS();
  fs.write('/deep/nested/file.txt', 'hi');
  assert.ok(fs.isDir('/deep'));
  assert.ok(fs.isDir('/deep/nested'));
  assert.equal(fs.read('/deep/nested/file.txt'), 'hi');
});

test('edit refuses an ambiguous find', () => {
  const fs = new VFS();
  fs.write('/a.txt', 'x\nx\n');
  assert.throws(() => fs.edit('/a.txt', 'x', 'y'), /matches 2 times/);
  assert.equal(fs.edit('/a.txt', 'x', 'y', true), 2);
  assert.equal(fs.read('/a.txt'), 'y\ny\n');
});

test('edit reports a missing find', () => {
  const fs = new VFS();
  fs.write('/a.txt', 'hello');
  assert.throws(() => fs.edit('/a.txt', 'nope', 'x'), /not present/);
});

test('remove takes the whole subtree', () => {
  const fs = new VFS();
  fs.write('/src/a.js', '1');
  fs.write('/src/lib/b.js', '2');
  assert.equal(fs.remove('/src'), 4); // /src, /src/a.js, /src/lib, /src/lib/b.js
  assert.equal(fs.files().length, 0);
});

test('refuses to delete or move the root', () => {
  const fs = new VFS();
  assert.throws(() => fs.remove('/'), /refusing/);
  assert.throws(() => fs.move('/', '/x'), /refusing/);
});

test('move renames a whole directory', () => {
  const fs = new VFS();
  fs.write('/a/one.txt', '1');
  fs.write('/a/two.txt', '2');
  fs.move('/a', '/b');
  assert.deepEqual(fs.files(), ['/b/one.txt', '/b/two.txt']);
  assert.ok(!fs.exists('/a'));
});

test('move rejects a move into itself', () => {
  const fs = new VFS();
  fs.mkdir('/a');
  assert.throws(() => fs.move('/a', '/a/b'), /into itself/);
});

test('snapshot round-trips, empty folders included', () => {
  const fs = new VFS();
  fs.write('/index.html', '<h1>hi</h1>');
  fs.mkdir('/empty');
  const snap = fs.snapshot();

  const other = new VFS();
  other.restore(snap);
  assert.equal(other.read('/index.html'), '<h1>hi</h1>');
  assert.ok(other.isDir('/empty'));
});

test('tree renders nesting', () => {
  const fs = new VFS();
  fs.write('/a/b.txt', 'xy');
  const t = fs.tree();
  assert.match(t, /a\//);
  assert.match(t, /b\.txt\s+\(2 bytes\)/);
});

/* ------------------------------------------------------------------ shell */

console.log('\nshell');

test('tokenize honours quotes and escapes', () => {
  assert.deepEqual(tokenize('echo "a b" c'), ['echo', 'a b', 'c']);
  assert.deepEqual(tokenize("echo 'a  b'"), ['echo', 'a  b']);
  assert.deepEqual(tokenize('echo a\\ b'), ['echo', 'a b']);
  assert.deepEqual(tokenize('echo ""'), ['echo', '']);
});

test('tokenizer records which words were quoted', () => {
  const words = tokenizeWords('find . -name "*.js"');
  assert.deepEqual(words.map((w) => w.value), ['find', '.', '-name', '*.js']);
  assert.deepEqual(words.map((w) => w.quoted), [false, false, false, true]);
});

const sh = new Shell();
const run = (cmd) => sh.run(cmd);

await testAsync('echo and redirect create a file', async () => {
  vfs.clear();
  const r = await run('echo hello > /greet.txt');
  assert.equal(r.code, 0);
  assert.equal(vfs.read('/greet.txt'), 'hello\n');
});

await testAsync('append redirect adds to the file', async () => {
  await run('echo again >> /greet.txt');
  assert.equal(vfs.read('/greet.txt'), 'hello\nagain\n');
});

await testAsync('pipes flow left to right', async () => {
  const r = await run('cat /greet.txt | wc -l');
  assert.equal(r.stdout.trim(), '2');
});

await testAsync('mkdir, cd and pwd track state', async () => {
  await run('mkdir -p /src/lib');
  await run('cd /src/lib');
  const r = await run('pwd');
  assert.equal(r.stdout.trim(), '/src/lib');
  await run('cd /');
});

await testAsync('relative paths resolve against cwd', async () => {
  await run('mkdir /rel && cd /rel');
  await run('echo x > note.txt');
  assert.equal(vfs.read('/rel/note.txt'), 'x\n');
  await run('cd /');
});

await testAsync('&& short-circuits on failure', async () => {
  const r = await run('false && echo nope');
  assert.equal(r.stdout.trim(), '');
  const r2 = await run('true && echo yes');
  assert.equal(r2.stdout.trim(), 'yes');
});

await testAsync('|| runs only after a failure', async () => {
  const r = await run('false || echo fallback');
  assert.equal(r.stdout.trim(), 'fallback');
});

await testAsync('grep -n finds matching lines', async () => {
  vfs.write('/code.js', 'const a = 1;\n// TODO: fix\nconst b = 2;\n');
  const r = await run('grep -n TODO /code.js');
  assert.match(r.stdout, /^2:\/\/ TODO: fix$/m);
});

await testAsync('grep -r sweeps the workspace', async () => {
  const r = await run('grep -rl TODO /');
  assert.match(r.stdout, /\/code\.js/);
});

await testAsync('grep exits non-zero with no match', async () => {
  const r = await run('grep zzzz /code.js');
  assert.equal(r.code, 1);
});

await testAsync('sed -i rewrites in place', async () => {
  await run('sed -i "s/TODO/DONE/" /code.js');
  assert.match(vfs.read('/code.js'), /DONE/);
});

await testAsync('find filters by name and type', async () => {
  vfs.write('/src/app.js', '');
  vfs.write('/src/app.css', '');
  const r = await run('find /src -type f -name "*.js"');
  assert.match(r.stdout, /\/src\/app\.js/);
  assert.ok(!/app\.css/.test(r.stdout));
});

await testAsync('globs expand against the workspace', async () => {
  const r = await run('ls /src/*.css');
  assert.match(r.stdout, /app\.css/);
});

await testAsync('rm needs -r for a directory', async () => {
  const bad = await run('rm /src');
  assert.equal(bad.code, 1);
  const good = await run('rm -rf /src');
  assert.equal(good.code, 0);
  assert.ok(!vfs.exists('/src'));
});

await testAsync('cp and mv move content around', async () => {
  vfs.write('/one.txt', 'content');
  await run('cp /one.txt /two.txt');
  assert.equal(vfs.read('/two.txt'), 'content');
  await run('mv /two.txt /three.txt');
  assert.ok(!vfs.exists('/two.txt'));
  assert.equal(vfs.read('/three.txt'), 'content');
});

await testAsync('head and tail slice lines', async () => {
  vfs.write('/nums.txt', '1\n2\n3\n4\n5\n');
  assert.equal((await run('head -n 2 /nums.txt')).stdout, '1\n2\n');
  assert.equal((await run('tail -n 2 /nums.txt')).stdout, '4\n5\n');
});

await testAsync('sort -n orders numerically', async () => {
  vfs.write('/mix.txt', '10\n2\n33\n');
  assert.equal((await run('sort -n /mix.txt')).stdout, '2\n10\n33\n');
});

await testAsync('unknown commands report 127', async () => {
  const r = await run('definitely-not-a-command');
  assert.equal(r.code, 127);
  assert.match(r.stderr, /command not found/);
});

await testAsync('a missing file is an error, not a crash', async () => {
  const r = await run('cat /nope.txt');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No such file/);
});

await testAsync('semicolons run commands in sequence', async () => {
  vfs.clear();
  const r = await run('echo a > /a; echo b > /b; ls /');
  assert.match(r.stdout, /a/);
  assert.match(r.stdout, /b/);
});

/* -------------------------------------------------------------- publishing */

console.log('\npublishing');

test('slugs are the right shape and unique', () => {
  const a = makeSlug();
  const b = makeSlug();
  assert.match(a, /^[a-z0-9]{12}$/);
  assert.notEqual(a, b);
});

test('slug is read from ?=, ?p= and #', () => {
  assert.equal(slugFromLocation({ search: '?=abc123xyz', hash: '' }), 'abc123xyz');
  assert.equal(slugFromLocation({ search: '?p=abc123xyz', hash: '' }), 'abc123xyz');
  assert.equal(slugFromLocation({ search: '', hash: '#abc123xyz' }), 'abc123xyz');
  assert.equal(slugFromLocation({ search: '', hash: '' }), null);
  assert.equal(slugFromLocation({ search: '?=../etc/passwd', hash: '' }), null);
});

test('bundler inlines local css and js', () => {
  const html = bundleToHtml({
    '/index.html': '<link rel="stylesheet" href="style.css"><script src="app.js"></script><p>hi</p>',
    '/style.css': 'body{color:red}',
    '/app.js': 'console.log(1)'
  });
  assert.match(html, /<style>\s*body\{color:red\}/);
  assert.match(html, /console\.log\(1\)/);
  assert.ok(!/href="style\.css"/.test(html));
});

test('bundler leaves remote references alone', () => {
  const html = bundleToHtml({
    '/index.html': '<script src="https://cdn.example.com/x.js"></script>'
  });
  assert.match(html, /https:\/\/cdn\.example\.com\/x\.js/);
});

test('bundler rewrites a local image to a data URL', () => {
  const html = bundleToHtml({
    '/index.html': '<img src="logo.svg">',
    '/logo.svg': '<svg/>'
  });
  assert.match(html, /src="data:image\/svg\+xml/);
});

test('bundler falls back when there is no entry point', () => {
  const html = bundleToHtml({ '/notes.txt': 'hello' });
  assert.match(html, /No HTML entry point/);
});

test('bundler finds a non-root index.html', () => {
  const html = bundleToHtml({ '/site/index.html': '<p>nested</p>' });
  assert.match(html, /nested/);
});

/* ------------------------------------------------------------------- tasks */

console.log('\ntasks');

const { TaskStore, nameFromBrief } = await import('../assets/js/tasks.js');

test('a task name is derived from its brief', () => {
  assert.equal(nameFromBrief('build a pomodoro timer'), 'Build a pomodoro timer');
  assert.equal(nameFromBrief('   '), 'Untitled task');
  const long = nameFromBrief('build a really quite elaborate dashboard with several charts and filters');
  assert.ok(long.length <= 45, `too long: ${long}`);
  assert.ok(long.endsWith('…'));
});

test('hydrate always produces one active task', () => {
  const store = new TaskStore();
  store.hydrate();
  assert.equal(store.tasks.length, 1);
  assert.ok(store.active);
  assert.equal(store.activeId, store.active.id);
});

test('each task keeps its own workspace', () => {
  const store = new TaskStore();
  store.hydrate();

  const first = store.active.id;
  vfs.clear();
  vfs.write('/a.html', 'alpha');

  store.create('Second');
  assert.deepEqual(vfs.files(), [], 'a new task starts with an empty workspace');

  vfs.write('/b.html', 'beta');
  const second = store.activeId;

  store.switchTo(first);
  assert.deepEqual(vfs.files(), ['/a.html']);
  assert.equal(vfs.read('/a.html'), 'alpha');

  store.switchTo(second);
  assert.deepEqual(vfs.files(), ['/b.html']);
  assert.equal(vfs.read('/b.html'), 'beta');
});

test('switching captures edits made since the last save', () => {
  const store = new TaskStore();
  store.hydrate();
  const first = store.activeId;

  vfs.clear();
  vfs.write('/notes.txt', 'v1');
  store.create('Other');
  store.switchTo(first);

  vfs.write('/notes.txt', 'v2');       // edited, debounce not yet fired
  const other = store.list().find((t) => t.id !== first).id;
  store.switchTo(other);
  store.switchTo(first);

  assert.equal(vfs.read('/notes.txt'), 'v2');
});

test('deleting the last task leaves a fresh empty one', () => {
  const store = new TaskStore();
  store.hydrate();
  vfs.write('/x.txt', 'gone');

  store.remove(store.activeId);
  assert.equal(store.tasks.length, 1);
  assert.deepEqual(vfs.files(), []);
});

test('deleting the active task falls back to another', () => {
  const store = new TaskStore();
  store.hydrate();
  const first = store.activeId;
  store.create('Keeper');
  const keeper = store.activeId;

  store.remove(first);
  assert.equal(store.tasks.length, 1);
  assert.equal(store.activeId, keeper);
});

test('renaming, briefs and publish state stick to their task', () => {
  const store = new TaskStore();
  store.hydrate();
  const first = store.activeId;

  store.rename(first, 'Renamed');
  store.setBrief('do the thing');
  store.addPublication({ url: 'https://x/?=abc123', slug: 'abc123' });

  store.create('Another');
  assert.equal(store.active.brief, '');
  assert.deepEqual(store.publications(), []);

  store.switchTo(first);
  assert.equal(store.active.name, 'Renamed');
  assert.equal(store.active.brief, 'do the thing');
  assert.equal(store.publications()[0].slug, 'abc123');
});

test('a task keeps every publication, newest first', () => {
  const store = new TaskStore();
  store.hydrate();

  store.addPublication({ url: 'https://x/?=aaa111', slug: 'aaa111' });
  store.addPublication({ url: 'https://x/?=bbb222', slug: 'bbb222' });

  assert.deepEqual(store.publications().map((p) => p.slug), ['bbb222', 'aaa111']);
});

test('re-publishing the same slug does not duplicate it', () => {
  const store = new TaskStore();
  store.hydrate();
  store.addPublication({ url: 'https://x/?=aaa111', slug: 'aaa111' });
  store.addPublication({ url: 'https://x/?=aaa111', slug: 'aaa111', title: 'again' });

  assert.equal(store.publications().length, 1);
  assert.equal(store.publications()[0].title, 'again');
});

test('removePublication drops just that one', () => {
  const store = new TaskStore();
  store.hydrate();
  store.addPublication({ url: 'https://x/?=aaa111', slug: 'aaa111' });
  store.addPublication({ url: 'https://x/?=bbb222', slug: 'bbb222' });

  store.removePublication('aaa111');
  assert.deepEqual(store.publications().map((p) => p.slug), ['bbb222']);

  assert.equal(store.removePublication('nosuch'), null, 'unknown slug is a no-op');
  assert.equal(store.publications().length, 1);
});

test('a publication can be removed from a task that is not active', () => {
  const store = new TaskStore();
  store.hydrate();
  const first = store.activeId;
  store.addPublication({ url: 'https://x/?=aaa111', slug: 'aaa111' });

  store.create('Other');
  assert.equal(store.activeId !== first, true);

  const owner = store.removePublication('aaa111');
  assert.equal(owner.id, first);
  assert.equal(store.tasks.find((t) => t.id === first).publications.length, 0);
});

test('a default-named task is renamed by its first brief', () => {
  const store = new TaskStore();
  store.hydrate();
  store.rename(store.activeId, 'New task');
  store.setBrief('build a snake game', { rename: true });
  assert.equal(store.active.name, 'Build a snake game');

  store.setBrief('something else entirely', { rename: true });
  assert.equal(store.active.name, 'Build a snake game', 'a named task is not renamed again');
});

test('the task list is ordered by most recent activity', () => {
  const store = new TaskStore();
  store.hydrate();
  store.rename(store.activeId, 'Older');
  const older = store.activeId;
  store.create('Newer');

  store.switchTo(older);
  store.rename(older, 'Older, touched');

  assert.equal(store.list()[0].name, 'Older, touched');
});

/* ---------------------------------------------------------------- accounts */

console.log('\naccounts');

const CONFIGURED = () => ({ supabaseUrl: 'https://demo.supabase.co', supabaseKey: 'anon-key' });

test('a session is read from either GoTrue response shape', () => {
  const flat = toSession({
    access_token: 'a', refresh_token: 'r', expires_in: 3600,
    user: { id: 'u1', email: 'a@b.co' }
  });
  assert.equal(flat.access_token, 'a');
  assert.equal(flat.user.email, 'a@b.co');
  assert.ok(flat.expires_at > Date.now());

  const nested = toSession({
    session: { access_token: 'a', refresh_token: 'r', expires_in: 60 },
    user: { id: 'u1', email: 'a@b.co' }
  });
  assert.equal(nested.access_token, 'a');
  assert.equal(nested.user.id, 'u1');
});

test('signup awaiting confirmation yields no session', () => {
  assert.equal(toSession({ id: 'u1', email: 'a@b.co', confirmation_sent_at: 'now' }), null);
  assert.equal(toSession({}), null);
  assert.equal(toSession(null), null);
});

test('an absolute expires_at is preferred over expires_in', () => {
  const at = Math.floor(Date.now() / 1000) + 1000;
  const s = toSession({ access_token: 'a', expires_at: at, expires_in: 5 });
  assert.equal(s.expires_at, at * 1000);
});

test('GoTrue errors become one actionable sentence', () => {
  assert.match(friendlyError({ error_description: 'Invalid login credentials' }, 400), /Wrong email or password/);
  assert.match(friendlyError({ msg: 'User already registered' }, 422), /already has an account/);
  assert.match(friendlyError({ message: 'Email not confirmed' }, 400), /Confirm your email/);
  assert.match(friendlyError({}, 429), /Too many attempts/);
  assert.match(friendlyError({}, 500), /HTTP 500/);
});

test('signed-in requires a token that has not expired', () => {
  const auth = new Auth(CONFIGURED);
  assert.equal(auth.isSignedIn(), false);

  auth.session = { access_token: 'a', expires_at: Date.now() + 60_000, user: { id: 'u' } };
  assert.equal(auth.isSignedIn(), true);

  auth.session = { access_token: 'a', expires_at: Date.now() - 1, user: { id: 'u' } };
  assert.equal(auth.isSignedIn(), false);
});

test('accounts are unavailable without Supabase', () => {
  const auth = new Auth(() => ({ supabaseUrl: '', supabaseKey: '' }));
  assert.equal(auth.isConfigured(), false);
  assert.equal(new Auth(CONFIGURED).isConfigured(), true);
});

await testAsync('credentials are validated before any network call', async () => {
  const auth = new Auth(CONFIGURED);
  await assert.rejects(() => auth.signUp('not-an-email', 'longenough'), /email address/);
  await assert.rejects(() => auth.signUp('a@b.co', 'short'), /at least 8 characters/);
  await assert.rejects(() => auth.signIn('', 'longenough'), /email address/);
});

await testAsync('unconfigured signup explains itself instead of throwing a URL error', async () => {
  const auth = new Auth(() => ({ supabaseUrl: '', supabaseKey: '' }));
  await assert.rejects(() => auth.signUp('a@b.co', 'longenough'), /no Supabase configured/);
});

await testAsync('publishing refuses without a session', async () => {
  const { publish } = await import('../assets/js/supabase.js');
  await assert.rejects(
    () => publish({ settings: CONFIGURED(), session: null, files: { '/a.html': 'x' }, name: 'me' }),
    /needs an account/
  );
});

/* --------------------------------------------------------------- unpublish */

console.log('\nunpublish');

const SESSION = { access_token: 'tok', user: { id: 'uid-1', email: 'a@b.co' } };

await testAsync('unpublishing refuses without a session or Supabase', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  await assert.rejects(
    () => unpublish({ settings: CONFIGURED(), session: null, slug: 'abc123' }),
    /needs an account/
  );
  await assert.rejects(
    () => unpublish({ settings: { supabaseUrl: '', supabaseKey: '' }, session: SESSION, slug: 'abc123' }),
    /not configured/
  );
});

await testAsync('a malformed slug never reaches the network', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('[]'); };
  try {
    await assert.rejects(
      () => unpublish({ settings: CONFIGURED(), session: SESSION, slug: '../../etc/passwd' }),
      /not a valid publication id/
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('unpublish sends an authenticated, slug-scoped DELETE', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify([{ slug: 'abc123' }]), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await unpublish({ settings: CONFIGURED(), session: SESSION, slug: 'abc123' });
    assert.equal(result.removed, true);
    assert.equal(seen.init.method, 'DELETE');
    assert.match(seen.url, /\/rest\/v1\/publications\?slug=eq\.abc123$/);
    assert.equal(seen.init.headers.Authorization, 'Bearer tok', 'must use the user token, not the anon key');
    assert.equal(seen.init.headers.apikey, 'anon-key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('deleting nothing reports removed:false rather than claiming success', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
  try {
    const result = await unpublish({ settings: CONFIGURED(), session: SESSION, slug: 'abc123' });
    assert.equal(result.removed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PostgREST errors name the fix, not just the symptom', async () => {
  const { friendlyRestError } = await import('../assets/js/supabase.js');

  // The exact shape PostgREST returns when the schema was never applied.
  assert.match(
    friendlyRestError({
      code: 'PGRST205',
      message: "Could not find the table 'public.publications' in the schema cache"
    }, 404),
    /run supabase\/schema\.sql/
  );
  assert.match(friendlyRestError({ code: 'PGRST106' }, 406), /public. schema is not exposed/);
  assert.match(friendlyRestError({ code: '42501' }, 403), /row-level security/);
  assert.match(friendlyRestError({}, 403), /row-level security/);
  assert.match(friendlyRestError({ code: '23505' }, 409), /already taken/);
  assert.match(friendlyRestError({ message: 'something odd' }, 500), /something odd/);
  assert.match(friendlyRestError({}, 500), /HTTP 500/);
});

await testAsync('a publish against a missing table explains itself', async () => {
  const { publish } = await import('../assets/js/supabase.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 'PGRST205',
    message: "Could not find the table 'public.publications' in the schema cache"
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      () => publish({ settings: CONFIGURED(), session: SESSION, files: { '/a.html': 'x' }, name: 'me' }),
      /run supabase\/schema\.sql/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('a refused delete points at the RLS policies', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'permission denied' }), {
    status: 403, headers: { 'Content-Type': 'application/json' }
  });
  try {
    await assert.rejects(
      () => unpublish({ settings: CONFIGURED(), session: SESSION, slug: 'abc123' }),
      /unpublish failed: .*row-level security/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('an unrecognised server error passes its message through', async () => {
  const { unpublish } = await import('../assets/js/supabase.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'deadlock detected' }), {
    status: 500, headers: { 'Content-Type': 'application/json' }
  });
  try {
    await assert.rejects(
      () => unpublish({ settings: CONFIGURED(), session: SESSION, slug: 'abc123' }),
      /unpublish failed: deadlock detected/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------------------------------------------------- done */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
