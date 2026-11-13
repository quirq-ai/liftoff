import fs from 'node:fs';
import path from 'node:path';
import { liveUrlFor, parseImageRef, parseRepo } from './commands.js';
import { startDeployment } from './pipeline.js';
import { LIVE, ValidationError } from './store.js';
import { formatDuration, isPidAlive, readJson, writeJson, writeText } from './util.js';

/**
 * The queue is a JSON file you can edit by hand: a list of entries, oldest
 * first. To deploy, add an entry to the end and save:
 *
 *   { "app": 2, "src": "my-project" }
 *
 * "app" is the app's fixed number (or its id). "src" is the source folder,
 * relative to the folder the queue file is in, or a full path; leave it out
 * to use the folder the app already has. Leave "app" out and Liftoff picks
 * one: the app that already deploys that folder, otherwise a free app. "noCache": true skips the build
 * cache. To deploy again, add another entry.
 *
 * Liftoff picks up every entry that has no "status" yet, starts the deploy,
 * and writes the result back onto the same entry: status, id, asked, took,
 * image, url (where the deployed app answers), error. Adding "cancel": true to an entry that is waiting or running
 * cancels it. Deploys started from the page or a terminal are added to the
 * file too, so the file is the whole queue.
 */

const USER_FIELDS = ['app', 'src', 'noCache'];
const OPEN = ['waiting', 'running'];

/** The one word an entry carries for how its deploy went. */
export function fileStatus(record) {
  if (record.status === 'queued') return 'waiting';
  if (record.status === 'running') return 'running';
  if (record.status === 'succeeded') return record.verify?.status === 'verified' ? 'verified' : 'pushed';
  return record.status; // failed, cancelled
}

function stamp(isoTime) {
  const date = new Date(isoTime);
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Copy what is known about a deploy onto its entry. */
function describe(entry, record) {
  entry.id = record.id;
  entry.status = fileStatus(record);
  entry.asked = stamp(record.queuedAt ?? record.startedAt);
  delete entry.took;
  delete entry.image;
  delete entry.error;
  delete entry.url;
  if (LIVE.includes(record.status)) return;
  entry.took = formatDuration(record.durationMs);
  if (record.digest) entry.image = record.digest;
  if (record.status === 'succeeded') {
    const url = urlOf(record);
    if (url) entry.url = url;
  }
  if (record.error) entry.error = record.error;
}

/** The address the deployed app answers at; worked out from the image for deploys recorded before it was kept. */
function urlOf(record) {
  if (record.url !== undefined) return record.url;
  try {
    return liveUrlFor(parseImageRef(record.image));
  } catch {
    return null;
  }
}

/** One entry per line: easy to read, easy to add a line to. */
function format(entries) {
  if (!entries.length) return '[\n]\n';
  return `[\n${entries.map((entry) => `  ${JSON.stringify(entry, null, 1).replace(/\n\s*/g, ' ')}`).join(',\n')}\n]\n`;
}

const isEntry = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const userPart = (entry) => JSON.stringify(USER_FIELDS.map((key) => (isEntry(entry) ? entry[key] ?? null : null)));

export class QueueFile {
  constructor({ store, vault }) {
    this.store = store;
    this.vault = vault;
    this.shadowFile = path.join(store.home, 'queue-shadow.json');
    this.error = null;
    this.open = true; // true while some entry is still waiting or running
  }

  get file() {
    return this.store.queueFile();
  }

  /** Relative "src" folders start here. */
  get folder() {
    return path.dirname(this.file);
  }

  /** The entries in the file. Throws with a message for the page when the file cannot be read as a list. */
  #load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read ${this.file}: ${error.message}`);
      const entries = this.#seed();
      this.#save(entries);
      return entries;
    }
    text = text.replace(/^﻿/, '');
    if (!text.trim()) return [];
    let data;
    try {
      data = JSON.parse(text);
    } catch (strict) {
      try {
        // A comma left after the last entry is the usual slip when adding a line by hand.
        data = JSON.parse(text.replace(/,(\s*[\]}])/g, '$1'));
      } catch {
        throw new Error(`${path.basename(this.file)} is not valid JSON right now (${strict.message}). Nothing is started until it is fixed and saved.`);
      }
    }
    if (!Array.isArray(data)) throw new Error(`${path.basename(this.file)} should be a list of entries: [ { "app": 1, "src": "my-folder" } ]`);
    return data;
  }

  /** A first queue file at the standard place starts with the deploys already made, so nothing disappears from the page. */
  #seed() {
    if (this.file !== path.join(this.store.home, 'queue.json')) return [];
    const numbers = new Map(this.store.listApps().map((app) => [app.id, app.number]));
    return this.store.recentDeployments({ limit: 500 }).reverse().map((record) => {
      const entry = { app: numbers.get(record.appId) ?? record.appId, src: record.contextDir };
      if (record.options?.noCache) entry.noCache = true;
      describe(entry, record);
      return entry;
    });
  }

  #save(entries) {
    writeText(this.file, format(entries));
  }

  #app(reference) {
    if (Number.isInteger(reference)) {
      const apps = this.store.listApps();
      const app = apps.find((candidate) => candidate.number === reference);
      if (app) return app;
      const known = apps.map((candidate) => `${candidate.number} = ${candidate.name}`).join(', ');
      throw new Error(`There is no app number ${reference}. ${known ? `The apps are: ${known}.` : 'No apps have been added yet.'}`);
    }
    if (typeof reference === 'string' && reference.trim()) return this.store.findApp(reference);
    throw new Error('"app" should be the app\'s number, for example { "app": 1 }');
  }

  /**
   * Choose the app for an entry that names none.
   *   1. The app that already deploys this folder: the entry is a redeploy of it.
   *   2. Otherwise a free app: one with a stored password that has never had
   *      an image pushed and has nothing waiting. The lowest number goes first.
   * An app that already serves another project is never taken over; when
   * nothing is free the entry is refused and has to name its app.
   */
  #pick(folder) {
    const same = (a, b) => {
      const tidy = (value) => path.resolve(value).replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? tidy(a).toLowerCase() === tidy(b).toLowerCase() : tidy(a) === tidy(b);
    };
    const apps = this.store.listApps().sort((a, b) => a.number - b.number);
    // "Used" means something of this app's was pushed, or is on its way; a deploy that failed before the push leaves the app free.
    const used = (app) => this.store.listDeployments(app.id, { limit: 500 }).some((record) => record.digest || LIVE.includes(record.status));
    const owner = apps.find((app) => this.store.countDeployments(app.id) > 0 && same(app.contextDir, folder));
    if (owner) return owner;
    const free = apps.find((app) => !used(app) && this.vault.has(app.id));
    if (free) return free;
    const waitingForPassword = apps.filter((app) => !used(app)).map((app) => app.number);
    throw new Error(waitingForPassword.length
      ? `No app is available: app ${waitingForPassword.join(', ')} ${waitingForPassword.length === 1 ? 'is' : 'are'} unused but ${waitingForPassword.length === 1 ? 'has' : 'have'} no password stored yet. Store it, or name the app with "app".`
      : `No app is available: ${apps.length ? `all ${apps.length} already serve a project` : 'no apps have been added yet'}. Name the one to deploy to with "app".`);
  }

  /** A new entry: start its deploy, or say on the entry why it could not start. */
  #start(entry) {
    try {
      let src;
      let folder;
      if (entry.src !== undefined && entry.src !== null) {
        if (typeof entry.src !== 'string' || !entry.src.trim()) throw new Error('"src" should be a folder, for example "my-project"');
        const repo = parseRepo(entry.src);
        // A repository address is passed on as it is; its local copy lives beside the queue file.
        src = repo ? entry.src.trim() : path.resolve(this.folder, entry.src.trim());
        folder = repo ? path.join(this.folder, repo.name) : src;
        if (!repo && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.src.trim())) throw new Error(`"${entry.src.trim()}" is not a repository address Liftoff can clone`);
      }
      let app;
      if (entry.app === undefined || entry.app === null) {
        if (!src) throw new Error('An entry needs "src" (the folder to deploy), "app" (which app to deploy), or both');
        if (folder === src && !fs.existsSync(src)) throw new Error(`The source folder does not exist: ${src}`);
        app = this.#pick(folder);
        entry.app = app.number; // written back, so the file says where it went
      } else {
        app = this.#app(entry.app);
      }
      const { record } = startDeployment({ store: this.store, vault: this.vault, app, trigger: 'file', options: { src, cloneInto: this.folder, noCache: entry.noCache === true } });
      describe(entry, record);
    } catch (error) {
      entry.status = 'rejected';
      entry.asked = stamp(Date.now());
      entry.error = error.fields ? Object.values(error.fields)[0] : error.message;
    }
  }

  /** An entry whose deploy is under way: bring its status up to date, and pass on a cancel request. */
  #refresh(entry) {
    const record = this.store.findDeployment(entry.id);
    if (!record) {
      entry.status = 'failed';
      entry.error = 'Liftoff has no record of this deploy any more.';
      return;
    }
    if (entry.cancel === true && LIVE.includes(record.status)) this.store.requestCancel(record.appId, record.id);
    describe(entry, record);
  }

  /**
   * Read the file, act on it, and write back what changed.
   * With `trigger`, entries that have no status yet are started; without it
   * they are left for the Liftoff that watches the file.
   */
  sync({ trigger = false } = {}) {
    let entries;
    try {
      entries = this.#load();
      this.error = null;
    } catch (error) {
      this.error = error.message;
      return null;
    }
    const before = format(entries);

    // An editor that still shows an older copy can save entries without the status Liftoff wrote on them.
    // When the file is what Liftoff last wrote plus added lines, put the known results back instead of deploying twice.
    const shadow = readJson(this.shadowFile, {});
    const known = shadow.file === this.file && Array.isArray(shadow.entries) ? shadow.entries : [];
    const onlyAppended = known.every((old, index) => userPart(entries[index]) === userPart(old));

    entries.forEach((entry, index) => {
      if (!isEntry(entry)) return;
      if (entry.status === undefined) {
        if (onlyAppended && isEntry(known[index]) && known[index].status !== undefined) Object.assign(entry, known[index]);
        else if (trigger) this.#start(entry);
        else return;
      }
      if (entry.id && OPEN.includes(entry.status)) this.#refresh(entry);
      // Entries finished before addresses were written get theirs now.
      else if (entry.id && ['verified', 'pushed'].includes(entry.status) && entry.url === undefined) {
        const record = this.store.findDeployment(entry.id);
        const url = record ? urlOf(record) : null;
        if (url) entry.url = url;
      }
    });

    if (format(entries) !== before) this.#save(entries);
    if (JSON.stringify(known) !== JSON.stringify(entries) || shadow.file !== this.file) writeJson(this.shadowFile, { file: this.file, entries });
    this.open = entries.some((entry) => isEntry(entry) && (entry.status === undefined || OPEN.includes(entry.status)));
    return entries;
  }

  /**
   * Add an entry the same way a hand edit would: { app, src?, noCache? } goes on
   * the end of the file. It is checked first, so a bad one is refused instead of
   * being written. With `trigger` the deploy is started right away and the
   * entry comes back with its id and status.
   */
  add(input, { trigger = false } = {}) {
    let entries;
    try {
      entries = this.#load();
    } catch (error) {
      throw new ValidationError({ queue: error.message });
    }
    const entry = {};
    const anyApp = input?.app === undefined || input.app === null || input.app === '';
    if (!anyApp) {
      const wanted = typeof input.app === 'string' && /^\d+$/.test(input.app.trim()) ? Number(input.app) : input.app;
      try {
        entry.app = Number.isInteger(wanted) ? wanted : this.#app(wanted).number;
        this.#app(entry.app);
      } catch (error) {
        throw new ValidationError({ app: error.message });
      }
    }
    let folder = null;
    if (input.src !== undefined && input.src !== null && input.src !== '') {
      if (typeof input.src !== 'string') throw new ValidationError({ src: '"src" should be a folder, for example "my-project"' });
      const repo = parseRepo(input.src);
      if (!repo && /^[a-z][a-z0-9+.-]*:\/\//i.test(input.src.trim())) throw new ValidationError({ src: `"${input.src.trim()}" is not a repository address Liftoff can clone. Use an https:// or git@ address.` });
      folder = repo ? path.join(this.folder, repo.name) : path.resolve(this.folder, input.src.trim());
      let found = Boolean(repo); // a repository is cloned when its turn comes
      try {
        found ||= fs.statSync(folder).isDirectory();
      } catch { /* reported below */ }
      if (!found) throw new ValidationError({ src: `The source folder does not exist: ${folder}` });
      entry.src = input.src.trim();
    }
    if (anyApp) {
      // No app named: make sure one can be chosen before anything is written.
      if (!folder) throw new ValidationError({ src: 'Give the folder to deploy; without an app Liftoff picks one for it' });
      try {
        this.#pick(folder);
      } catch (error) {
        throw new ValidationError({ app: error.message });
      }
    }
    if (input.noCache === true) entry.noCache = true;

    entries.push(entry);
    this.#save(entries);
    this.open = true;
    const index = entries.length - 1;
    const synced = trigger ? this.sync({ trigger: true }) : null;
    return synced?.[index] ?? entry;
  }

  /** Add the entry for a deploy that was started from the page or a terminal. */
  record(record, app) {
    let entries;
    try {
      entries = this.#load();
    } catch {
      return; // the file is being edited; the deploy itself is not held up by that
    }
    if (entries.some((existing) => isEntry(existing) && existing.id === record.id)) return;
    const entry = { app: app.number, src: record.contextDir };
    if (record.options?.noCache) entry.noCache = true;
    describe(entry, record);
    entries.push(entry);
    this.#save(entries);
    this.open = true;
  }

  /** What the Queue page shows: the file, newest entry first, with each entry's app looked up. */
  view() {
    const apps = this.store.listApps();
    let entries = [];
    let error = this.error;
    try {
      entries = this.#load();
    } catch (failure) {
      error = failure.message;
    }
    const rows = entries.map((entry, index) => {
      if (!isEntry(entry)) return { index, status: 'rejected', error: 'This line is not an entry like { "app": 1, "src": "my-folder" }' };
      const record = entry.id ? this.store.findDeployment(entry.id) : null;
      const app = record
        ? apps.find((candidate) => candidate.id === record.appId)
        : apps.find((candidate) => candidate.number === entry.app || candidate.id === entry.app);
      return { ...entry, index, status: entry.status ?? 'new', appId: app?.id ?? null, appName: app?.name ?? null, deploy: record?.number ?? null };
    });
    return { file: this.file, folder: this.folder, error, entries: rows.reverse() };
  }
}

/**
 * Keeps an eye on the queue file: once a second it checks whether the file
 * changed or a deploy is still under way, and syncs if so. Only one Liftoff
 * per data folder starts new entries, so two of them never deploy an entry twice.
 */
export class QueueWatcher {
  constructor(queue, { intervalMs = 1000 } = {}) {
    this.queue = queue;
    this.intervalMs = intervalMs;
    this.lockFile = path.join(queue.store.home, 'watcher.lock');
    this.owner = false;
    this.seen = null;
    this.timer = null;
  }

  #claim() {
    if (this.owner) return true;
    let holder = 0;
    try {
      holder = Number(fs.readFileSync(this.lockFile, 'utf8'));
    } catch { /* nobody holds it */ }
    if (holder && holder !== process.pid && isPidAlive(holder)) return false;
    fs.writeFileSync(this.lockFile, String(process.pid));
    this.owner = true;
    return true;
  }

  #stat() {
    try {
      const stat = fs.statSync(this.queue.file);
      return `${this.queue.file}|${stat.mtimeMs}|${stat.size}`;
    } catch {
      return `${this.queue.file}|missing`;
    }
  }

  tick() {
    try {
      const trigger = this.#claim();
      if (this.#stat() === this.seen && !this.queue.open) return;
      this.queue.sync({ trigger });
      this.seen = this.#stat();
    } catch (error) {
      this.queue.error = error.message;
    }
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.owner) fs.rmSync(this.lockFile, { force: true });
    this.owner = false;
  }
}
