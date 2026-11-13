import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDeployment, testLogin } from '../src/pipeline.js';
import { Store, ValidationError } from '../src/store.js';
import { Vault } from '../src/vault.js';
import { sha256, sourceDir, startRegistry, tempDir, useFakeDocker } from './helpers.js';

const USER = 'xo-demo-xo-abc123+push';
const PASSWORD = 'correct horse battery staple';
const MANIFEST = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });
const DIGEST = sha256(MANIFEST);
const real = (dir) => fs.realpathSync.native(dir);
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`liftoff-docker-${process.pid}-`));

/** An app, a registry that knows its image, a stored password, and the stand-in docker. */
async function setup(t, { registry: registryOptions = {}, fake = {}, storePassword = true, app: appExtra = {} } = {}) {
  const home = tempDir(t);
  const store = new Store(home);
  const vault = new Vault(home, { backend: 'keyfile' });
  const registry = await startRegistry(t, { user: USER, password: PASSWORD, manifests: { 'demo-xo-abc123/app:latest': MANIFEST }, ...registryOptions });
  const calls = useFakeDocker(t, { USER, PASSWORD, DIGEST, ...fake });
  const app = store.createApp({ name: 'Demo', registry: registry.host, repository: 'demo-xo-abc123/app', username: USER, contextDir: sourceDir(t), ...appExtra });
  if (storePassword) await vault.set(app.id, PASSWORD);
  return { home, store, vault, app, registry, calls };
}

const statuses = (record) => Object.fromEntries(record.steps.map((step) => [step.key, step.status]));
const logText = (store, record) => store.readLog(record.appId, record.id).map((entry) => `${entry.s}|${entry.m}`).join('\n');

test('a deploy logs in, builds, pushes and confirms the image in the registry', async (t) => {
  const { store, vault, app, calls, home } = await setup(t);
  const events = [];
  const { record, done } = startDeployment({ store, vault, app, trigger: 'cli', onEvent: (event) => events.push(event.type) });
  assert.equal(record.command, `deploy ${app.id}`);
  const final = await done;

  assert.equal(final.status, 'succeeded', final.error);
  assert.deepEqual(statuses(final), { preflight: 'ok', login: 'ok', build: 'ok', push: 'ok', verify: 'ok' });
  assert.equal(final.digest, DIGEST);
  assert.deepEqual({ status: final.verify.status, digest: final.verify.registryDigest }, { status: 'verified', digest: DIGEST });
  assert.equal(final.builtPlatform, 'linux/amd64');
  assert.equal(final.imageSize, 12345);
  assert.equal(final.trigger, 'cli');
  assert.ok(final.durationMs >= 0 && final.finishedAt);
  assert.ok(events.includes('log') && events.includes('record'));
  assert.deepEqual(store.getDeployment(app.id, record.id), final);

  const [login, build, push] = ['login', 'build', 'push'].map((name) => calls().find((call) => call.cmd === name));

  // The password went in over stdin, into a private config that is gone again.
  assert.equal(login.passwordOnCommandLine, false);
  assert.equal(login.user, USER);
  assert.match(path.basename(login.config), /^liftoff-docker-\d+-/);
  assert.equal(fs.existsSync(login.config), false);
  assert.equal(login.host, 'npipe:////./pipe/fake_engine');

  // The build is the plain command, run in the source folder with your normal Docker settings.
  assert.deepEqual(build.args, ['build', '--platform', 'linux/amd64', '-t', final.image, '.']);
  assert.equal(real(build.cwd), real(app.contextDir));
  assert.equal(build.config, process.env.DOCKER_CONFIG ?? null);

  // The push had the login, in a second private config, also gone, on the same engine.
  assert.equal(push.loggedIn, true);
  assert.notEqual(push.config, login.config);
  assert.equal(fs.existsSync(push.config), false);
  assert.equal(push.host, login.host);
  assert.deepEqual(leftovers(), []);

  // Nothing Liftoff wrote contains the password in any form.
  const written = [logText(store, final), JSON.stringify(final), fs.readFileSync(path.join(home, 'apps.json'), 'utf8'), fs.readFileSync(path.join(home, 'vault.json'), 'utf8')].join('\n');
  for (const form of [PASSWORD, Buffer.from(PASSWORD).toString('base64'), Buffer.from(`${USER}:${PASSWORD}`).toString('base64')]) {
    assert.ok(!written.includes(form));
  }
});

test('the log shows the commands, hides docker\'s stock storage warning and strips colour codes', async (t) => {
  const { store, vault, app } = await setup(t);
  const final = await startDeployment({ store, vault, app }).done;
  const text = logText(store, final);
  assert.match(text, /cmd\|docker login 127\.0\.0\.1:\d+ -u xo-demo-xo-abc123\+push --password-stdin/);
  assert.match(text, /cmd\|docker build --platform linux\/amd64 -t \S+ \./);
  assert.match(text, /cmd\|docker push /);
  assert.match(text, /out\|Login Succeeded/);
  assert.ok(!/stored unencrypted in|credential helper/.test(text));
  assert.match(text, /err\|#2 coloured tool output/);
  assert.ok(!text.includes('\x1b'));
  assert.match(text, /sys\|Verified: /);
});

test('dockerfile, extra flags and "skip cache" reach docker build', async (t) => {
  const { store, vault, app, calls } = await setup(t, { app: { dockerfile: 'deploy/prod.Dockerfile', buildFlags: '--build-arg "GREETING=hello world" --target runner' } });
  fs.mkdirSync(path.join(app.contextDir, 'deploy'));
  fs.writeFileSync(path.join(app.contextDir, 'deploy', 'prod.Dockerfile'), 'FROM scratch\n');
  const final = await startDeployment({ store, vault, app, options: { noCache: true } }).done;
  assert.equal(final.status, 'succeeded', final.error);
  assert.deepEqual(calls().find((call) => call.cmd === 'build').args, [
    'build', '--platform', 'linux/amd64', '-t', final.image, '-f', 'deploy/prod.Dockerfile', '--no-cache',
    '--build-arg', 'GREETING=hello world', '--target', 'runner', '.',
  ]);
  assert.match(logText(store, final), /--build-arg "GREETING=hello world"/);
});

test('a wrong password stops at login: nothing is built or pushed', async (t) => {
  const { store, vault, app, calls } = await setup(t);
  await vault.set(app.id, 'not-the-password');
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.deepEqual(statuses(final), { preflight: 'ok', login: 'failed', build: 'skipped', push: 'skipped', verify: 'skipped' });
  assert.match(final.error, /rejected the username or password for xo-demo-xo-abc123\+push/);
  assert.deepEqual(calls().map((call) => call.cmd), ['login']);
  assert.ok(!logText(store, final).includes('not-the-password'));
  assert.deepEqual(leftovers(), []);
});

test('a failed build is not pushed, and says why', async (t) => {
  const { store, vault, app, calls } = await setup(t, { fake: { BUILD_FAIL: 1 } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.deepEqual(statuses(final), { preflight: 'ok', login: 'ok', build: 'failed', push: 'skipped', verify: 'skipped' });
  assert.match(final.error, /^docker build failed: failed to solve: .*exit code: 3/);
  assert.ok(!calls().some((call) => call.cmd === 'push'));
});

test('an image built for the wrong machine type is not pushed', async (t) => {
  const { store, vault, app, calls } = await setup(t, { fake: { ARCH: 'arm64' } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.equal(statuses(final).build, 'failed');
  assert.match(final.error, /came out as linux\/arm64, not linux\/amd64/);
  assert.ok(!calls().some((call) => call.cmd === 'push'));
});

test('a refused push is explained', async (t) => {
  const { store, vault, app } = await setup(t, { fake: { PUSH_DENIED: 1 } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.equal(statuses(final).push, 'failed');
  assert.match(final.error, /refused the push to demo-xo-abc123\/app/);
  assert.deepEqual(leftovers(), []);
});

test('if the registry holds a different image after the push, the deploy fails', async (t) => {
  const { store, vault, app } = await setup(t, { fake: { DIGEST: sha256('something else') } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.equal(statuses(final).verify, 'failed');
  assert.equal(final.verify.status, 'mismatch');
  assert.match(final.error, /Something else pushed to this tag/);
});

test('if the tag is missing after the push, the deploy fails', async (t) => {
  const { store, vault, app } = await setup(t, { registry: { manifests: {} } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'failed');
  assert.equal(final.verify.status, 'missing');
});

test('when the account may not read the tag back, the deploy still counts, marked unconfirmed', async (t) => {
  const { store, vault, app } = await setup(t, { registry: { readable: false } });
  const final = await startDeployment({ store, vault, app }).done;
  assert.equal(final.status, 'succeeded');
  assert.equal(statuses(final).verify, 'warn');
  assert.equal(final.verify.status, 'unconfirmed');
  assert.match(final.verify.detail, /not allowed to read/);
  assert.equal(final.digest, DIGEST);
});

test('checks come first: no password, no Dockerfile, no folder, no Docker', async (t) => {
  await t.test('no password stored', async (t) => {
    const { store, vault, app, calls } = await setup(t, { storePassword: false });
    const final = await startDeployment({ store, vault, app }).done;
    assert.equal(final.status, 'failed');
    assert.equal(statuses(final).preflight, 'failed');
    assert.match(final.error, /No password is stored/);
    assert.deepEqual(calls(), []);
  });
  await t.test('no Dockerfile', async (t) => {
    const { store, vault, app } = await setup(t);
    fs.rmSync(path.join(app.contextDir, 'Dockerfile'));
    assert.match((await startDeployment({ store, vault, app }).done).error, /There is no Dockerfile at/);
  });
  await t.test('no folder', async (t) => {
    const { store, vault, app } = await setup(t, { app: { contextDir: path.join(os.tmpdir(), 'liftoff-does-not-exist') } });
    assert.match((await startDeployment({ store, vault, app }).done).error, /source folder does not exist/);
  });
  await t.test('Docker not running', async (t) => {
    const { store, vault, app, calls } = await setup(t, { fake: { DOWN: 1 } });
    const final = await startDeployment({ store, vault, app }).done;
    assert.match(final.error, /Docker is not available: the Docker engine is not running/);
    assert.ok(!calls().some((call) => call.cmd === 'login'));
  });
});

test('cancelling stops the build and nothing is pushed', async (t) => {
  const { store, vault, app, calls } = await setup(t, { fake: { BUILD_MS: 20_000 } });
  const { record, done } = startDeployment({ store, vault, app });
  while (!calls().some((call) => call.cmd === 'build')) await new Promise((resolve) => setTimeout(resolve, 25));
  const asked = Date.now();
  store.requestCancel(app.id, record.id);
  const final = await done;
  assert.ok(Date.now() - asked < 8000, 'cancel should not wait for the build to end');
  assert.equal(final.status, 'cancelled');
  assert.deepEqual(statuses(final), { preflight: 'ok', login: 'ok', build: 'cancelled', push: 'skipped', verify: 'skipped' });
  assert.ok(!calls().some((call) => call.cmd === 'push'));
  assert.equal(store.cancelRequested(app.id, record.id), false);
  assert.deepEqual(leftovers(), []);
});

test('the process that runs a deploy can cancel it directly', async (t) => {
  const { store, vault, app, calls } = await setup(t, { fake: { BUILD_MS: 20_000 } });
  const { done, cancel } = startDeployment({ store, vault, app });
  while (!calls().some((call) => call.cmd === 'build')) await new Promise((resolve) => setTimeout(resolve, 25));
  cancel();
  const final = await done;
  assert.equal(final.status, 'cancelled');
  assert.equal(statuses(final).build, 'cancelled');
  assert.equal(final.error, 'Cancelled before it finished.');
});

test('a second deploy waits in the queue and starts when the first is done', async (t) => {
  const { store, vault, app } = await setup(t, { fake: { BUILD_MS: 600 } });
  const first = startDeployment({ store, vault, app });
  const second = startDeployment({ store, vault, app, options: { noCache: true } });
  assert.equal(second.record.number, 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(store.activeDeployments().map((record) => record.status).sort(), ['queued', 'running']);
  assert.equal(store.getDeployment(app.id, second.record.id).status, 'queued');

  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(b.status, 'succeeded', b.error);
  assert.ok(Date.parse(b.startedAt) >= Date.parse(a.finishedAt), 'the second must not start before the first ended');
  assert.ok(Date.parse(b.queuedAt) < Date.parse(b.startedAt));
  assert.match(logText(store, b), /sys\|Waiting in the queue behind 1 other deploy/);
  assert.deepEqual(store.activeDeployments(), []);
  assert.deepEqual(store.recentDeployments().map((record) => record.command).sort(), [`deploy ${app.id}`, `deploy ${app.id} --no-cache`]);
});

test('a waiting deploy can be cancelled without ever starting', async (t) => {
  const { store, vault, app, calls } = await setup(t, { fake: { BUILD_MS: 20_000 } });
  const first = startDeployment({ store, vault, app });
  const second = startDeployment({ store, vault, app });
  while (!calls().some((call) => call.cmd === 'build')) await new Promise((resolve) => setTimeout(resolve, 25));
  store.requestCancel(app.id, second.record.id);
  const waited = await second.done;
  assert.equal(waited.status, 'cancelled');
  assert.equal(waited.error, 'Cancelled while waiting in the queue.');
  assert.ok(waited.steps.every((step) => step.status === 'skipped'));
  assert.equal(calls().filter((call) => call.cmd === 'login').length, 1, 'the cancelled deploy never ran docker');
  first.cancel();
  assert.equal((await first.done).status, 'cancelled');
  assert.deepEqual(store.activeDeployments(), []);
});

test('--src switches the app to another source folder and deploys from it', async (t) => {
  const { store, vault, app, calls } = await setup(t);
  const other = sourceDir(t);
  const final = await startDeployment({ store, vault, app, options: { src: other } }).done;
  assert.equal(final.status, 'succeeded', final.error);
  assert.equal(real(calls().find((call) => call.cmd === 'build').cwd), real(other));
  assert.equal(real(store.getApp(app.id).contextDir), real(other));
  assert.equal(real(final.contextDir), real(other));
  assert.match(final.command, new RegExp(`^deploy ${app.id} --src `));

  // The next deploy without --src keeps using the new folder.
  const next = await startDeployment({ store, vault, app: store.getApp(app.id) }).done;
  assert.equal(real(calls().filter((call) => call.cmd === 'build')[1].cwd), real(other));
  assert.equal(next.command, `deploy ${app.id}`);

  // A folder that is not there changes nothing and queues nothing.
  assert.throws(() => startDeployment({ store, vault, app, options: { src: path.join(other, 'missing') } }), ValidationError);
  assert.throws(() => startDeployment({ store, vault, app, options: { src: 'relative/folder' } }), ValidationError);
  assert.equal(real(store.getApp(app.id).contextDir), real(other));
  assert.equal(store.countDeployments(app.id), 2);
});

test('"test login" checks the stored password without building anything', async (t) => {
  const { vault, app, calls } = await setup(t);
  assert.deepEqual(await testLogin({ app, vault }), { ok: true, message: `${app.registry} accepted ${USER}.` });
  await vault.set(app.id, 'nope');
  const bad = await testLogin({ app, vault });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected the username or password/);
  vault.delete(app.id);
  assert.match((await testLogin({ app, vault })).message, /No password is stored/);
  assert.deepEqual([...new Set(calls().map((call) => call.cmd))], ['login']);
  assert.deepEqual(leftovers(), []);
});
