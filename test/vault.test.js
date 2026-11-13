import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { cleanSecret, Vault } from '../src/vault.js';
import { tempDir } from './helpers.js';

const awkward = 'p@ss wörd/with+odd=chars"\'%$`é漢';

for (const backend of ['keyfile', 'dpapi']) {
  const skip = backend === 'dpapi' && process.platform !== 'win32' ? 'Windows only' : false;

  test(`${backend}: a password comes back exactly, and is not readable in the file`, { skip }, async (t) => {
    const vault = new Vault(tempDir(t), { backend });
    assert.equal(vault.has('app'), false);
    assert.equal(await vault.get('app'), null);

    await vault.set('app', awkward);
    assert.equal(await vault.get('app'), awkward);
    assert.equal(vault.has('app'), true);
    assert.equal(vault.info('app').backend, backend);
    assert.ok(Date.parse(vault.info('app').savedAt) > 0);

    const onDisk = fs.readFileSync(vault.file, 'utf8');
    assert.ok(!onDisk.includes(awkward));
    assert.ok(!onDisk.includes(Buffer.from(awkward).toString('base64')));

    await vault.set('app', 'replaced');
    assert.equal(await vault.get('app'), 'replaced');
    assert.equal(vault.delete('app'), true);
    assert.equal(vault.delete('app'), false);
    assert.equal(await vault.get('app'), null);
  });
}

test('each app has its own password', async (t) => {
  const vault = new Vault(tempDir(t), { backend: 'keyfile' });
  await vault.set('one', 'first');
  await vault.set('two', 'second');
  assert.equal(await vault.get('one'), 'first');
  assert.equal(await vault.get('two'), 'second');
  vault.delete('one');
  assert.equal(await vault.get('two'), 'second');
});

test('a password sealed for someone else gives a clear message, not a crash', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async (t) => {
  const vault = new Vault(tempDir(t), { backend: 'dpapi' });
  fs.writeFileSync(vault.file, JSON.stringify({ version: 1, entries: { app: { backend: 'dpapi', blob: Buffer.from('not a real blob').toString('base64'), savedAt: 'x' } } }));
  await assert.rejects(vault.get('app'), /could not decrypt the stored password/);
});

test('a tampered key-file password is rejected', async (t) => {
  const vault = new Vault(tempDir(t), { backend: 'keyfile' });
  await vault.set('app', 'secret');
  const data = JSON.parse(fs.readFileSync(vault.file, 'utf8'));
  const blob = Buffer.from(data.entries.app.blob, 'base64');
  blob[blob.length - 1] ^= 1;
  data.entries.app.blob = blob.toString('base64');
  fs.writeFileSync(vault.file, JSON.stringify(data));
  await assert.rejects(vault.get('app'));
});

test('stray whitespace from pasting is dropped; empty and multi-line passwords are refused', () => {
  assert.equal(cleanSecret('  secret\r\n'), 'secret');
  assert.equal(cleanSecret('in side'), 'in side');
  assert.throws(() => cleanSecret('   '), /required/);
  assert.throws(() => cleanSecret(undefined), /required/);
  assert.throws(() => cleanSecret('two\nlines'), /line breaks/);
  assert.throws(() => cleanSecret('x'.repeat(5000)), /too long/);
});

test('an unknown protection setting is refused up front', () => {
  process.env.LIFTOFF_VAULT = 'rot13';
  try {
    assert.throws(() => new Vault('unused'), /Unknown LIFTOFF_VAULT/);
  } finally {
    delete process.env.LIFTOFF_VAULT;
  }
});
