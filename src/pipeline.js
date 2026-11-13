import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseRepo, repoKey, splitArgs } from './commands.js';
import * as docker from './docker.js';
import { headManifest, RegistryError } from './registry.js';
import { HEARTBEAT_MS, ValidationError } from './store.js';
import { formatBytes, shortDigest } from './util.js';

/**
 * One deploy, start to finish:
 *
 *   preflight  folder, Dockerfile, stored password and Docker engine are all there
 *   login      docker login <registry> -u <user> --password-stdin   (password from the vault)
 *   build      docker build --platform <platform> -t <image> .
 *   push       docker push <image>
 *   verify     ask the registry what the tag points to and compare with what was pushed
 *
 * The unencrypted password touches the disk only inside a private Docker config
 * folder while `login` and `push` run; the folder is deleted right after each.
 */

/** A failure with a message written for the person deploying. */
class StepFailure extends Error {}

const iso = () => new Date().toISOString();

/** Colour and cursor codes that build tools print for a terminal; they are noise in a stored log. */
const ANSI_CODES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const DOCKER_STORE_WARNING =/^WARNING! Your password will be stored unencrypted|^Configure a credential helper to remove this warning|^https:\/\/docs\.docker\.com\/\S*credentials?-store/;

function quote(args) {
  return args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(' ');
}

/** Every form the password could take in command output, so none of them reaches a log. */
function redactor(username, password) {
  const forms = [
    password,
    Buffer.from(password, 'utf8').toString('base64'),
    Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
  ].filter((form) => form.length >= 4);
  return (text) => forms.reduce((result, form) => result.replaceAll(form, '[hidden]'), String(text));
}

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/** Which commit is being deployed, when the source folder is in a git repository. */
async function gitInfo(dir) {
  const commit = await git(dir, ['rev-parse', '--short', 'HEAD']);
  if (!commit) return null;
  const [branch, status, subject] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['log', '-1', '--format=%s']),
  ]);
  return {
    commit,
    branch: branch || null,
    subject: subject ? subject.slice(0, 140) : null,
    dirty: status == null ? null : status.split('\n').filter(Boolean).length,
  };
}

function explainLoginFailure(tail, app, clean) {
  const text = tail.join('\n');
  if (/unauthorized|authentication required|incorrect username or password|401/i.test(text)) {
    return `${app.registry} rejected the username or password for ${app.username}. Check both against Launchpad and save the password again.`;
  }
  if (/no such host|dial tcp|i\/o timeout|connection refused|deadline exceeded|x509|tls/i.test(text)) {
    return `Docker could not reach ${app.registry}: ${clean(tail.filter(Boolean).pop() ?? 'no answer')}`;
  }
  return `docker login failed: ${clean(tail.filter(Boolean).pop() ?? 'no output')}`;
}

function explainPushFailure(tail, app, clean) {
  const text = tail.join('\n');
  if (/denied|unauthorized|authentication required/i.test(text)) {
    return `${app.registry} refused the push to ${app.repository}. The account ${app.username} may not belong to this app.`;
  }
  return `docker push failed: ${clean(tail.filter(Boolean).pop() ?? 'no output')}`;
}

async function loginOnce(app, password, endpoint, { onLine, signal } = {}) {
  const session = docker.createSession(app.registry, endpoint);
  try {
    return await docker.runDocker(['login', app.registry, '-u', app.username, '--password-stdin'], {
      env: session.env,
      input: password,
      onLine,
      signal,
      timeoutMs: 60_000,
    });
  } finally {
    session.dispose();
  }
}

/** Check the stored password against the registry without building or pushing anything. */
export async function testLogin({ app, vault }) {
  if (!vault.has(app.id)) return { ok: false, message: 'No password is stored for this app yet.' };
  const password = await vault.get(app.id);
  const clean = redactor(app.username, password);
  const engine = await docker.inspectEngine();
  if (!engine.ok) return { ok: false, message: `Docker is not available: ${engine.error}. Start Docker Desktop and try again.` };
  const result = await loginOnce(app, password, await docker.resolveEndpoint());
  if (result.code === 0) return { ok: true, message: `${app.registry} accepted ${app.username}.` };
  return { ok: false, message: explainLoginFailure(result.tail, app, clean) };
}

/**
 * Start a deploy. Returns at once with the new record, a promise that settles
 * with the finished record, and a way to cancel it from this process (another
 * process cancels through store.requestCancel). The promise never rejects:
 * failures are written into the record.
 */
export function startDeployment({ store, vault, app: given, trigger = 'app', options = {}, onEvent }) {
  let app = given;
  const flags = [];
  const kept = { noCache: Boolean(options.noCache) };

  // "--src": point the app at another source folder, for this deploy and the ones after it.
  const src = typeof options.src === 'string' ? options.src.trim() : '';
  const repo = parseRepo(src);
  if (repo) {
    // A repository address: the source folder is its local copy, cloned during the checks if it is not there yet.
    if (!options.cloneInto) throw new ValidationError({ contextDir: 'There is no folder set to clone repositories into' });
    app = store.updateApp(app.id, { contextDir: path.join(options.cloneInto, repo.name) });
    kept.src = app.contextDir;
    kept.repo = { url: repo.url, branch: repo.branch };
    flags.push('--src', src);
  } else if (src) {
    if (!path.isAbsolute(src)) throw new ValidationError({ contextDir: 'Use a full path for the source folder' });
    let found = false;
    try {
      found = fs.statSync(src).isDirectory();
    } catch { /* reported below */ }
    if (!found) throw new ValidationError({ contextDir: `The source folder does not exist: ${src}` });
    app = store.updateApp(app.id, { contextDir: src });
    kept.src = app.contextDir;
    flags.push('--src', app.contextDir);
  }
  if (kept.noCache) flags.push('--no-cache');

  // The deploy keeps its own copy of the settings, so later edits do not change a deploy that is already waiting.
  const record = store.createDeployment(app, { trigger, options: kept, command: `deploy ${quote([app.id, ...flags])}` });
  const controller = new AbortController();
  const done = run({ store, vault, app, record, onEvent, controller }).catch((error) => {
    // Only reachable when Liftoff cannot write its own files (disk full, folder removed).
    record.status = 'failed';
    record.error = `Liftoff could not record this deploy: ${error.message}`;
    record.finishedAt = iso();
    try {
      store.saveDeployment(record);
    } catch { /* nothing left to write to */ }
    return record;
  });
  return { record, done, cancel: () => controller.abort() };
}

async function run({ store, vault, app, record, onEvent, controller }) {
  const { signal } = controller;
  const log = store.openLog(app.id, record.id);
  let clean = (text) => String(text);

  const write = (step, stream, message) => {
    const entry = { t: Date.now(), step, s: stream, m: clean(message).replace(ANSI_CODES, '') };
    log.write(entry);
    onEvent?.({ type: 'log', entry });
  };
  const save = () => {
    record.heartbeatAt = iso();
    store.saveDeployment(record);
    onEvent?.({ type: 'record', record });
  };
  const lines = (step) => (text, stream) => write(step, stream, text);

  const cancelWatch = setInterval(() => {
    if (!signal.aborted && store.cancelRequested(app.id, record.id)) controller.abort();
  }, 500);
  const heartbeat = setInterval(save, HEARTBEAT_MS);

  async function step(key, work) {
    const state = record.steps.find((candidate) => candidate.key === key);
    const started = Date.now();
    state.status = 'running';
    state.startedAt = iso();
    save();
    try {
      await work(state);
      if (signal.aborted) throw new docker.CancelledError();
      if (state.status === 'running') state.status = 'ok';
    } catch (error) {
      state.status = signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      state.finishedAt = iso();
      state.durationMs = Date.now() - started;
      save();
    }
  }

  let password = null;
  let endpoint = null;
  let started = false;

  /** One deploy runs at a time. Wait until nothing is running and nothing older is waiting. */
  async function waitForTurn() {
    let announced = false;
    for (;;) {
      if (signal.aborted) throw new docker.CancelledError();
      const ahead = store.activeDeployments().filter((other) => other.id !== record.id && (other.status === 'running' || other.id < record.id));
      if (!ahead.length) break;
      if (!announced) {
        announced = true;
        write('preflight', 'sys', `Waiting in the queue behind ${ahead.length} other deploy${ahead.length === 1 ? '' : 's'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    started = true;
    record.status = 'running';
    record.startedAt = iso();
    save();
  }

  /**
   * The source is a repository: use the local copy when there is one, clone it when there is not.
   * A copy that is already there is used as it is; it is not updated.
   */
  async function fetchSource(repo, dir) {
    if (fs.existsSync(dir)) {
      const origin = await git(dir, ['remote', 'get-url', 'origin']);
      if (origin && repoKey(origin) !== repoKey(repo.url)) {
        throw new StepFailure(`${dir} already exists but holds a different repository (${origin}). Move it away, or give the folder itself as the source.`);
      }
      write('preflight', 'sys', `Repository ${repo.url}: using the copy already in ${dir} (not updated)`);
      return;
    }
    const args = ['clone', '--progress'];
    if (repo.branch) args.push('--branch', repo.branch);
    args.push('--', repo.url, dir);
    write('preflight', 'cmd', `git ${quote(args)}`);
    let result;
    try {
      result = await docker.runProcess('git', args, {
        // Never stop to ask for a username or password; a private repository needs credentials git already has.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        onLine: lines('preflight'),
        signal,
        missing: 'git was not found on this computer; it is needed to clone a repository.',
      });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error instanceof docker.CancelledError ? error : new StepFailure(error.message);
    }
    if (result.code !== 0) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const reason = clean(result.tail.filter((line) => /fatal|error/i.test(line)).pop() ?? result.tail.filter(Boolean).pop() ?? 'no output');
      throw new StepFailure(`Could not clone ${repo.url}: ${reason.replace(/^fatal:\s*/i, '')}`);
    }
  }

  try {
    await waitForTurn();
    await step('preflight', async () => {
      write('preflight', 'sys', `Deploy #${record.number} of ${app.name}: ${record.image} (${app.platform})`);
      if (record.options.repo) await fetchSource(record.options.repo, app.contextDir);

      let folder = null;
      try {
        folder = fs.statSync(app.contextDir);
      } catch { /* reported below */ }
      if (!folder?.isDirectory()) throw new StepFailure(`The source folder does not exist: ${app.contextDir}`);
      const dockerfile = path.resolve(app.contextDir, app.dockerfile || 'Dockerfile');
      if (!fs.existsSync(dockerfile)) throw new StepFailure(`There is no Dockerfile at ${dockerfile}`);
      write('preflight', 'sys', `Source folder: ${app.contextDir}`);

      if (!vault.has(app.id)) {
        throw new StepFailure('No password is stored for this app yet. Save it in the app (or run: liftoff set-password ' + app.id + ').');
      }
      password = await vault.get(app.id);
      clean = redactor(app.username, password);
      write('preflight', 'sys', `Password for ${app.username}: read from the vault`);

      const engine = await docker.inspectEngine();
      if (!engine.ok) throw new StepFailure(`Docker is not available: ${engine.error}. Start Docker Desktop and deploy again.`);
      endpoint = await docker.resolveEndpoint();
      write('preflight', 'sys', `Docker engine ${engine.server}${endpoint ? ` at ${endpoint}` : ''}`);

      const source = await gitInfo(app.contextDir);
      if (source) {
        record.git = source;
        const changes = source.dirty ? `, with ${source.dirty} uncommitted change${source.dirty === 1 ? '' : 's'}` : '';
        write('preflight', 'sys', `Source: ${source.branch ?? 'detached'} @ ${source.commit}${changes}`);
      }
    });

    await step('login', async () => {
      write('login', 'cmd', `docker login ${app.registry} -u ${app.username} --password-stdin`);
      write('login', 'sys', 'The password is piped in from the vault. Docker holds it unencrypted in a private config folder only while this step runs; the folder is deleted right after. The login saved in your own Docker is not touched.');
      const result = await loginOnce(app, password, endpoint, {
        signal,
        // Docker's stock warning about that folder, and its advice to set up a credential helper, are covered by the note above.
        onLine: (text, stream) => DOCKER_STORE_WARNING.test(text) || !text.trim() || write('login', stream, text),
      });
      if (result.code !== 0) throw new StepFailure(explainLoginFailure(result.tail, app, clean));
    });

    await step('build', async () => {
      const args = ['build', '--platform', app.platform, '-t', record.image];
      if (app.dockerfile) args.push('-f', app.dockerfile);
      if (record.options.noCache) args.push('--no-cache');
      args.push(...splitArgs(app.buildFlags), '.');
      write('build', 'cmd', `docker ${quote(args)}`);
      const result = await docker.runDocker(args, {
        cwd: app.contextDir,
        env: { ...process.env, BUILDKIT_PROGRESS: 'plain' },
        onLine: lines('build'),
        signal,
      });
      if (result.code !== 0) {
        const reason = result.tail.findLast((line) => /^ERROR\b|failed to solve/i.test(line.trim()))?.trim().replace(/^ERROR:\s*/i, '');
        throw new StepFailure(reason
          ? `docker build failed: ${reason.length > 400 ? `${reason.slice(0, 400)}…` : reason}`
          : `docker build failed (exit code ${result.code}). The build output shows the failing step.`);
      }

      const image = await docker.imageInfo(record.image, { signal });
      if (!image) throw new StepFailure(`The build finished but docker has no image named ${record.image}. A custom buildx builder that does not load images may be selected.`);
      record.imageId = image.id;
      record.imageSize = image.size;
      record.builtPlatform = `${image.os}/${image.architecture}`;
      const [wantedOs, wantedArch] = app.platform.split('/');
      if (image.os !== wantedOs || image.architecture !== wantedArch) {
        throw new StepFailure(`The image came out as ${record.builtPlatform}, not ${app.platform}; Launchpad could not run it. Check the base image in the Dockerfile.`);
      }
      write('build', 'sys', `Built ${shortDigest(image.id)}, ${formatBytes(image.size)}, ${record.builtPlatform}`);
    });

    await step('push', async () => {
      write('push', 'cmd', `docker push ${record.image}`);
      const session = docker.createSession(app.registry, endpoint, { username: app.username, password });
      let digest = null;
      try {
        const result = await docker.runDocker(['push', record.image], {
          env: session.env,
          signal,
          onLine(text, stream) {
            const match = /digest:\s*(sha256:[0-9a-f]{64})/.exec(text);
            if (match) digest = match[1];
            write('push', stream, text);
          },
        });
        if (result.code !== 0) throw new StepFailure(explainPushFailure(result.tail, app, clean));
      } finally {
        session.dispose();
      }
      if (!digest) {
        const image = await docker.imageInfo(record.image, { signal });
        const prefix = `${app.registry}/${app.repository}@`;
        digest = image?.repoDigests.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
      }
      if (!digest) throw new StepFailure('docker push finished without reporting which image it pushed.');
      record.digest = digest;
    });

    await step('verify', async (state) => {
      write('verify', 'sys', `Asking ${app.registry} what ${app.repository}:${app.tag} points to now`);
      let remote;
      try {
        remote = await headManifest({ registry: app.registry, username: app.username, password }, app.repository, app.tag);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        // The push itself succeeded and docker named the digest; only the independent read-back is missing.
        state.status = 'warn';
        state.note = error.message;
        record.verify = { status: 'unconfirmed', detail: error.message, checkedAt: iso() };
        write('verify', 'sys', `Could not read the tag back: ${error.message}. The push itself succeeded (${record.digest}).`);
        return;
      }
      record.verify = { status: 'verified', registryDigest: remote.digest ?? null, checkedAt: iso() };
      if (!remote.found) {
        record.verify.status = 'missing';
        throw new StepFailure(`The registry says ${app.repository}:${app.tag} does not exist, right after the push.`);
      }
      if (remote.digest !== record.digest) {
        record.verify.status = 'mismatch';
        throw new StepFailure(`The registry's ${app.tag} is ${shortDigest(remote.digest)}, but this deploy pushed ${shortDigest(record.digest)}. Something else pushed to this tag in between.`);
      }
      write('verify', 'sys', `Verified: ${app.registry} serves ${record.digest} as ${app.repository}:${app.tag}`);
    });

    record.status = 'succeeded';
    write('verify', 'sys', record.verify.status === 'verified'
      ? 'Done. Launchpad picks up the new image from here.'
      : 'Pushed. Launchpad picks up the new image from here.');
  } catch (error) {
    if (signal.aborted) {
      record.status = 'cancelled';
      record.error = started ? 'Cancelled before it finished.' : 'Cancelled while waiting in the queue.';
    } else {
      record.status = 'failed';
      record.error = clean(error instanceof StepFailure ? error.message : `Something went wrong inside Liftoff: ${error.message}`);
    }
    const at = record.steps.find((candidate) => ['failed', 'cancelled'].includes(candidate.status))?.key ?? 'preflight';
    write(at, 'fail', record.error);
  } finally {
    clearInterval(cancelWatch);
    clearInterval(heartbeat);
    password = null;
    for (const state of record.steps) if (state.status === 'pending') state.status = 'skipped';
    record.finishedAt = iso();
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    store.clearCancel(app.id, record.id);
    save();
    log.close();
  }
  return record;
}
