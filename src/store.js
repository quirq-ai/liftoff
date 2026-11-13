import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { liveUrlFor, splitArgs } from './commands.js';
import { isPidAlive, readJson, writeJson } from './util.js';

/**
 * Everything Liftoff remembers, as plain files under the Liftoff folder:
 *
 *   apps.json                         the apps and their settings (no secrets)
 *   deployments/<app>/<id>.json       one record per deploy
 *   deployments/<app>/<id>.log        that deploy's output, one JSON object per line
 *
 * One file per deploy means the server and a `liftoff deploy` in a terminal can
 * run side by side without overwriting each other.
 */

export const STEP_KEYS = ['preflight', 'login', 'build', 'push', 'verify'];
export const HEARTBEAT_MS = 10_000;
const STALE_MS = 90_000;
/** A deploy that is waiting for its turn or running. Everything else is finished. */
export const LIVE = ['queued', 'running'];

const PATTERNS = {
  id: /^[a-z0-9][a-z0-9._-]{0,79}$/,
  registry: /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/,
  repository: /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/,
  tag: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
  platform: /^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/,
  deployment: /^d[a-z0-9]{8,24}$/,
};

export class ValidationError extends Error {
  constructor(fields) {
    super(Object.values(fields)[0]);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** Check and tidy the settings of an app. Throws ValidationError naming each bad field. */
export function normalizeApp(input) {
  const errors = {};
  const app = {
    name: text(input.name),
    registry: text(input.registry).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    repository: text(input.repository).replace(/^\/+|\/+$/g, ''),
    tag: text(input.tag) || 'latest',
    username: text(input.username),
    contextDir: text(input.contextDir),
    dockerfile: text(input.dockerfile),
    platform: text(input.platform) || 'linux/amd64',
    buildFlags: text(input.buildFlags),
    liveUrl: text(input.liveUrl),
  };

  if (!app.name) errors.name = 'Give the app a name';
  else if (app.name.length > 80) errors.name = 'Name is too long';

  if (!app.registry) errors.registry = 'Registry host is required, for example registry.xo.builders';
  else if (!PATTERNS.registry.test(app.registry)) errors.registry = 'Registry should be a host name like registry.xo.builders';

  if (!app.repository) errors.repository = 'Repository is required, for example my-app-xo-abc123/app';
  else if (!PATTERNS.repository.test(app.repository)) errors.repository = 'Repository can use lowercase letters, digits, dots, dashes and slashes';

  if (!PATTERNS.tag.test(app.tag)) errors.tag = 'Tag can use letters, digits, dots, dashes and underscores';

  if (!app.username) errors.username = 'Push username is required, for example xo-my-app+push';
  else if (/[\s:]/.test(app.username) || app.username.length > 255) errors.username = 'Username cannot contain spaces or colons';

  if (!app.contextDir) errors.contextDir = 'Choose the folder that holds the Dockerfile';
  else if (!path.isAbsolute(app.contextDir)) errors.contextDir = 'Use a full path, for example D:\\projects\\my-app';
  else app.contextDir = path.normalize(app.contextDir).replace(/[\\/]+$/, '') || app.contextDir;

  if (!PATTERNS.platform.test(app.platform)) errors.platform = 'Platform looks like linux/amd64';

  if (app.buildFlags) {
    try {
      const flags = splitArgs(app.buildFlags);
      const fromFields = flags.find((flag) => /^(-t|--tag|--platform|-f|--file)(=|$)/.test(flag));
      const output = flags.find((flag) => /^(--push|--load|-o|--output)(=|$)/.test(flag));
      if (fromFields) errors.buildFlags = `${fromFields.split('=')[0]} comes from the fields above; remove it from the extra flags`;
      else if (output) errors.buildFlags = `${output.split('=')[0]} would skip Liftoff's own push step; remove it from the extra flags`;
    } catch {
      errors.buildFlags = 'Extra build flags have an unclosed quote';
    }
  }

  if (app.liveUrl) {
    let url = null;
    try {
      url = new URL(app.liveUrl);
    } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) errors.liveUrl = 'Live address should start with https://';
    else app.liveUrl = url.href;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return app;
}

function slugFor(app) {
  const base = (app.repository.split('/')[0] || app.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 60);
  return base || 'app';
}

export class Store {
  constructor(home) {
    this.home = home;
    this.appsFile = path.join(home, 'apps.json');
    this.deploymentsDir = path.join(home, 'deployments');
    // One small marker per waiting or running deploy, so the queue can be read without opening the whole history.
    this.queueDir = path.join(home, 'active');
    this.settingsFile = path.join(home, 'settings.json');
    fs.mkdirSync(this.deploymentsDir, { recursive: true });
    fs.mkdirSync(this.queueDir, { recursive: true });
    try {
      fs.rmdirSync(path.join(home, 'queue')); // the markers' earlier home; only goes if it is empty
    } catch { /* not there, or in use */ }
  }

  // --- settings ---------------------------------------------------------------
  /** The queue file: the list of deploy entries you edit by hand. Relative folders in it start from its own folder. */
  queueFile() {
    return readJson(this.settingsFile, {}).queueFile || path.join(this.home, 'queue.json');
  }

  setQueueFile(file) {
    const wanted = typeof file === 'string' ? file.trim() : '';
    if (!wanted || !path.isAbsolute(wanted)) throw new ValidationError({ queueFile: 'Use a full path, for example D:\\projects\\queue.json' });
    if (path.extname(wanted).toLowerCase() !== '.json') throw new ValidationError({ queueFile: 'The queue file should end in .json' });
    writeJson(this.settingsFile, { ...readJson(this.settingsFile, {}), queueFile: path.normalize(wanted) });
    return this.queueFile();
  }

  // --- apps -----------------------------------------------------------------
  /** Every app has a number that is given once and never reused; older data gets its numbers here. */
  #readAppsFile() {
    const data = readJson(this.appsFile, { version: 1, apps: [] });
    let next = Math.max(0, data.nextNumber ? data.nextNumber - 1 : 0, ...data.apps.map((app) => app.number || 0));
    const unnumbered = data.apps.filter((app) => !Number.isInteger(app.number)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const app of unnumbered) app.number = ++next;
    if (unnumbered.length) writeJson(this.appsFile, { version: 1, nextNumber: next + 1, apps: data.apps });
    return { apps: data.apps, nextNumber: next + 1 };
  }

  #readApps() {
    return this.#readAppsFile().apps;
  }

  #writeApps(apps, nextNumber = this.#readAppsFile().nextNumber) {
    writeJson(this.appsFile, { version: 1, nextNumber, apps });
  }

  listApps() {
    return this.#readApps().sort((a, b) => a.name.localeCompare(b.name));
  }

  getApp(id) {
    const app = this.#readApps().find((candidate) => candidate.id === id);
    if (!app) throw new NotFoundError(`No app "${id}"`);
    return app;
  }

  /** Find an app by id, by name, or by the start of its id (handy on the command line). */
  findApp(reference) {
    const apps = this.#readApps();
    const wanted = String(reference ?? '').trim().toLowerCase();
    if (/^#?\d+$/.test(wanted)) {
      const numbered = apps.find((app) => app.number === Number(wanted.replace('#', '')));
      if (numbered) return numbered;
    }
    const exact = apps.find((app) => app.id === wanted) ?? apps.find((app) => app.name.toLowerCase() === wanted);
    if (exact) return exact;
    const partial = wanted ? apps.filter((app) => app.id.startsWith(wanted)) : [];
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new NotFoundError(`"${reference}" matches several apps: ${partial.map((app) => app.id).join(', ')}`);
    throw new NotFoundError(`No app "${reference}". Run "liftoff list" to see the apps.`);
  }

  createApp(input) {
    const { apps, nextNumber } = this.#readAppsFile();
    const app = normalizeApp(input);
    const clash = apps.find((other) => other.registry === app.registry && other.repository === app.repository && other.tag === app.tag);
    if (clash) throw new ValidationError({ repository: `"${clash.name}" already deploys to this image` });
    const base = slugFor(app);
    let id = base;
    for (let n = 2; apps.some((other) => other.id === id); n++) id = `${base}-${n}`;
    const now = new Date().toISOString();
    const created = { id, number: nextNumber, ...app, createdAt: now, updatedAt: now };
    this.#writeApps([...apps, created], nextNumber + 1);
    return created;
  }

  updateApp(id, input) {
    const apps = this.#readApps();
    const index = apps.findIndex((app) => app.id === id);
    if (index === -1) throw new NotFoundError(`No app "${id}"`);
    const next = normalizeApp({ ...apps[index], ...input });
    const clash = apps.find((other) => other.id !== id && other.registry === next.registry && other.repository === next.repository && other.tag === next.tag);
    if (clash) throw new ValidationError({ repository: `"${clash.name}" already deploys to this image` });
    apps[index] = { id, number: apps[index].number, ...next, createdAt: apps[index].createdAt, updatedAt: new Date().toISOString() };
    this.#writeApps(apps);
    return apps[index];
  }

  /** Forget an app: its settings and its deploy history on this computer. */
  deleteApp(id) {
    const apps = this.#readApps();
    if (!apps.some((app) => app.id === id)) throw new NotFoundError(`No app "${id}"`);
    this.#writeApps(apps.filter((app) => app.id !== id));
    fs.rmSync(this.#appDir(id), { recursive: true, force: true });
  }

  // --- deployments ------------------------------------------------------------
  #appDir(appId) {
    if (!PATTERNS.id.test(appId)) throw new NotFoundError('Unknown app');
    return path.join(this.deploymentsDir, appId);
  }

  #file(appId, id, extension) {
    if (!PATTERNS.deployment.test(id)) throw new NotFoundError('Unknown deploy');
    return path.join(this.#appDir(appId), `${id}.${extension}`);
  }

  #ids(appId) {
    try {
      return fs.readdirSync(this.#appDir(appId))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .filter((id) => PATTERNS.deployment.test(id))
        .sort()
        .reverse();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** A deploy whose process died never got to write its ending; write it for it. */
  #reconcile(record) {
    if (!LIVE.includes(record.status)) return record;
    const lastSign = Date.parse(record.heartbeatAt || record.startedAt);
    if (isPidAlive(record.pid) && Date.now() - lastSign < STALE_MS) return record;
    record.error = record.status === 'queued'
      ? 'Liftoff stopped while this deploy was waiting in the queue.'
      : 'Liftoff stopped before this deploy finished.';
    record.status = 'failed';
    record.finishedAt = record.heartbeatAt || record.startedAt;
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    for (const step of record.steps) {
      if (step.status === 'running') step.status = 'failed';
      else if (step.status === 'pending') step.status = 'skipped';
    }
    this.saveDeployment(record);
    return record;
  }

  /** A new deploy starts out waiting in the queue; whoever runs it marks it running when its turn comes. */
  createDeployment(app, { trigger = 'app', options = {}, command = `deploy ${app.id}` } = {}) {
    const latest = this.latestDeployment(app.id);
    const now = new Date();
    const record = {
      id: `d${now.getTime().toString(36).padStart(9, '0')}${crypto.randomBytes(2).toString('hex')}`,
      appId: app.id,
      number: (latest?.number ?? 0) + 1,
      status: 'queued',
      trigger,
      command,
      options,
      image: `${app.registry}/${app.repository}:${app.tag}`,
      url: liveUrlFor(app),
      platform: app.platform,
      contextDir: app.contextDir,
      queuedAt: now.toISOString(),
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      pid: process.pid,
      steps: STEP_KEYS.map((key) => ({ key, status: 'pending' })),
    };
    this.saveDeployment(record);
    fs.writeFileSync(path.join(this.queueDir, record.id), app.id);
    return record;
  }

  saveDeployment(record) {
    writeJson(this.#file(record.appId, record.id, 'json'), record);
    if (!LIVE.includes(record.status)) fs.rmSync(path.join(this.queueDir, record.id), { force: true });
  }

  /** Deploys that are waiting or running, across all apps, oldest first. */
  activeDeployments() {
    let names = [];
    try {
      names = fs.readdirSync(this.queueDir);
    } catch { /* nothing queued yet */ }
    const live = [];
    for (const id of names.filter((name) => PATTERNS.deployment.test(name)).sort()) {
      const marker = path.join(this.queueDir, id);
      try {
        const record = this.getDeployment(fs.readFileSync(marker, 'utf8').trim(), id);
        if (LIVE.includes(record.status)) live.push(record);
        else fs.rmSync(marker, { force: true });
      } catch {
        // A marker with no deploy behind it; leave a brand-new one alone, it may still be being written.
        try {
          if (Date.now() - fs.statSync(marker).mtimeMs > 5000) fs.rmSync(marker, { force: true });
        } catch { /* already gone */ }
      }
    }
    return live;
  }

  /** The latest deploys across all apps, newest first: what is waiting, what is running, what ran. */
  recentDeployments({ limit = 100 } = {}) {
    const all = [];
    for (const appId of fs.readdirSync(this.deploymentsDir)) {
      if (!PATTERNS.id.test(appId)) continue;
      for (const id of this.#ids(appId)) all.push([id, appId]);
    }
    all.sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return all.slice(0, limit).map(([id, appId]) => this.getDeployment(appId, id));
  }

  getDeployment(appId, id) {
    const record = readJson(this.#file(appId, id, 'json'), null);
    if (!record) throw new NotFoundError('Unknown deploy');
    return this.#reconcile(record);
  }

  /** Find a deploy by its id alone, whichever app it belongs to. Null when there is none. */
  findDeployment(id) {
    if (typeof id !== 'string' || !PATTERNS.deployment.test(id)) return null;
    for (const appId of fs.readdirSync(this.deploymentsDir)) {
      if (PATTERNS.id.test(appId) && fs.existsSync(path.join(this.deploymentsDir, appId, `${id}.json`))) return this.getDeployment(appId, id);
    }
    return null;
  }

  listDeployments(appId, { limit = 50 } = {}) {
    return this.#ids(appId).slice(0, limit).map((id) => this.getDeployment(appId, id));
  }

  latestDeployment(appId) {
    const [id] = this.#ids(appId);
    return id ? this.getDeployment(appId, id) : null;
  }

  countDeployments(appId) {
    return this.#ids(appId).length;
  }

  logFile(appId, id) {
    return this.#file(appId, id, 'log');
  }

  /** Returns a writer that appends one JSON line per entry, in order. */
  openLog(appId, id) {
    const file = this.logFile(appId, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(file, 'a');
    let open = true;
    return {
      write(entry) {
        if (open) fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
      },
      close() {
        if (open) fs.closeSync(handle);
        open = false;
      },
    };
  }

  readLog(appId, id) {
    let raw = '';
    try {
      raw = fs.readFileSync(this.logFile(appId, id), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return raw.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { t: 0, step: '', s: 'out', m: line };
      }
    });
  }

  /** Cancelling works across processes: whoever runs the deploy watches for this marker. */
  requestCancel(appId, id) {
    fs.writeFileSync(this.#file(appId, id, 'cancel'), new Date().toISOString());
  }

  cancelRequested(appId, id) {
    return fs.existsSync(this.#file(appId, id, 'cancel'));
  }

  clearCancel(appId, id) {
    fs.rmSync(this.#file(appId, id, 'cancel'), { force: true });
  }
}
