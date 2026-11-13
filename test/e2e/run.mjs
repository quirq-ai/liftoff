// End-to-end check with the real docker CLI and engine:
//
//   node test/e2e/run.mjs
//
// It starts a throwaway registry in a container (test/e2e/mock_registry.py on the
// python:3.12-slim image, which must already be on this machine), then deploys a
// tiny image to it through Liftoff's real pipeline: once against a registry that
// hands out tokens like Harbor, once against one that takes the password directly.
// Your own registries, logins and Docker settings are not touched; the script
// checks that and removes what it created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDeployment, testLogin } from '../../src/pipeline.js';
import { headManifest, listTags } from '../../src/registry.js';
import { Store } from '../../src/store.js';
import { Vault } from '../../src/vault.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_IMAGE = 'python:3.12-slim';
const CONTAINER = 'liftoff-e2e-registry';
const PORT = Number(process.env.LIFTOFF_E2E_PORT ?? 5077);
const REGISTRY = `localhost:${PORT}`;
const USER = 'xo-liftoff-e2e+push';
const IMAGE = `${REGISTRY}/liftoff-e2e/app:latest`;

const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const quiet = (args) => {
  try {
    return docker(args);
  } catch {
    return null;
  }
};
const fileHash = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

let failures = 0;
async function check(name, work) {
  try {
    await work();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

async function startRegistry(mode, password) {
  quiet(['rm', '-f', CONTAINER]);
  // The password reaches the container through the environment, not the command line.
  docker(['create', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:5000`, '-e', 'REG_USER', '-e', 'REG_PASS', '-e', `AUTH_MODE=${mode}`, '-e', `PUBLIC_URL=http://${REGISTRY}`, BASE_IMAGE, 'python', '/mock_registry.py'],
    { env: { ...process.env, REG_USER: USER, REG_PASS: password } });
  docker(['cp', path.join(HERE, 'mock_registry.py'), `${CONTAINER}:/mock_registry.py`]);
  docker(['start', CONTAINER]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://${REGISTRY}/v2/`)).status === 401) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The test registry did not come up on ${REGISTRY}:\n${quiet(['logs', '--tail', '20', CONTAINER])}`);
}

async function scenario(mode) {
  console.log(`\nRegistry sign-in: ${mode}`);
  const password = `${crypto.randomBytes(12).toString('base64url')}-é ü`; // awkward on purpose
  await startRegistry(mode, password);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-e2e-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-e2e-src-'));
  fs.writeFileSync(path.join(source, 'Dockerfile'), 'FROM scratch\nCOPY hello.txt /hello.txt\n');
  fs.writeFileSync(path.join(source, 'hello.txt'), `first ${crypto.randomUUID()}\n`);

  const store = new Store(home);
  const vault = new Vault(home);
  const app = store.createApp({ name: 'Liftoff E2E', registry: REGISTRY, repository: 'liftoff-e2e/app', username: USER, contextDir: source });
  const target = { registry: REGISTRY, username: USER, password };
  const dockerConfig = path.join(process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'), 'config.json');
  const configBefore = fileHash(dockerConfig);
  const deploy = () => startDeployment({ store, vault, app, trigger: 'cli' }).done;
  const steps = (record) => record.steps.map((step) => `${step.key}:${step.status}`).join(' ');

  try {
    await check('a wrong password is caught by "test login"', async () => {
      await vault.set(app.id, 'definitely-wrong');
      const result = await testLogin({ app, vault });
      assert.equal(result.ok, false, result.message);
      assert.match(result.message, /rejected the username or password/);
    });

    await check('a wrong password fails the deploy at login and pushes nothing', async () => {
      const record = await deploy();
      assert.equal(record.status, 'failed');
      assert.equal(steps(record), 'preflight:ok login:failed build:skipped push:skipped verify:skipped');
      assert.deepEqual(await listTags(target, 'liftoff-e2e/app'), []);
    });

    let first;
    await check(`the right password is stored (${vault.backend}) and accepted`, async () => {
      await vault.set(app.id, password);
      assert.deepEqual(await testLogin({ app, vault }), { ok: true, message: `${REGISTRY} accepted ${USER}.` });
    });

    await check('deploy: login, build, push, and the registry confirms the pushed digest', async () => {
      first = await deploy();
      assert.equal(first.status, 'succeeded', first.error);
      assert.equal(steps(first), 'preflight:ok login:ok build:ok push:ok verify:ok');
      assert.equal(first.verify.status, 'verified');
      assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(first.builtPlatform, 'linux/amd64');
      assert.equal((await headManifest(target, 'liftoff-e2e/app', 'latest')).digest, first.digest);
    });

    await check('a changed source gives a new image, and the history keeps both', async () => {
      fs.writeFileSync(path.join(source, 'hello.txt'), `second ${crypto.randomUUID()}\n`);
      const second = await deploy();
      assert.equal(second.status, 'succeeded', second.error);
      assert.notEqual(second.digest, first.digest);
      assert.equal((await headManifest(target, 'liftoff-e2e/app', 'latest')).digest, second.digest);
      assert.deepEqual(store.listDeployments(app.id).map((record) => `${record.number}:${record.status}`), ['3:succeeded', '2:succeeded', '1:failed']);
    });

    await check('the password is in no log, record or settings file', async () => {
      const written = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name));
          else written.push(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
        }
      };
      walk(home);
      const everything = written.join('\n');
      for (const form of [password, Buffer.from(password).toString('base64'), Buffer.from(`${USER}:${password}`).toString('base64')]) {
        assert.ok(!everything.includes(form));
      }
    });

    await check('your own Docker login state is untouched and no private config is left behind', async () => {
      assert.equal(fileHash(dockerConfig), configBefore, `${dockerConfig} changed`);
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`liftoff-docker-${process.pid}-`)), []);
      if (process.platform === 'win32') {
        const saved = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' });
        assert.ok(!saved.includes(REGISTRY), `Windows Credential Manager has an entry for ${REGISTRY}`);
      }
    });

    await check('docker without Liftoff still has no login for the test registry', async () => {
      let output = 'the push went through';
      try {
        docker(['push', IMAGE]);
      } catch (error) {
        output = `${error.stdout}${error.stderr}`;
      }
      assert.match(output, /unauthorized|authentication required|denied|no basic auth credentials/i, 'a plain docker push should have been refused');
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    quiet(['rm', '-f', CONTAINER]);
  }
}

// --- run ---------------------------------------------------------------------
if (quiet(['version', '--format', '{{.Server.Version}}']) === null) {
  console.error('Docker is not running. Start Docker Desktop and run this again.');
  process.exit(2);
}
if (quiet(['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}']) === null) {
  console.error(`This check runs its test registry on the ${BASE_IMAGE} image, which is not on this machine.\nGet it with:  docker pull ${BASE_IMAGE}`);
  process.exit(2);
}

console.log(`Liftoff end-to-end check with docker ${docker(['version', '--format', '{{.Client.Version}}'])}, test registry on ${REGISTRY}`);
try {
  for (const mode of ['bearer', 'basic']) await scenario(mode);
} finally {
  quiet(['rm', '-f', CONTAINER]);
  // Pushed images stay listed under the repository name even without a tag; remove exactly those.
  const listed = quiet(['images', '--format', '{{.ID}} {{.Repository}}']) ?? '';
  const ours = listed.split('\n').filter((line) => line.endsWith(` ${REGISTRY}/liftoff-e2e/app`)).map((line) => line.split(' ')[0]);
  for (const id of new Set(ours)) quiet(['image', 'rm', '-f', id]);
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
