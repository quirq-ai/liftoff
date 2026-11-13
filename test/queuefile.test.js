import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startDeployment } from '../src/pipeline.js';
import { QueueFile, QueueWatcher } from '../src/queuefile.js';
import { Store } from '../src/store.js';
import { Vault } from '../src/vault.js';
import { sha256, sourceDir, startRegistry, tempDir, useFakeDocker } from './helpers.js';

const USER = 'xo-demo-xo-abc123+push';
const PASSWORD = 'correct horse battery staple';
const MANIFEST = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });
const DIGEST = sha256(MANIFEST);
const real = (dir) => fs.realpathSync.native(dir);

/** One app (number 1) with a stored password, a registry that knows its image, the stand-in docker, and a queue file in a projects folder. */
async function setup(t, { fake = {} } = {}) {
  const home = tempDir(t);
  const projects = tempDir(t, 'liftoff-projects-');
  const store = new Store(home);
  const vault = new Vault(home, { backend: 'keyfile' });
  const registry = await startRegistry(t, { user: USER, password: PASSWORD, manifests: { 'demo-xo-abc123/app:latest': MANIFEST } });
  const calls = useFakeDocker(t, { USER, PASSWORD, DIGEST, ...fake });
  const app = store.createApp({ name: 'Demo', registry: registry.host, repository: 'demo-xo-abc123/app', username: USER, contextDir: sourceDir(t) });
  await vault.set(app.id, PASSWORD);
  store.setQueueFile(path.join(projects, 'queue.json'));
  const queue = new QueueFile({ store, vault });
  const project = (name) => {
    fs.mkdirSync(path.join(projects, name));
    fs.writeFileSync(path.join(projects, name, 'Dockerfile'), 'FROM scratch\n');
    return path.join(projects, name);
  };
  const write = (entries) => fs.writeFileSync(queue.file, JSON.stringify(entries, null, 2));
  const read = () => JSON.parse(fs.readFileSync(queue.file, 'utf8'));
  /** Sync the way the watcher does until nothing is waiting or running. */
  const settle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      queue.sync({ trigger: true });
      if (!queue.open) return read();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the queue did not settle');
  };
  return { home, projects, store, vault, app, calls, queue, project, write, read, settle };
}

const builds = (calls) => calls().filter((call) => call.cmd === 'build');

test('an entry with an app number and a relative folder is deployed, and its result is written on it', async (t) => {
  const { store, app, calls, queue, project, write, settle, projects } = await setup(t);
  project('web');
  write([{ app: 1, src: 'web' }]);

  const [entry] = await settle();
  assert.equal(entry.status, 'verified');
  assert.equal(entry.image, DIGEST);
  assert.match(entry.asked, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(entry.took);
  assert.deepEqual(Object.keys(entry).slice(0, 2), ['app', 'src'], 'what was typed stays first, as typed');
  assert.equal(entry.src, 'web');

  const record = store.findDeployment(entry.id);
  assert.equal(record.trigger, 'file');
  assert.equal(record.appId, app.id);
  assert.equal(real(builds(calls)[0].cwd), real(path.join(projects, 'web')));
  assert.equal(real(store.getApp(app.id).contextDir), real(path.join(projects, 'web')));

  // The file stays one entry per line, and nothing more happens on later syncs.
  assert.match(fs.readFileSync(queue.file, 'utf8'), /^\[\n {2}\{ "app": 1, "src": "web", "id": "d\w+", "status": "verified", .*\}\n\]\n$/);
  queue.sync({ trigger: true });
  assert.equal(builds(calls).length, 1);
});

test('to deploy again, add another entry; an entry without a folder uses the one the app has', async (t) => {
  const { store, app, calls, write, read, settle } = await setup(t);
  const folder = store.getApp(app.id).contextDir;
  write([{ app: 1 }]);
  await settle();
  write([...read(), { app: 1, noCache: true }]);
  const entries = await settle();
  assert.deepEqual(entries.map((entry) => entry.status), ['verified', 'verified']);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(builds(calls).length, 2);
  assert.ok(builds(calls)[1].args.includes('--no-cache'));
  assert.equal(store.getApp(app.id).contextDir, folder);
  assert.equal(store.countDeployments(app.id), 2);
});

test('entries run one at a time, in the order they are in the file', async (t) => {
  const { store, project, write, settle } = await setup(t, { fake: { BUILD_MS: 300 } });
  project('one');
  project('two');
  write([{ app: 1, src: 'one' }, { app: 1, src: 'two' }]);
  const entries = await settle();
  const [first, second] = entries.map((entry) => store.findDeployment(entry.id));
  assert.deepEqual(entries.map((entry) => entry.status), ['verified', 'verified']);
  assert.ok(Date.parse(second.startedAt) >= Date.parse(first.finishedAt));
  assert.match(first.contextDir, /one$/);
  assert.match(second.contextDir, /two$/);
});

test('an entry that cannot be started says why and is not tried again', async (t) => {
  const { calls, queue, write, read, project } = await setup(t);
  project('web');
  write([{ app: 7, src: 'web' }, { app: 1, src: 'nowhere' }, { app: 1.5, src: 'web' }, { app: 1, src: 5 }, 'not an entry']);
  queue.sync({ trigger: true });
  queue.sync({ trigger: true });
  const entries = read();
  assert.deepEqual(entries.slice(0, 4).map((entry) => entry.status), ['rejected', 'rejected', 'rejected', 'rejected']);
  assert.match(entries[0].error, /There is no app number 7\. The apps are: 1 = Demo\./);
  assert.match(entries[1].error, /source folder does not exist/);
  assert.match(entries[2].error, /"app" should be the app's number/);
  assert.match(entries[3].error, /"src" should be a folder/);
  assert.equal(entries[4], 'not an entry');
  assert.deepEqual(calls(), []);
  assert.equal(queue.view().entries.at(0).error.startsWith('This line is not an entry'), true);
});

test('a file that is not valid JSON is left exactly as it is, and nothing starts', async (t) => {
  const { calls, queue, project } = await setup(t);
  project('web');
  const broken = '[\n  { "app": 1, "src": "web" \n';
  fs.writeFileSync(queue.file, broken);
  assert.equal(queue.sync({ trigger: true }), null);
  assert.match(queue.error, /not valid JSON right now/);
  assert.equal(fs.readFileSync(queue.file, 'utf8'), broken);
  assert.match(queue.view().error, /not valid JSON/);
  assert.deepEqual(calls(), []);

  fs.writeFileSync(queue.file, '{ "app": 1 }');
  queue.sync({ trigger: true });
  assert.match(queue.error, /should be a list of entries/);
});

test('a comma left after the last entry is forgiven', async (t) => {
  const { queue, project, settle } = await setup(t);
  project('web');
  fs.writeFileSync(queue.file, '[\n  { "app": 1, "src": "web" },\n]\n');
  assert.equal((await settle())[0].status, 'verified');
  assert.equal(queue.error, null);
});

test('saving an older copy of the file from an editor does not deploy the old entries again', async (t) => {
  const { calls, project, write, settle } = await setup(t);
  project('web');
  project('api');
  write([{ app: 1, src: 'web' }]);
  const [done] = await settle();

  // The editor still shows the entry as it was typed; a second line is added and the file saved.
  write([{ app: 1, src: 'web' }, { app: 1, src: 'api' }]);
  const entries = await settle();
  assert.equal(builds(calls).length, 2, 'only the new entry was built');
  assert.equal(entries[0].id, done.id);
  assert.equal(entries[0].status, 'verified');
  assert.equal(entries[1].status, 'verified');
  assert.notEqual(entries[1].id, done.id);
});

test('"cancel": true on a waiting entry cancels it before it starts', async (t) => {
  const { store, calls, queue, project, write, read } = await setup(t, { fake: { BUILD_MS: 20_000 } });
  project('one');
  project('two');
  write([{ app: 1, src: 'one' }, { app: 1, src: 'two' }]);
  queue.sync({ trigger: true });
  while (!builds(calls).length) await new Promise((resolve) => setTimeout(resolve, 25));
  queue.sync();
  assert.deepEqual(read().map((entry) => entry.status), ['running', 'waiting']);

  const entries = read();
  write([{ ...entries[0], cancel: true }, { ...entries[1], cancel: true }]);
  for (let attempt = 0; attempt < 200 && queue.open; attempt++) {
    queue.sync();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = read();
  assert.deepEqual(after.map((entry) => entry.status), ['cancelled', 'cancelled']);
  assert.match(after[1].error, /waiting in the queue/);
  assert.equal(builds(calls).length, 1, 'the waiting entry never built');
  assert.deepEqual(store.activeDeployments(), []);
});

test('without the watcher\'s say-so, new entries are left alone', async (t) => {
  const { calls, queue, project, write, read } = await setup(t);
  project('web');
  write([{ app: 1, src: 'web' }]);
  queue.sync();
  assert.deepEqual(read(), [{ app: 1, src: 'web' }]);
  assert.equal(queue.view().entries[0].status, 'new');
  assert.deepEqual(calls(), []);
});

test('deploys started elsewhere are added to the file, once', async (t) => {
  const { store, vault, app, queue, read, settle } = await setup(t);
  const { record } = startDeployment({ store, vault, app, trigger: 'cli', options: { noCache: true } });
  queue.record(record, app);
  queue.record(record, app);
  assert.deepEqual(read().map((entry) => [entry.app, entry.noCache, entry.status]), [[1, true, 'running']]);
  const entries = await settle();
  assert.deepEqual(entries.map((entry) => [entry.id, entry.status]), [[record.id, 'verified']]);
  const row = queue.view().entries[0];
  assert.deepEqual([row.appName, row.appId, row.deploy], ['Demo', app.id, 1]);
});

test('the first queue file at the standard place starts with the deploys already made', async (t) => {
  const home = tempDir(t);
  const store = new Store(home);
  const vault = new Vault(home, { backend: 'keyfile' });
  const app = store.createApp({ name: 'Demo', registry: 'registry.xo.builders', repository: 'tools-custom-3000-2-xo-lx670um/app', username: USER, contextDir: sourceDir(t) });
  const past = store.createDeployment(app);
  Object.assign(past, { status: 'succeeded', digest: DIGEST, verify: { status: 'verified' }, durationMs: 54_000 });
  delete past.url; // a deploy recorded before addresses were kept
  store.saveDeployment(past);

  const queue = new QueueFile({ store, vault });
  const entries = queue.sync({ trigger: true });
  assert.equal(queue.file, path.join(home, 'queue.json'));
  assert.deepEqual(entries.map((entry) => [entry.app, entry.id, entry.status, entry.took, entry.image]), [[1, past.id, 'verified', '54s', DIGEST]]);
  assert.equal(store.countDeployments(app.id), 1, 'old deploys are listed, not run again');
  assert.equal(entries[0].url, 'https://tools-custom-3000-2-xo-lx670um.apps.hello-xo.nl');

  // A finished entry written before addresses existed gets its address on the next sync.
  const bare = JSON.parse(fs.readFileSync(queue.file, 'utf8')).map(({ url, ...rest }) => rest);
  fs.writeFileSync(queue.file, JSON.stringify(bare));
  assert.equal(queue.sync()[0].url, 'https://tools-custom-3000-2-xo-lx670um.apps.hello-xo.nl');
  assert.match(fs.readFileSync(queue.file, 'utf8'), /"url": "https:\/\/tools-custom-3000-2-xo-lx670um\.apps\.hello-xo\.nl"/);
});

test('the address is written once the deploy has succeeded: the app\'s own live address, or none for an unknown registry', async (t) => {
  const { store, app, write, read, settle } = await setup(t, { fake: { BUILD_MS: 300 } });
  write([{ app: 1 }]);
  const [plain] = await settle();
  assert.equal(plain.status, 'verified');
  assert.equal('url' in plain, false, 'a registry on this machine has no Launchpad address');

  store.updateApp(app.id, { liveUrl: 'https://demo.example.com' });
  write([...read(), { app: 1 }]);
  // While it runs there is no address yet; it appears with the result.
  const queue = new QueueFile({ store, vault: new Vault(store.home, { backend: 'keyfile' }) });
  queue.sync({ trigger: true });
  assert.equal('url' in read()[1], false);
  const entries = await settle();
  assert.equal(entries[1].url, 'https://demo.example.com/');
});

test('an entry without an app goes to the app that already has that folder, otherwise to a free one', async (t) => {
  const { store, vault, app, queue, project, write, read, settle } = await setup(t);
  const spare = (name) => store.createApp({ name, registry: app.registry, repository: 'demo-xo-abc123/app', tag: name.toLowerCase(), username: USER, contextDir: store.getApp(app.id).contextDir });
  const two = spare('Two');
  const three = spare('Three');
  await vault.set(three.id, PASSWORD); // app 2 has no password, so it cannot be picked
  project('web');
  project('api');
  project('docs');

  // Nothing deployed yet: the lowest-numbered free app with a password takes the folder.
  write([{ src: 'web' }]);
  let entries = await settle();
  assert.deepEqual([entries[0].app, entries[0].status], [1, 'verified']);
  assert.deepEqual(Object.keys(entries[0]).slice(0, 2), ['src', 'app'], 'the chosen app is written onto the entry');

  // The same folder again is a redeploy of that app; a new folder gets the next free app.
  write([...read(), { src: 'web' }, { src: 'api' }]);
  entries = await settle();
  assert.deepEqual(entries.map((entry) => entry.app), [1, 1, 3]);
  assert.equal(store.countDeployments(app.id), 2);
  assert.equal(store.countDeployments(three.id), 1);
  assert.equal(store.countDeployments(two.id), 0);

  // Nothing free with a password: refused, and no app in use is taken over.
  write([...read(), { src: 'docs' }, {}]);
  entries = await settle();
  assert.equal(entries[3].status, 'rejected');
  assert.match(entries[3].error, /No app is available: app 2 is unused but has no password stored yet/);
  assert.equal('app' in entries[3], false);
  assert.match(entries[4].error, /needs "src"/);
  assert.throws(() => queue.add({ src: 'docs' }), /No app is available/);
  assert.throws(() => queue.add({}), /Give the folder to deploy/);

  // With its password stored, app 2 becomes available, through the endpoint's path too.
  await vault.set(two.id, PASSWORD);
  const added = queue.add({ src: 'docs' }, { trigger: true });
  assert.equal(added.app, 2);
  await settle();

  // Everything is in use now, but a folder an app already has is still accepted, by full path too.
  assert.throws(() => queue.add({ src: project('new') }), /No app is available: all 3 already serve a project/);
  assert.equal(queue.add({ src: path.join(queue.folder, 'web') }, { trigger: true }).app, 1);
  await settle();
});

test('a deploy that failed before the push leaves its app free for another folder', async (t) => {
  const { store, vault, app, project, write, read, settle } = await setup(t);
  project('web');
  project('api');
  await vault.set(app.id, 'wrong-password');
  write([{ src: 'web' }]);
  assert.equal((await settle())[0].status, 'failed');
  await vault.set(app.id, PASSWORD);
  write([...read(), { src: 'api' }]);
  const entries = await settle();
  assert.deepEqual([entries[1].app, entries[1].status], [1, 'verified']);
  assert.match(store.getApp(app.id).contextDir, /api$/);
});

/** A small git repository with a Dockerfile, reachable by a file:// address. */
function makeRepo(t, name) {
  const dir = path.join(tempDir(t, 'liftoff-origin-'), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'pipe' });
  git('init');
  git('add', '.');
  git('commit', '-m', 'first');
  return { dir, url: pathToFileURL(dir).href, git };
}

test('a repository address is cloned beside the queue file, then deployed; the copy is reused next time', async (t) => {
  const { store, app, calls, queue, write, read, settle, projects } = await setup(t);
  const origin = makeRepo(t, 'shop-front');
  write([{ app: 1, src: origin.url }]);
  let entries = await settle();
  assert.equal(entries[0].status, 'verified', entries[0].error);
  assert.equal(entries[0].src, origin.url, 'the entry keeps the address as typed');

  const copy = path.join(projects, 'shop-front');
  assert.equal(fs.existsSync(path.join(copy, '.git')), true);
  assert.equal(real(builds(calls)[0].cwd), real(copy));
  assert.equal(real(store.getApp(app.id).contextDir), real(copy));
  const record = store.findDeployment(entries[0].id);
  assert.match(store.readLog(app.id, record.id).map((line) => line.m).join('\n'), /git clone --progress -- file:\/\/\S+shop-front/);
  assert.ok(record.git?.commit, 'the deployed commit is recorded');

  // The origin moves on and the local copy gets a change of its own: the next deploy uses the copy as it is.
  fs.writeFileSync(path.join(origin.dir, 'new.txt'), 'newer');
  origin.git('add', '.');
  origin.git('commit', '-m', 'second');
  fs.writeFileSync(path.join(copy, 'local-only.txt'), 'kept');
  write([...read(), { src: origin.url }]);
  entries = await settle();
  assert.deepEqual([entries[1].app, entries[1].status], [1, 'verified'], 'without an app it goes back to the app that has this copy');
  assert.equal(fs.existsSync(path.join(copy, 'local-only.txt')), true);
  assert.equal(fs.existsSync(path.join(copy, 'new.txt')), false, 'an existing copy is not updated');
  assert.match(store.readLog(app.id, entries[1].id).map((line) => line.m).join('\n'), /using the copy already in .*shop-front \(not updated\)/);
  assert.equal(queue.add({ app: 1, src: origin.url }).src, origin.url, 'the endpoint accepts an address without the folder existing');
});

test('a branch can be named, and a clone that fails leaves nothing behind', async (t) => {
  const { calls, write, read, settle, projects, store } = await setup(t);
  const origin = makeRepo(t, 'api');
  origin.git('checkout', '-b', 'staging');
  fs.writeFileSync(path.join(origin.dir, 'staging.txt'), 'only here');
  origin.git('add', '.');
  origin.git('commit', '-m', 'staging work');
  origin.git('checkout', 'main');

  write([{ app: 1, src: `${origin.url}#staging` }]);
  let entries = await settle();
  assert.equal(entries[0].status, 'verified', entries[0].error);
  assert.equal(fs.existsSync(path.join(projects, 'api', 'staging.txt')), true);
  assert.equal(store.findDeployment(entries[0].id).git.branch, 'staging');

  const missing = pathToFileURL(path.join(projects, 'no-such-origin', 'ghost')).href;
  write([...read(), { app: 1, src: missing }]);
  entries = await settle();
  assert.equal(entries[1].status, 'failed');
  assert.match(entries[1].error, /^Could not clone file:\/\//);
  assert.equal(fs.existsSync(path.join(projects, 'ghost')), false);
  assert.equal(builds(calls).length, 1, 'nothing was built for the failed clone');
});

test('a folder of that name holding another repository stops the deploy', async (t) => {
  const { calls, write, settle, projects } = await setup(t);
  const wanted = makeRepo(t, 'web');
  const other = makeRepo(t, 'web');
  execFileSync('git', ['clone', '--quiet', other.url, path.join(projects, 'web')], { stdio: 'pipe' });
  write([{ app: 1, src: wanted.url }]);
  const [entry] = await settle();
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /already exists but holds a different repository/);
  assert.deepEqual(builds(calls), []);
});

test('a failed deploy gets no address', async (t) => {
  const { store, app, write, settle } = await setup(t, { fake: { BUILD_FAIL: 1 } });
  store.updateApp(app.id, { liveUrl: 'https://demo.example.com' });
  write([{ app: 1 }]);
  const [entry] = await settle();
  assert.equal(entry.status, 'failed');
  assert.equal('url' in entry, false);
});

test('only one watcher per data folder starts entries', async (t) => {
  const { queue } = await setup(t);
  const first = new QueueWatcher(queue, { intervalMs: 10_000 }).start();
  t.after(() => first.stop());
  assert.equal(first.owner, true);
  assert.equal(Number(fs.readFileSync(first.lockFile, 'utf8')), process.pid);

  // A lock held by a process that no longer exists is taken over.
  first.stop();
  fs.writeFileSync(first.lockFile, String(2 ** 30));
  const second = new QueueWatcher(queue, { intervalMs: 10_000 }).start();
  t.after(() => second.stop());
  assert.equal(second.owner, true);
  second.stop();
  assert.equal(fs.existsSync(second.lockFile), false);
});
