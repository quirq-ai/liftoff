import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from './util.js';

let command = [process.env.LIFTOFF_DOCKER || 'docker'];

/** Tests swap the real docker for a stand-in. */
export function setDockerCommand(parts) {
  command = [...parts];
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // docker build hands the work to a docker-buildx child; /T takes that down too.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Run docker and hand back its exit code. Output arrives line by line through
 * onLine(text, 'out' | 'err'). `input` is written to stdin and then closed,
 * which is how a password reaches `docker login --password-stdin` without ever
 * being typed or put on a command line.
 */
export function runDocker(args, options = {}) {
  return runProcess(command[0], [...command.slice(1), ...args], {
    ...options,
    label: `docker ${args[0]}`,
    missing: 'The docker command was not found. Install Docker Desktop, or add docker to PATH.',
  });
}

/** The same for any program (git, for one): line-by-line output, cancellable, optional time limit. */
export function runProcess(file, args, { env, cwd, input, onLine, signal, timeoutMs, label = file, missing } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    let child;
    try {
      child = spawn(file, args, { env: env ?? process.env, cwd, windowsHide: true });
    } catch (error) {
      return reject(error);
    }

    const tail = [];
    const pending = { out: '', err: '' };
    let stopped = false;
    let timedOut = false;

    const emit = (stream, line) => {
      tail.push(line);
      if (tail.length > 200) tail.shift();
      onLine?.(line, stream);
    };
    const feed = (stream) => (chunk) => {
      let text = pending[stream] + chunk;
      // A lone carriage return at the very end may be the first half of \r\n.
      const held = text.endsWith('\r') ? '\r' : '';
      if (held) text = text.slice(0, -1);
      const lines = text.split(/\r\n|\n|\r/);
      pending[stream] = lines.pop() + held;
      for (const line of lines) emit(stream, line);
    };

    const stop = () => {
      stopped = true;
      killTree(child);
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;

    child.stdout.setEncoding('utf8').on('data', feed('out'));
    child.stderr.setEncoding('utf8').on('data', feed('err'));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error.code === 'ENOENT' ? new Error(missing ?? `The ${file} command was not found on this computer.`) : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      for (const stream of ['out', 'err']) {
        const rest = pending[stream].replace(/\r$/, '');
        if (rest) emit(stream, rest);
      }
      if (stopped) return reject(new CancelledError());
      if (timedOut) return reject(new Error(`${label} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      resolve({ code: code ?? 1, tail });
    });
    child.stdin.end(input ?? '');
  });
}

async function capture(args, options = {}) {
  const lines = [];
  const errors = [];
  const { code } = await runDocker(args, {
    timeoutMs: 20_000,
    ...options,
    onLine: (line, stream) => (stream === 'out' ? lines : errors).push(line),
  });
  return { code, stdout: lines.join('\n').trim(), stderr: errors.join('\n').trim() };
}

/** Is the Docker engine up? Answers with versions, or the reason it is not. */
export async function inspectEngine() {
  try {
    const { code, stdout, stderr } = await capture(['version', '--format', '{{.Client.Version}}|{{.Server.Version}}']);
    const [client, server] = stdout.split('|');
    if (code === 0 && server) return { ok: true, client, server };
    const reason = stderr.split('\n').filter(Boolean).pop() || 'the engine did not answer';
    const down = /daemon is not running|cannot find the file|cannot connect to the docker daemon|connection refused|no such file/i.test(stderr);
    return { ok: false, client: client || null, error: down ? 'the Docker engine is not running' : reason.replace(/^error during connect:\s*/i, '') };
  } catch (error) {
    return { ok: false, client: null, error: error.message };
  }
}

/**
 * The address of the engine your docker CLI talks to right now. Commands that
 * run with a private config would otherwise fall back to the default engine.
 */
export async function resolveEndpoint() {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  try {
    const { code, stdout } = await capture(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    return code === 0 && stdout ? stdout : null;
  } catch {
    return null;
  }
}

const SESSION_PREFIX = 'liftoff-docker-';

/**
 * A private, throwaway Docker config folder for one login or one push.
 *
 * Docker keeps a single saved login per registry host, and every Launchpad app
 * has its own push account on the same host. Signing in through your normal
 * Docker config would replace whichever account is saved there. A private
 * config keeps this run's login separate and leaves yours alone.
 *
 * The "auths" entry is there from the start so the docker CLI uses this folder
 * as its credential store instead of the Windows Credential Manager, which is
 * shared by every config. Pass `credentials` to write the login directly (as
 * `docker login` would); leave it out when `docker login` will fill it in.
 * Call dispose() as soon as the command is done: it deletes the folder.
 */
export function createSession(registry, endpoint, credentials) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${SESSION_PREFIX}${process.pid}-`));
  const entry = credentials
    ? { auth: Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64') }
    : {};
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths: { [registry]: entry } }), { mode: 0o600 });
  const env = { ...process.env, DOCKER_CONFIG: dir };
  if (endpoint) env.DOCKER_HOST = endpoint;
  return {
    dir,
    env,
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** Remove private configs left behind by a Liftoff process that was killed mid-deploy. */
export function sweepSessions() {
  let removed = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    const match = new RegExp(`^${SESSION_PREFIX}(\\d+)-`).exec(name);
    if (!match || isPidAlive(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      removed++;
    } catch { /* another process may be cleaning up too */ }
  }
  return removed;
}

/** What docker knows about a local image, or null when there is no such image. */
export async function imageInfo(image, options) {
  const { code, stdout } = await capture(['image', 'inspect', image, '--format', '{{json .}}'], options);
  if (code !== 0 || !stdout) return null;
  const data = JSON.parse(stdout);
  return {
    id: data.Id,
    size: data.Size,
    os: data.Os,
    architecture: data.Architecture,
    created: data.Created,
    repoDigests: data.RepoDigests ?? [],
  };
}
