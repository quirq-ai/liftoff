import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDockerCommand } from '../src/docker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const sha256 = (data) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;

/** A fresh, empty folder that is removed when the test ends. */
export function tempDir(t, prefix = 'liftoff-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/** A folder with a Dockerfile in it, like an app's source folder. */
export function sourceDir(t) {
  const dir = tempDir(t, 'liftoff-src-');
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\nCOPY hello.txt /hello.txt\n');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  return dir;
}

const FAKE_KEYS = ['CALLS', 'USER', 'PASSWORD', 'DIGEST', 'DOWN', 'BUILD_FAIL', 'BUILD_MS', 'ARCH', 'PUSH_DENIED'];

/**
 * Point the pipeline at the stand-in docker for one test. Returns a reader for
 * the calls it received.
 */
export function useFakeDocker(t, settings) {
  const dir = tempDir(t, 'liftoff-fake-');
  const calls = path.join(dir, 'calls.jsonl');
  for (const key of FAKE_KEYS) delete process.env[`FAKE_DOCKER_${key}`];
  process.env.FAKE_DOCKER_CALLS = calls;
  for (const [key, value] of Object.entries(settings)) process.env[`FAKE_DOCKER_${key}`] = String(value);
  setDockerCommand([process.execPath, path.join(HERE, 'fixtures', 'fake-docker.mjs')]);
  t.after(() => {
    setDockerCommand(['docker']);
    for (const key of FAKE_KEYS) delete process.env[`FAKE_DOCKER_${key}`];
  });
  return () => {
    try {
      return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
}

/**
 * A tiny registry that answers the questions Liftoff asks after a push: who are
 * you (Bearer token like Harbor, or Basic), and what does this tag point to.
 */
export async function startRegistry(t, { mode = 'bearer', user = 'robot+push', password = 'secret', manifests = {}, readable = true, digestHeader = true } = {}) {
  const tokens = new Set();
  const requests = [];
  const state = { manifests: { ...manifests }, readable };
  let port;

  const basicOk = (req) => {
    const header = req.headers.authorization ?? '';
    return header === `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  };
  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {});
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://registry');
    requests.push({ method: req.method, path: url.pathname, authorization: (req.headers.authorization ?? '').split(' ')[0] || null, query: Object.fromEntries(url.searchParams) });

    if (url.pathname === '/service/token') {
      if (!basicOk(req)) return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] });
      const token = crypto.randomBytes(12).toString('hex');
      tokens.add(token);
      return send(res, 200, { token });
    }

    const authorized = mode === 'basic'
      ? basicOk(req)
      : tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!authorized) {
      const challenge = mode === 'basic'
        ? 'Basic realm="stub"'
        : `Bearer realm="http://127.0.0.1:${port}/service/token",service="stub"`;
      return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'WWW-Authenticate': challenge });
    }
    if (url.pathname === '/v2/') return send(res, 200, {});
    if (!state.readable) {
      return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'WWW-Authenticate': 'Bearer realm="x",service="stub",error="insufficient_scope"' });
    }

    const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
    if (manifest) {
      const body = state.manifests[`${manifest[1]}:${manifest[2]}`];
      if (body === undefined) return send(res, 404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      const headers = { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' };
      if (digestHeader) headers['Docker-Content-Digest'] = sha256(body);
      return send(res, 200, req.method === 'HEAD' ? '' : body, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    }

    const tags = /^\/v2\/(.+)\/tags\/list$/.exec(url.pathname);
    if (tags) {
      const names = Object.keys(state.manifests).filter((key) => key.startsWith(`${tags[1]}:`)).map((key) => key.slice(tags[1].length + 1));
      return names.length ? send(res, 200, { name: tags[1], tags: names }) : send(res, 404, { errors: [{ code: 'NAME_UNKNOWN' }] });
    }
    return send(res, 404, {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { host: `127.0.0.1:${port}`, requests, state };
}
