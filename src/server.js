import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as docker from './docker.js';
import { startDeployment, testLogin } from './pipeline.js';
import { QueueFile, QueueWatcher } from './queuefile.js';
import { headManifest, listTags, RegistryError } from './registry.js';
import { LIVE, NotFoundError, Store, ValidationError } from './store.js';
import { resolveHome } from './util.js';
import { cleanSecret, Vault } from './vault.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** The password in a request body, tidied; null when the body has none and none is required. */
function passwordFrom(body, { required = false } = {}) {
  if (!required && (body.password === undefined || body.password === null || body.password === '')) return null;
  try {
    return cleanSecret(body.password);
  } catch (error) {
    throw new ValidationError({ password: error.message });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reject(new HttpError(415, 'Send JSON (Content-Type: application/json)'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
  });
}

/**
 * This server can start builds and push with stored passwords, so only this
 * machine's own Liftoff page may talk to it. It listens on the loopback
 * address only, and every request must:
 *   - name this server by a loopback host (stops DNS-rebinding pages), and
 *   - come from this page itself, not from another site open in the browser.
 * It sends no CORS headers, so other origins cannot read answers either.
 */
function guard(req, port) {
  const host = (req.headers.host ?? '').toLowerCase();
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host) && !new RegExp(`^[a-z0-9-]+\\.localhost:${port}$`).test(host)) {
    throw new HttpError(403, 'This address is not allowed to reach Liftoff');
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Requests from other sites are not allowed');
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requests from other sites are not allowed');
}

export function createServer({ home, port }) {
  const defaultHome = resolveHome();
  const store = new Store(home);
  const vault = new Vault(home);
  const queue = new QueueFile({ store, vault });
  const watcher = new QueueWatcher(queue);
  docker.sweepSessions();

  // --- Docker engine status, refreshed in the background ----------------------
  let engine = { value: null, at: 0, pending: null };
  function engineStatus() {
    if (!engine.pending && Date.now() - engine.at > 8000) {
      engine.pending = docker.inspectEngine().then((value) => {
        engine = { value, at: Date.now(), pending: null };
        return value;
      });
    }
    return engine.value ?? engine.pending;
  }

  function folderState(app) {
    let exists = false;
    try {
      exists = fs.statSync(app.contextDir).isDirectory();
    } catch { /* missing */ }
    const dockerfile = path.resolve(app.contextDir, app.dockerfile || 'Dockerfile');
    return { exists, hasDockerfile: exists && fs.existsSync(dockerfile) };
  }

  function describeApp(app) {
    const saved = vault.info(app.id);
    return {
      ...app,
      image: `${app.registry}/${app.repository}:${app.tag}`,
      hasPassword: Boolean(saved),
      passwordSavedAt: saved?.savedAt ?? null,
      folder: folderState(app),
      deployCount: store.countDeployments(app.id),
      last: store.latestDeployment(app.id),
    };
  }

  // --- handlers -----------------------------------------------------------------
  const handlers = {
    async state(_req, res) {
      const active = store.activeDeployments();
      sendJson(res, 200, {
        apps: store.listApps().map(describeApp),
        meta: {
          version: VERSION,
          queueFile: queue.file,
          queue: {
            running: active.filter((record) => record.status === 'running').length,
            waiting: active.filter((record) => record.status === 'queued').length,
          },
          home,
          vault: { backend: vault.backend, label: vault.label },
          docker: await engineStatus(),
          platform: process.platform,
          // How to reach the command line from any folder; shown in the app as a copyable hint.
          cli: `node "${path.join(ROOT, 'bin', 'liftoff.js')}"${home === defaultHome ? '' : ` --home "${home}"`}`,
        },
      });
    },

    async createApp(req, res) {
      const body = await readBody(req);
      const password = passwordFrom(body);
      const app = store.createApp(body);
      if (password) await vault.set(app.id, password);
      sendJson(res, 201, { app: describeApp(app) });
    },

    async updateApp(req, res, id) {
      const body = await readBody(req);
      const password = passwordFrom(body);
      const app = store.updateApp(id, body);
      if (password) await vault.set(app.id, password);
      sendJson(res, 200, { app: describeApp(app) });
    },

    async deleteApp(_req, res, id) {
      store.getApp(id);
      if (store.activeDeployments().some((record) => record.appId === id)) throw new HttpError(409, 'A deploy of this app is running or waiting. Cancel it first.');
      vault.delete(id);
      store.deleteApp(id);
      sendJson(res, 200, { ok: true });
    },

    async setPassword(req, res, id) {
      const app = store.getApp(id);
      const body = await readBody(req);
      await vault.set(app.id, passwordFrom(body, { required: true }));
      sendJson(res, 200, { app: describeApp(app) });
    },

    async deletePassword(_req, res, id) {
      const app = store.getApp(id);
      vault.delete(app.id);
      sendJson(res, 200, { app: describeApp(app) });
    },

    async testLogin(_req, res, id) {
      sendJson(res, 200, await testLogin({ app: store.getApp(id), vault }));
    },

    async deploy(req, res, id) {
      const body = await readBody(req);
      const { record } = startDeployment({ store, vault, app: store.getApp(id), trigger: 'app', options: { ...body, cloneInto: queue.folder } });
      queue.record(record, store.getApp(id));
      sendJson(res, 202, { deployment: record });
    },

    /** The queue file as the page shows it: every entry, newest first. */
    async queue(_req, res) {
      sendJson(res, 200, { ...queue.view(), watching: watcher.owner });
    },

    /**
     * Add an entry to the queue file, as if it had been typed in:
     *   POST /api/queue   { "app": 1, "src": "my-project" }
     * The deploy starts at once; the answer is the entry with its id and status.
     */
    async addEntry(req, res) {
      // The fields may come in the address (?app=1&src=my-project), which needs no quoting in any shell,
      // or as a JSON body. A JSON body wins where both name a field.
      const query = new URL(req.url, 'http://localhost').searchParams;
      const fields = {};
      if (query.has('app')) fields.app = query.get('app');
      if (query.has('src')) fields.src = query.get('src');
      if (query.has('noCache')) fields.noCache = ['true', '1', 'yes'].includes(query.get('noCache').toLowerCase());
      const hasJson = /^application\/json\b/i.test(req.headers['content-type'] ?? '');
      if (hasJson || !Object.keys(fields).length) Object.assign(fields, await readBody(req));
      else req.resume();
      const entry = queue.add(fields, { trigger: watcher.owner });
      sendJson(res, 201, { entry, file: queue.file });
    },

    /** Move the queue to another file; relative folders in entries then start from that file's folder. */
    async setQueueFile(req, res) {
      const body = await readBody(req);
      store.setQueueFile(body.path);
      watcher.tick();
      sendJson(res, 200, { ...queue.view(), watching: watcher.owner });
    },

    async listDeployments(_req, res, id) {
      store.getApp(id);
      sendJson(res, 200, { deployments: store.listDeployments(id, { limit: 100 }), total: store.countDeployments(id) });
    },

    async getDeployment(_req, res, id, deploymentId) {
      sendJson(res, 200, { deployment: store.getDeployment(id, deploymentId) });
    },

    async cancel(_req, res, id, deploymentId) {
      const record = store.getDeployment(id, deploymentId);
      if (LIVE.includes(record.status)) store.requestCancel(id, deploymentId);
      sendJson(res, 200, { ok: true });
    },

    /** Plain-text copy of a deploy's output, for saving or sharing. */
    async logText(_req, res, id, deploymentId) {
      const record = store.getDeployment(id, deploymentId);
      const lines = store.readLog(id, deploymentId).map((entry) => {
        const time = entry.t ? new Date(entry.t).toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--';
        const mark = { cmd: '$ ', sys: '# ', fail: '! ' }[entry.s] ?? '  ';
        return `${time} ${String(entry.step).padEnd(9)} ${mark}${entry.m}`;
      });
      const body = `${record.image}  deploy #${record.number}  ${record.status}  started ${new Date(record.startedAt).toString()}\n\n${lines.join('\n')}\n`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${id}-deploy-${record.number}.txt"`,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    },

    /**
     * Live view of one deploy as server-sent events. It follows the files the
     * deploy writes, so it works the same whether this server runs the deploy
     * or a `liftoff deploy` in a terminal does, and for finished deploys too.
     */
    async stream(req, res, id, deploymentId) {
      store.getDeployment(id, deploymentId);
      const file = store.logFile(id, deploymentId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const decoder = new StringDecoder('utf8');
      let offset = 0;
      let carry = '';
      let lastRecord = '';
      let timer = null;
      let closed = false;

      const tick = () => {
        if (closed) return;
        let more = false;
        try {
          const record = store.getDeployment(id, deploymentId);
          let size = 0;
          try {
            size = fs.statSync(file).size;
          } catch { /* no output yet */ }
          if (size > offset) {
            const buffer = Buffer.alloc(Math.min(size - offset, 512 * 1024));
            const handle = fs.openSync(file, 'r');
            const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
            fs.closeSync(handle);
            offset += read;
            more = offset < size;
            const pieces = (carry + decoder.write(buffer.subarray(0, read))).split('\n');
            carry = pieces.pop();
            const entries = [];
            for (const piece of pieces) {
              if (!piece) continue;
              try {
                entries.push(JSON.parse(piece));
              } catch { /* a torn line; skip it */ }
            }
            if (entries.length) send('logs', entries);
          }
          const snapshot = JSON.stringify(record);
          if (snapshot !== lastRecord) {
            lastRecord = snapshot;
            send('record', record);
          }
          if (!LIVE.includes(record.status) && !more) {
            send('end', {});
            closed = true;
            res.end();
            return;
          }
        } catch (error) {
          send('fail', { message: error.message });
          closed = true;
          res.end();
          return;
        }
        timer = setTimeout(tick, more ? 0 : 300);
      };
      req.on('close', () => {
        closed = true;
        clearTimeout(timer);
      });
      tick();
    },

    /** What the registry holds for this app right now, and which deploy that is. */
    async registry(_req, res, id) {
      const app = store.getApp(id);
      if (!vault.has(id)) return sendJson(res, 200, { ok: false, kind: 'no-password', message: 'Save the password first.' });
      const target = { registry: app.registry, username: app.username, password: await vault.get(id) };
      try {
        const remote = await headManifest(target, app.repository, app.tag);
        const tags = await listTags(target, app.repository).catch(() => null);
        const match = remote.found
          ? store.listDeployments(id, { limit: 500 }).find((record) => record.digest === remote.digest)
          : null;
        sendJson(res, 200, {
          ok: true,
          found: remote.found,
          digest: remote.digest ?? null,
          tags,
          deployment: match ? { id: match.id, number: match.number, finishedAt: match.finishedAt } : null,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        sendJson(res, 200, { ok: false, kind: error.kind, message: error.message, checkedAt: new Date().toISOString() });
      }
    },

    /** Is the deployed app answering at its live address? */
    async health(_req, res, id) {
      const app = store.getApp(id);
      if (!app.liveUrl) return sendJson(res, 200, { ok: false, message: 'No live address set.' });
      const started = Date.now();
      try {
        const response = await fetch(app.liveUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        sendJson(res, 200, {
          ok: response.status < 500,
          status: response.status,
          ms: Date.now() - started,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        const reason = error.name === 'TimeoutError' ? 'no answer within 10 seconds' : (error.cause?.code ?? error.message);
        sendJson(res, 200, { ok: false, message: reason, ms: Date.now() - started, checkedAt: new Date().toISOString() });
      }
    },

    /** Lets the form say "Dockerfile found" while a path is being typed. */
    async checkFolder(req, res) {
      const body = await readBody(req);
      const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
      if (!dir || !path.isAbsolute(dir)) return sendJson(res, 200, { exists: false, absolute: false });
      const state = folderState({ contextDir: dir, dockerfile: typeof body.dockerfile === 'string' ? body.dockerfile.trim() : '' });
      sendJson(res, 200, { absolute: true, ...state });
    },
  };

  const routes = [
    ['GET', /^\/api\/state$/, handlers.state],
    ['GET', /^\/api\/queue$/, handlers.queue],
    ['POST', /^\/api\/queue$/, handlers.addEntry],
    ['PUT', /^\/api\/queue-file$/, handlers.setQueueFile],
    ['POST', /^\/api\/apps$/, handlers.createApp],
    ['PUT', /^\/api\/apps\/([^/]+)$/, handlers.updateApp],
    ['DELETE', /^\/api\/apps\/([^/]+)$/, handlers.deleteApp],
    ['PUT', /^\/api\/apps\/([^/]+)\/password$/, handlers.setPassword],
    ['DELETE', /^\/api\/apps\/([^/]+)\/password$/, handlers.deletePassword],
    ['POST', /^\/api\/apps\/([^/]+)\/test-login$/, handlers.testLogin],
    ['POST', /^\/api\/apps\/([^/]+)\/deploy$/, handlers.deploy],
    ['GET', /^\/api\/apps\/([^/]+)\/deployments$/, handlers.listDeployments],
    ['GET', /^\/api\/apps\/([^/]+)\/deployments\/([^/]+)$/, handlers.getDeployment],
    ['GET', /^\/api\/apps\/([^/]+)\/deployments\/([^/]+)\/stream$/, handlers.stream],
    ['GET', /^\/api\/apps\/([^/]+)\/deployments\/([^/]+)\/log\.txt$/, handlers.logText],
    ['POST', /^\/api\/apps\/([^/]+)\/deployments\/([^/]+)\/cancel$/, handlers.cancel],
    ['GET', /^\/api\/apps\/([^/]+)\/registry$/, handlers.registry],
    ['GET', /^\/api\/apps\/([^/]+)\/health$/, handlers.health],
    ['POST', /^\/api\/check-folder$/, handlers.checkFolder],
  ];

  function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
    let file;
    if (pathname === '/lib/commands.js') file = path.join(ROOT, 'src', 'commands.js');
    else {
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
      file = path.resolve(PUBLIC, relative);
      if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
    }
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const boundPort = server.address()?.port ?? port;
      guard(req, boundPort);
      const { pathname } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(pathname);
        if (!match) continue;
        if (method !== req.method) continue;
        return await handler(req, res, ...match.slice(1).map(decodeURIComponent));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof ValidationError) return sendJson(res, 400, { error: error.message, fields: error.fields });
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message });
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof URIError) return sendJson(res, 400, { error: 'Bad address' });
      console.error(error);
      sendJson(res, 500, { error: error.message });
    }
  });

  return {
    server,
    store,
    vault,
    queue,
    watcher,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: nothing else on the network can reach this.
        server.listen(port, '127.0.0.1', () => {
          watcher.start();
          resolve(server.address().port);
        });
      });
    },
    close() {
      watcher.stop();
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
