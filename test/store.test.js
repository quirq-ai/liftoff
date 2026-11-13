import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NotFoundError, normalizeApp, Store, ValidationError } from '../src/store.js';
import { tempDir } from './helpers.js';

const sample = (extra = {}) => ({
  name: 'Floating Containers',
  registry: 'registry.xo.builders',
  repository: 'test-floating-containers-xo-n6d5yb4/app',
  username: 'xo-test-floating-containers-xo-n6d5yb4+push',
  contextDir: path.resolve('some', 'project'),
  ...extra,
});

test('an app takes its id from the Launchpad slug and gets sensible defaults', (t) => {
  const store = new Store(tempDir(t));
  const app = store.createApp(sample());
  assert.equal(app.id, 'test-floating-containers-xo-n6d5yb4');
  assert.equal(app.tag, 'latest');
  assert.equal(app.platform, 'linux/amd64');
  assert.deepEqual(store.listApps().map((entry) => entry.id), [app.id]);
  assert.ok(!('password' in app));
});

test('each app gets a number once; numbers are never reused, and older data is numbered by age', (t) => {
  const home = tempDir(t);
  const store = new Store(home);
  const one = store.createApp(sample());
  const two = store.createApp(sample({ name: 'Second', repository: 'second-xo-abc123/app' }));
  assert.deepEqual([one.number, two.number], [1, 2]);
  assert.equal(store.updateApp(two.id, { name: 'Renamed' }).number, 2);
  assert.equal(store.findApp('2').id, two.id);
  assert.equal(store.findApp('#1').id, one.id);
  store.deleteApp(two.id);
  assert.equal(store.createApp(sample({ name: 'Third', repository: 'third-xo-abc123/app' })).number, 3);

  // Data written before apps had numbers.
  const old = tempDir(t);
  fs.writeFileSync(path.join(old, 'apps.json'), JSON.stringify({ version: 1, apps: [
    { ...sample({ name: 'Newer', repository: 'newer/app' }), id: 'newer', tag: 'latest', platform: 'linux/amd64', createdAt: '2026-02-01T00:00:00Z' },
    { ...sample({ name: 'Older', repository: 'older/app' }), id: 'older', tag: 'latest', platform: 'linux/amd64', createdAt: '2026-01-01T00:00:00Z' },
  ] }));
  const migrated = new Store(old);
  assert.deepEqual(migrated.listApps().map((app) => [app.name, app.number]), [['Newer', 2], ['Older', 1]]);
  assert.deepEqual(migrated.listApps().map((app) => app.number), [2, 1], 'numbers stay the same on the next read');
});

test('the queue file has a standard place and can be moved', (t) => {
  const home = tempDir(t);
  const store = new Store(home);
  assert.equal(store.queueFile(), path.join(home, 'queue.json'));
  const elsewhere = path.join(tempDir(t), 'queue.json');
  assert.equal(store.setQueueFile(elsewhere), elsewhere);
  assert.equal(new Store(home).queueFile(), elsewhere);
  assert.throws(() => store.setQueueFile('queue.json'), ValidationError);
  assert.throws(() => store.setQueueFile(path.join(home, 'queue.txt')), ValidationError);
});

test('settings never include a password, even when one is passed in', (t) => {
  const home = tempDir(t);
  const store = new Store(home);
  store.createApp(sample({ password: 'do-not-store-me' }));
  assert.ok(!fs.readFileSync(path.join(home, 'apps.json'), 'utf8').includes('do-not-store-me'));
});

test('two apps cannot deploy to the same image, but ids stay unique for the same slug', (t) => {
  const store = new Store(tempDir(t));
  store.createApp(sample());
  assert.throws(() => store.createApp(sample({ name: 'Twin' })), ValidationError);
  const staging = store.createApp(sample({ name: 'Staging', tag: 'staging' }));
  assert.equal(staging.id, 'test-floating-containers-xo-n6d5yb4-2');
});

test('every bad field is reported at once', () => {
  try {
    normalizeApp({ name: '', registry: 'Not A Host', repository: 'UPPER/case', username: 'has space', contextDir: 'relative/path', platform: 'amd64', liveUrl: 'ftp://x', buildFlags: '--push', tag: 'bad tag' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(Object.keys(error.fields).sort(), ['buildFlags', 'contextDir', 'liveUrl', 'name', 'platform', 'registry', 'repository', 'tag', 'username']);
  }
});

test('tidies what people paste', () => {
  const app = normalizeApp(sample({ registry: ' https://Registry.XO.builders/ ', repository: '/team/app/', liveUrl: 'https://example.com', contextDir: `${path.resolve('x')}${path.sep}` }));
  assert.equal(app.registry, 'registry.xo.builders');
  assert.equal(app.repository, 'team/app');
  assert.equal(app.liveUrl, 'https://example.com/');
  assert.equal(app.contextDir, path.resolve('x'));
});

test('build flags that would fight the pipeline are refused, others pass', () => {
  for (const flags of ['-t other', '--tag=x', '--platform linux/arm64', '-f x', '--push', '--output type=registry', '"unclosed']) {
    assert.throws(() => normalizeApp(sample({ buildFlags: flags })), ValidationError, flags);
  }
  assert.equal(normalizeApp(sample({ buildFlags: '--build-arg A=1 --target runner' })).buildFlags, '--build-arg A=1 --target runner');
});

test('a username with a colon is refused (it could not be told apart from the password)', () => {
  assert.throws(() => normalizeApp(sample({ username: 'a:b' })), ValidationError);
});

test('editing keeps the id and creation time; removing forgets the history', (t) => {
  const store = new Store(tempDir(t));
  const app = store.createApp(sample());
  const edited = store.updateApp(app.id, { name: 'Renamed', dockerfile: 'deploy/prod.Dockerfile' });
  assert.equal(edited.id, app.id);
  assert.equal(edited.createdAt, app.createdAt);
  assert.equal(edited.name, 'Renamed');
  assert.equal(edited.repository, app.repository);
  const record = store.createDeployment(edited);
  store.deleteApp(app.id);
  assert.deepEqual(store.listApps(), []);
  assert.throws(() => store.getDeployment(app.id, record.id), NotFoundError);
  assert.throws(() => store.updateApp(app.id, { name: 'x' }), NotFoundError);
});

test('finds an app by id, by name, or by the start of its id', (t) => {
  const store = new Store(tempDir(t));
  const first = store.createApp(sample());
  store.createApp(sample({ name: 'Other', repository: 'test-other-xo-abc123/app' }));
  assert.equal(store.findApp(first.id).id, first.id);
  assert.equal(store.findApp('floating containers').id, first.id);
  assert.equal(store.findApp('test-fl').id, first.id);
  assert.throws(() => store.findApp('test-'), /several apps/);
  assert.throws(() => store.findApp('nope'), NotFoundError);
});

test('deploys are numbered per app and listed newest first', async (t) => {
  const store = new Store(tempDir(t));
  const app = store.createApp(sample());
  const first = store.createDeployment(app);
  first.status = 'succeeded';
  store.saveDeployment(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = store.createDeployment(app, { trigger: 'cli', options: { noCache: true } });
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  assert.equal(second.trigger, 'cli');
  assert.deepEqual(second.steps.map((step) => step.key), ['preflight', 'login', 'build', 'push', 'verify']);
  assert.deepEqual(store.listDeployments(app.id).map((record) => record.number), [2, 1]);
  assert.equal(store.latestDeployment(app.id).id, second.id);
  assert.equal(store.countDeployments(app.id), 2);
});

test('a deploy whose process died is closed as failed instead of running forever', (t) => {
  const store = new Store(tempDir(t));
  const app = store.createApp(sample());
  const record = store.createDeployment(app);
  record.pid = 2 ** 30; // no such process
  record.status = 'running';
  record.steps[0].status = 'ok';
  record.steps[1].status = 'running';
  store.saveDeployment(record);
  const seen = store.getDeployment(app.id, record.id);
  assert.equal(seen.status, 'failed');
  assert.match(seen.error, /stopped before this deploy finished/);
  assert.deepEqual(seen.steps.map((step) => step.status), ['ok', 'failed', 'skipped', 'skipped', 'skipped']);
  assert.equal(store.getDeployment(app.id, record.id).status, 'failed');
});

test('a waiting deploy of a live process is left alone', (t) => {
  const store = new Store(tempDir(t));
  const record = store.createDeployment(store.createApp(sample()));
  assert.equal(store.getDeployment(record.appId, record.id).status, 'queued');
});

test('the queue lists what is waiting or running, and drops deploys once they end or their process dies', async (t) => {
  const store = new Store(tempDir(t));
  const one = store.createApp(sample());
  const two = store.createApp(sample({ name: 'Other', repository: 'other-xo-abc123/app' }));
  const first = store.createDeployment(one, { command: `deploy ${one.id} --no-cache` });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = store.createDeployment(two);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = store.createDeployment(one);
  assert.deepEqual(store.activeDeployments().map((record) => record.id), [first.id, second.id, third.id]);
  assert.deepEqual(store.recentDeployments().map((record) => record.id), [third.id, second.id, first.id]);
  assert.deepEqual(store.recentDeployments({ limit: 1 }).map((record) => record.command), [`deploy ${one.id}`]);
  assert.equal(first.command, `deploy ${one.id} --no-cache`);

  first.status = 'succeeded';
  store.saveDeployment(first);
  second.pid = 2 ** 30; // its process is gone
  store.saveDeployment(second);
  assert.deepEqual(store.activeDeployments().map((record) => record.id), [third.id]);
  const lost = store.getDeployment(two.id, second.id);
  assert.equal(lost.status, 'failed');
  assert.match(lost.error, /waiting in the queue/);
  assert.equal(store.recentDeployments().length, 3);
});

test('logs come back in order, and cancel requests are visible to whoever runs the deploy', (t) => {
  const store = new Store(tempDir(t));
  const record = store.createDeployment(store.createApp(sample()));
  const log = store.openLog(record.appId, record.id);
  log.write({ t: 1, step: 'build', s: 'out', m: 'one' });
  log.write({ t: 2, step: 'build', s: 'err', m: 'two — ünïcode' });
  log.close();
  log.write({ t: 3, step: 'build', s: 'out', m: 'after close is ignored' });
  assert.deepEqual(store.readLog(record.appId, record.id).map((entry) => entry.m), ['one', 'two — ünïcode']);

  assert.equal(store.cancelRequested(record.appId, record.id), false);
  store.requestCancel(record.appId, record.id);
  assert.equal(store.cancelRequested(record.appId, record.id), true);
  store.clearCancel(record.appId, record.id);
  assert.equal(store.cancelRequested(record.appId, record.id), false);
});

test('ids that could escape the data folder are refused', (t) => {
  const store = new Store(tempDir(t));
  assert.throws(() => store.getDeployment('..', 'd00000000aaaa'), NotFoundError);
  assert.throws(() => store.getDeployment('app', '../../apps'), NotFoundError);
  assert.throws(() => store.logFile('a/b', 'd00000000aaaa'), NotFoundError);
});
