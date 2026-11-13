import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { sha256, sourceDir, startRegistry, tempDir, useFakeDocker } from './helpers.js';

const USER = 'xo-demo-xo-abc123+push';
const PASSWORD = 'correct horse battery staple';
const MANIFEST = JSON.stringify({ schemaVersion: 2 });

async function startApp(t) {
  process.env.LIFTOFF_VAULT = 'keyfile';
  t.after(() => delete process.env.LIFTOFF_VAULT);
  const home = tempDir(t);
  const instance = createServer({ home, port: 0 });
  const port = await instance.listen();
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  return { home, port, base, call, instance };
}

/** A request with full control over the path and Host header, which fetch does not give. */
function raw(port, { method = 'GET', path: requestPath = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

const appBody = (t, registry, extra = {}) => ({
  name: 'Demo',
  registry: registry?.host ?? 'registry.xo.builders',
  repository: 'demo-xo-abc123/app',
  username: USER,
  contextDir: sourceDir(t),
  ...extra,
});

test('serves the page and the shared parser, and nothing outside its public folder', async (t) => {
  const { call, port } = await startApp(t);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Liftoff<\/title>/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match((await call('GET', '/lib/commands.js')).text, /parseLaunchpadCommands/);
  assert.equal((await call('GET', '/app.js')).status, 200);
  for (const escape of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/src/vault.js', '/lib/vault.js']) {
    assert.equal((await raw(port, { path: escape })).status, 404, escape);
  }
  assert.equal((await call('POST', '/index.html')).status, 405);
});

test('only this machine\'s own Liftoff page may use the API', async (t) => {
  const { call, port } = await startApp(t);
  assert.equal((await call('GET', '/api/state')).status, 200);
  assert.equal((await call('GET', '/api/state', undefined, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await raw(port, { path: '/api/state', headers: { Host: `app.localhost:${port}` } })).status, 200);

  const blocked = [
    { headers: { Origin: 'https://evil.example' } },
    { headers: { Origin: `http://localhost:${port + 1}` } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { 'Sec-Fetch-Site': 'same-site' } },
  ];
  for (const { headers } of blocked) {
    assert.equal((await call('POST', '/api/apps', {}, headers)).status, 403, JSON.stringify(headers));
    assert.equal((await call('GET', '/api/state', undefined, headers)).status, 403, JSON.stringify(headers));
  }
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port}.evil.example`, 'localhost']) {
    assert.equal((await raw(port, { path: '/api/state', headers: { Host: host } })).status, 403, host);
  }
  // A plain HTML form cannot send JSON, so form posts from other pages get nowhere either.
  const form = await fetch(`http://127.0.0.1:${port}/api/apps`, { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal((await call('GET', '/api/state')).headers.get('access-control-allow-origin'), null);
});

test('apps can be added, edited and removed; the password goes in but never comes out', async (t) => {
  const { call, instance } = await startApp(t);
  const created = await call('POST', '/api/apps', appBody(t, null, { password: `  ${PASSWORD}\n` }));
  assert.equal(created.status, 201);
  const { app } = created.json;
  assert.equal(app.id, 'demo-xo-abc123');
  assert.equal(app.image, 'registry.xo.builders/demo-xo-abc123/app:latest');
  assert.equal(app.hasPassword, true);
  assert.deepEqual(app.folder, { exists: true, hasDockerfile: true });
  assert.equal(await instance.vault.get(app.id), PASSWORD);

  const state = await call('GET', '/api/state');
  assert.equal(state.json.apps.length, 1);
  assert.equal(state.json.meta.vault.backend, 'keyfile');
  assert.match(state.json.meta.cli, /liftoff\.js/);
  for (const response of [created, state]) assert.ok(!response.text.includes(PASSWORD));

  const edited = await call('PUT', `/api/apps/${app.id}`, { name: 'Renamed', liveUrl: 'https://demo.example.com' });
  assert.equal(edited.json.app.name, 'Renamed');
  assert.equal(edited.json.app.hasPassword, true, 'editing without a password keeps the stored one');
  assert.equal(await instance.vault.get(app.id), PASSWORD);

  assert.equal((await call('PUT', `/api/apps/${app.id}/password`, { password: 'new-one' })).status, 200);
  assert.equal(await instance.vault.get(app.id), 'new-one');
  const empty = await call('PUT', `/api/apps/${app.id}/password`, { password: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.json.fields.password, /required/);

  assert.equal((await call('DELETE', `/api/apps/${app.id}/password`)).json.app.hasPassword, false);
  assert.equal((await call('DELETE', `/api/apps/${app.id}`)).status, 200);
  assert.equal((await call('GET', '/api/state')).json.apps.length, 0);
  assert.equal((await call('GET', `/api/apps/${app.id}/deployments`)).status, 404);
});

test('bad input comes back with a message per field', async (t) => {
  const { call } = await startApp(t);
  const bad = await call('POST', '/api/apps', { name: '', registry: 'x y', repository: 'UP', username: '', contextDir: 'relative' });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json.fields).sort(), ['contextDir', 'name', 'registry', 'repository', 'username']);
  assert.equal((await call('POST', '/api/apps', undefined)).status, 415);
  const notJson = await fetch(`${(await startApp(t)).base}/api/apps`, { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(notJson.status, 400);
  assert.equal((await call('GET', '/api/apps/nope/deployments')).status, 404);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('the folder check tells the form what it found', async (t) => {
  const { call } = await startApp(t);
  const dir = sourceDir(t);
  assert.deepEqual((await call('POST', '/api/check-folder', { dir })).json, { absolute: true, exists: true, hasDockerfile: true });
  assert.deepEqual((await call('POST', '/api/check-folder', { dir, dockerfile: 'other.Dockerfile' })).json, { absolute: true, exists: true, hasDockerfile: false });
  assert.deepEqual((await call('POST', '/api/check-folder', { dir: path.join(dir, 'missing') })).json, { absolute: true, exists: false, hasDockerfile: false });
  assert.equal((await call('POST', '/api/check-folder', { dir: 'relative' })).json.absolute, false);
});

test('a deploy started from the page streams its output and ends verified', async (t) => {
  const registry = await startRegistry(t, { user: USER, password: PASSWORD, manifests: { 'demo-xo-abc123/app:latest': MANIFEST } });
  useFakeDocker(t, { USER, PASSWORD, DIGEST: sha256(MANIFEST), BUILD_MS: 300 });
  const { call, base, home } = await startApp(t);
  const { app } = (await call('POST', '/api/apps', appBody(t, registry, { password: PASSWORD }))).json;

  assert.deepEqual((await call('POST', `/api/apps/${app.id}/test-login`)).json, { ok: true, message: `${registry.host} accepted ${USER}.` });

  const started = await call('POST', `/api/apps/${app.id}/deploy`, {});
  assert.equal(started.status, 202);
  const { deployment } = started.json;
  assert.equal(deployment.command, `deploy ${app.id}`);
  const badSource = await call('POST', `/api/apps/${app.id}/deploy`, { src: 'relative/folder' });
  assert.equal(badSource.status, 400);
  assert.match(badSource.json.fields.contextDir, /full path/);

  // The stream ends by itself when the deploy does.
  const stream = await (await fetch(`${base}/api/apps/${app.id}/deployments/${deployment.id}/stream`)).text();
  const events = stream.split('\n\n').filter(Boolean).map((block) => {
    const [, name, data] = /^event: (\w+)\ndata: (.*)$/s.exec(block);
    return { name, data: JSON.parse(data) };
  });
  assert.equal(events.at(-1).name, 'end');
  const lines = events.filter((event) => event.name === 'logs').flatMap((event) => event.data);
  assert.ok(lines.some((line) => line.s === 'cmd' && line.m.startsWith('docker push ')));
  assert.ok(lines.every((line) => !line.m.includes(PASSWORD)));
  const last = events.filter((event) => event.name === 'record').at(-1).data;
  assert.equal(last.status, 'succeeded');
  assert.equal(last.verify.status, 'verified');

  const history = (await call('GET', `/api/apps/${app.id}/deployments`)).json;
  assert.equal(history.total, 1);
  assert.equal(history.deployments[0].digest, sha256(MANIFEST));
  assert.equal((await call('GET', '/api/state')).json.apps[0].last.status, 'succeeded');

  // The deploy started from the page is an entry in the queue file, with its result written on it.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const queue = (await call('GET', '/api/queue')).json;
  assert.equal(queue.file, path.join(home, 'queue.json'));
  assert.equal(queue.watching, true);
  assert.deepEqual(queue.entries.map((entry) => [entry.app, entry.status, entry.image, entry.appName, entry.id]), [[1, 'verified', sha256(MANIFEST), 'Demo', deployment.id]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(queue.file, 'utf8')).map((entry) => entry.status), ['verified']);
  assert.deepEqual((await call('GET', '/api/state')).json.meta.queue, { running: 0, waiting: 0 });

  const text = await call('GET', `/api/apps/${app.id}/deployments/${deployment.id}/log.txt`);
  assert.match(text.text, /deploy #1 {2}succeeded/);
  assert.match(text.text, /\$ docker push /);

  const held = (await call('GET', `/api/apps/${app.id}/registry`)).json;
  assert.deepEqual({ ok: held.ok, found: held.found, digest: held.digest, number: held.deployment.number, tags: held.tags }, { ok: true, found: true, digest: sha256(MANIFEST), number: 1, tags: ['latest'] });

  // Replaying a finished deploy gives the same output again.
  const replay = await (await fetch(`${base}/api/apps/${app.id}/deployments/${deployment.id}/stream`)).text();
  assert.equal(replay.split('\n\n').filter((block) => block.startsWith('event: logs')).length >= 1, true);
});

test('cancel from the page stops a running deploy', async (t) => {
  const registry = await startRegistry(t, { user: USER, password: PASSWORD });
  useFakeDocker(t, { USER, PASSWORD, DIGEST: sha256(MANIFEST), BUILD_MS: 20_000 });
  const { call, base } = await startApp(t);
  const { app } = (await call('POST', '/api/apps', appBody(t, registry, { password: PASSWORD }))).json;
  const { deployment } = (await call('POST', `/api/apps/${app.id}/deploy`, {})).json;
  assert.equal((await call('DELETE', `/api/apps/${app.id}`)).status, 409, 'an app with a running deploy cannot be removed');

  // A second deploy is accepted and waits; the queue shows both.
  const second = (await call('POST', `/api/apps/${app.id}/deploy`, { noCache: true })).json.deployment;
  assert.equal(second.status, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual((await call('GET', '/api/state')).json.meta.queue, { running: 1, waiting: 1 });
  assert.deepEqual((await call('GET', '/api/queue')).json.entries.map((entry) => entry.status).sort(), ['running', 'waiting']);

  // Cancel the waiting one first, then the running one; both streams end by themselves.
  const streams = [deployment, second].map((record) => fetch(`${base}/api/apps/${app.id}/deployments/${record.id}/stream`).then((response) => response.text()));
  assert.equal((await call('POST', `/api/apps/${app.id}/deployments/${second.id}/cancel`)).status, 200);
  await streams[1];
  assert.equal((await call('GET', `/api/apps/${app.id}/deployments/${second.id}`)).json.deployment.error, 'Cancelled while waiting in the queue.');
  assert.equal((await call('POST', `/api/apps/${app.id}/deployments/${deployment.id}/cancel`)).status, 200);
  await streams[0];
  assert.equal((await call('GET', `/api/apps/${app.id}/deployments/${deployment.id}`)).json.deployment.status, 'cancelled');
});

test('an entry added to the queue file by hand is deployed, and the file can be moved', async (t) => {
  const registry = await startRegistry(t, { user: USER, password: PASSWORD, manifests: { 'demo-xo-abc123/app:latest': MANIFEST } });
  useFakeDocker(t, { USER, PASSWORD, DIGEST: sha256(MANIFEST) });
  const { call, home } = await startApp(t);
  await call('POST', '/api/apps', appBody(t, registry, { password: PASSWORD }));

  // Move the queue next to the projects, then add an entry with a folder relative to it.
  const projects = tempDir(t, 'liftoff-projects-');
  fs.mkdirSync(path.join(projects, 'web'));
  fs.writeFileSync(path.join(projects, 'web', 'Dockerfile'), 'FROM scratch\n');
  const file = path.join(projects, 'queue.json');
  assert.equal((await call('PUT', '/api/queue-file', { path: 'relative.json' })).status, 400);
  const moved = await call('PUT', '/api/queue-file', { path: file });
  assert.equal(moved.json.file, file);
  assert.equal((await call('GET', '/api/state')).json.meta.queueFile, file);
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), true);

  fs.writeFileSync(file, '[\n  { "app": 1, "src": "web" },\n]\n'); // trailing comma on purpose
  let entries = [];
  for (let attempt = 0; attempt < 60 && entries[0]?.status !== 'verified'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    entries = (await call('GET', '/api/queue')).json.entries;
  }
  assert.equal(entries[0].status, 'verified');
  const state = (await call('GET', '/api/state')).json;
  assert.equal(fs.realpathSync.native(state.apps[0].contextDir), fs.realpathSync.native(path.join(projects, 'web')));
  assert.equal(state.apps[0].last.trigger, 'file');

  // The endpoint adds an entry the same way, and answers with the entry once its deploy has been started.
  const added = await call('POST', '/api/queue', { app: 1, src: 'web', noCache: true });
  assert.equal(added.status, 201);
  assert.equal(added.json.file, file);
  assert.deepEqual([added.json.entry.app, added.json.entry.src, added.json.entry.noCache], [1, 'web', true]);
  assert.ok(['waiting', 'running'].includes(added.json.entry.status));
  assert.match(added.json.entry.id, /^d\w+$/);
  for (let attempt = 0; attempt < 60 && entries[0]?.id !== added.json.entry.id || entries[0]?.status !== 'verified'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    entries = (await call('GET', '/api/queue')).json.entries;
    if (attempt > 58) break;
  }
  assert.deepEqual(entries.map((entry) => entry.status), ['verified', 'verified']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((entry) => entry.src), ['web', 'web']);

  // A bad entry is refused and not written; the app can also be named by its id.
  const before = fs.readFileSync(file, 'utf8');
  for (const [body, field] of [[{ app: 9 }, 'app'], [{ noCache: true }, 'src'], [{ app: 1, src: 'missing' }, 'src'], [{ app: 1, src: 5 }, 'src']]) {
    const refused = await call('POST', '/api/queue', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.ok(refused.json.fields[field], JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await call('POST', '/api/queue', { app: 1 }, { Origin: 'https://evil.example' })).status, 403);
  const byId = await call('POST', '/api/queue', { app: 'demo-xo-abc123' });
  assert.equal(byId.status, 201);
  assert.equal(byId.json.entry.app, 1);

  // The fields can also go in the address, with no body at all: nothing to quote in any shell.
  const plain = await call('POST', '/api/queue?app=1&src=web&noCache=true');
  assert.equal(plain.status, 201);
  assert.deepEqual([plain.json.entry.app, plain.json.entry.src, plain.json.entry.noCache], [1, 'web', true]);
  assert.equal((await call('POST', '/api/queue?app=9')).status, 400);
  assert.equal((await call('POST', '/api/queue')).status, 415, 'nothing in the address and no JSON body');
  assert.equal((await call('GET', '/api/queue?app=1')).json.entries.length, 4, 'reading the queue never adds to it');
});

test('the live address check reports what answers there', async (t) => {
  const registry = await startRegistry(t, {});
  const { call } = await startApp(t);
  const { app } = (await call('POST', '/api/apps', appBody(t, null, { liveUrl: `http://${registry.host}/v2/` }))).json;
  const up = (await call('GET', `/api/apps/${app.id}/health`)).json;
  assert.equal(up.ok, true);
  assert.equal(up.status, 401);
  await call('PUT', `/api/apps/${app.id}`, { liveUrl: 'http://127.0.0.1:9/' });
  assert.equal((await call('GET', `/api/apps/${app.id}/health`)).json.ok, false);
  await call('PUT', `/api/apps/${app.id}`, { liveUrl: '' });
  assert.match((await call('GET', `/api/apps/${app.id}/health`)).json.message, /No live address/);
});
