import assert from 'node:assert/strict';
import test from 'node:test';
import { headManifest, listTags, registryBase, RegistryError } from '../src/registry.js';
import { sha256, startRegistry } from './helpers.js';

const manifest = JSON.stringify({ schemaVersion: 2, layers: [] });
const account = { user: 'xo-app+push', password: 'pässword with spaces' };
const target = (registry, extra = {}) => ({ registry: registry.host, username: account.user, password: account.password, ...extra });

for (const mode of ['bearer', 'basic']) {
  test(`${mode}: tells which image a tag points to`, async (t) => {
    const registry = await startRegistry(t, { mode, ...account, manifests: { 'app/web:latest': manifest } });
    const found = await headManifest(target(registry), 'app/web', 'latest');
    assert.deepEqual(found, { found: true, digest: sha256(manifest), mediaType: 'application/vnd.docker.distribution.manifest.v2+json' });
    assert.deepEqual(await headManifest(target(registry), 'app/web', 'nope'), { found: false });
  });

  test(`${mode}: a wrong password is reported as such`, async (t) => {
    const registry = await startRegistry(t, { mode, ...account, manifests: { 'app/web:latest': manifest } });
    await assert.rejects(headManifest(target(registry, { password: 'wrong' }), 'app/web', 'latest'), (error) => {
      assert.ok(error instanceof RegistryError);
      assert.equal(error.kind, 'auth');
      assert.match(error.message, /rejected the username or password/);
      return true;
    });
  });
}

test('with a token service, the password only ever goes to the token service', async (t) => {
  const registry = await startRegistry(t, { ...account, manifests: { 'app/web:latest': manifest } });
  await headManifest(target(registry), 'app/web', 'latest');
  const basic = registry.requests.filter((request) => request.authorization === 'Basic');
  assert.deepEqual(basic.map((request) => request.path), ['/service/token']);
  assert.equal(basic[0].query.scope, 'repository:app/web:pull');
  assert.equal(basic[0].query.service, 'stub');
});

test('a login that may push but not read is "denied", not a wrong password', async (t) => {
  const registry = await startRegistry(t, { ...account, readable: false, manifests: { 'app/web:latest': manifest } });
  await assert.rejects(headManifest(target(registry), 'app/web', 'latest'), (error) => error instanceof RegistryError && error.kind === 'denied');
});

test('works out the digest itself when the registry leaves it off', async (t) => {
  const registry = await startRegistry(t, { ...account, digestHeader: false, manifests: { 'app/web:latest': manifest } });
  assert.equal((await headManifest(target(registry), 'app/web', 'latest')).digest, sha256(manifest));
});

test('lists tags; a repository that does not exist yet has none', async (t) => {
  const registry = await startRegistry(t, { ...account, manifests: { 'app/web:latest': manifest, 'app/web:v1': manifest, 'other/x:latest': manifest } });
  assert.deepEqual((await listTags(target(registry), 'app/web')).sort(), ['latest', 'v1']);
  assert.deepEqual(await listTags(target(registry), 'missing/repo'), []);
});

test('an unreachable registry is a network problem with a readable reason', async () => {
  await assert.rejects(headManifest({ registry: '127.0.0.1:9', username: 'a', password: 'b' }, 'app/web', 'latest'), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.equal(error.kind, 'network');
    assert.match(error.message, /Could not reach 127\.0\.0\.1:9/);
    return true;
  });
});

test('plain HTTP is only for registries on this machine', () => {
  assert.equal(registryBase('localhost:5000'), 'http://localhost:5000');
  assert.equal(registryBase('127.0.0.1:5000'), 'http://127.0.0.1:5000');
  assert.equal(registryBase('registry.xo.builders'), 'https://registry.xo.builders');
  assert.equal(registryBase('localhost.evil.example'), 'https://localhost.evil.example');
  assert.equal(registryBase('127.0.0.1.evil.example'), 'https://127.0.0.1.evil.example');
});
