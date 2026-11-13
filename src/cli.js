import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseImageRef, parseLaunchpadCommands, parseRepo, suggestName } from './commands.js';
import { startDeployment, testLogin } from './pipeline.js';
import { QueueFile, QueueWatcher } from './queuefile.js';
import { Store } from './store.js';
import { formatBytes, formatDuration, resolveHome, shortDigest } from './util.js';
import { Vault } from './vault.js';

const HELP = `Liftoff: deploy XO Launchpad docker apps without typing the registry password.

  liftoff serve [--port 5438] [--open]     open the app in your browser
  liftoff list                             apps and their last deploy
  liftoff add --dir <folder> --commands <file>
                                           add an app from the three commands Launchpad shows
  liftoff add --dir <folder> --image <registry/repo:tag> --user <push user> [--name <name>]
  liftoff set-password <app> [--stdin]     store the push password, encrypted (typed hidden, or piped in)
  liftoff grab                             catch passwords from the clipboard: copy each new app's secret and
                                           it is stored for the app whose registry accepts it
  liftoff check <app>                      try the stored password against the registry
  liftoff deploy <app> [--no-cache]        login, build, push, verify (waits its turn if another deploy is running)
  liftoff deploy <app> --src <folder>      switch the app to another source folder, then deploy from it
  liftoff queue [-n 20]                    the queue file's entries, newest first, with their status
  liftoff queue-file [<path>]              show where the queue file is, or move it
  liftoff watch                            watch the queue file and deploy new entries, without the page
  liftoff history <app> [-n 10]            past deploys of one app
  liftoff logs <app> [number]              output of a deploy (the latest when no number is given)
  liftoff remove <app> --yes               forget an app, its password and its history

<app> is the app's number, its id, its name, or the start of its id.
The queue file is a JSON list; add { "app": 1, "src": "my-folder" } to its end and the deploy starts.
Add --home <folder> to any command to use another data folder (default: ~/.liftoff).`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const dim = paint(2);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const cyan = paint(36);

class UsageError extends Error {}

function statusWord(record) {
  if (!record) return dim('never deployed');
  if (record.status === 'succeeded') return record.verify?.status === 'verified' ? green('verified') : yellow('pushed, not confirmed');
  if (record.status === 'running') return cyan('running');
  if (record.status === 'queued') return cyan('waiting');
  if (record.status === 'cancelled') return yellow('cancelled');
  return red('failed');
}

function when(isoTime) {
  if (!isoTime) return '';
  return new Date(isoTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Read a password from the keyboard without showing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return reject(new UsageError('There is no terminal to type into. Pipe the password in and add --stdin.'));
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new UsageError('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    }
    stdin.on('data', onData);
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function printLogEntry(entry, state) {
  if (entry.step !== state.step) {
    state.step = entry.step;
    console.log(`\n${bold(`==> ${entry.step}`)}`);
  }
  if (entry.s === 'cmd') console.log(`  ${cyan('$')} ${entry.m}`);
  else if (entry.s === 'sys') console.log(`  ${dim(entry.m)}`);
  else if (entry.s === 'fail') console.log(`  ${red(entry.m)}`);
  else console.log(`  ${entry.m}`);
}

function summary(record) {
  const took = formatDuration(record.durationMs);
  if (record.status === 'succeeded') {
    const confirmed = record.verify?.status === 'verified' ? 'verified in the registry' : `pushed (not confirmed: ${record.verify?.detail ?? 'unknown'})`;
    return `${green('Deployed')} ${record.image} in ${took}\n  ${record.digest}\n  ${confirmed}`;
  }
  if (record.status === 'cancelled') return yellow(`Cancelled after ${took}.`);
  return `${red('Deploy failed')} after ${took}: ${record.error}`;
}

const commands = {
  async serve({ values, home }) {
    const { createServer } = await import('./server.js');
    const port = Number(values.port ?? process.env.LIFTOFF_PORT ?? 5438);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port should be a number');
    const instance = createServer({ home, port });
    let bound;
    try {
      bound = await instance.listen();
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw new UsageError(`Port ${port} is taken. Liftoff may already be running at http://localhost:${port}; otherwise pick another with --port.`);
      throw error;
    }
    const url = `http://localhost:${bound}`;
    console.log(`Liftoff is running at ${bold(url)}`);
    console.log(dim(`Data folder: ${home}`));
    console.log(dim(`Passwords: ${instance.vault.label}`));
    console.log(dim(`Queue file: ${instance.queue.file}${instance.watcher.owner ? ' (watching for new entries)' : ' (another Liftoff is watching it)'}`));
    console.log(dim('Press Ctrl+C to stop.'));
    if (values.open) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    }
    const stop = () => instance.close().then(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  },

  async list({ store, vault }) {
    const apps = store.listApps();
    if (!apps.length) {
      console.log('No apps yet. Add one with "liftoff add", or run "liftoff serve" and add it in the browser.');
      return 0;
    }
    for (const app of apps) {
      const last = store.latestDeployment(app.id);
      console.log(`${bold(`${app.number}  ${app.name}`)}  ${dim(app.id)}`);
      console.log(`  ${app.registry}/${app.repository}:${app.tag}`);
      console.log(`  password ${vault.has(app.id) ? 'stored' : yellow('missing')}  |  ${statusWord(last)}${last ? `  #${last.number}  ${when(last.startedAt)}` : ''}`);
    }
    return 0;
  },

  async add({ values, store }) {
    if (!values.dir) throw new UsageError('Say which folder holds the Dockerfile: --dir <folder>');
    let fields = {};
    if (values.commands) {
      const text = values.commands === '-' ? await readAll(process.stdin) : fs.readFileSync(values.commands, 'utf8');
      const parsed = parseLaunchpadCommands(text);
      if (!parsed.repository || !parsed.username) throw new UsageError('Could not find the docker login and docker build/push commands in that text.');
      fields = { name: parsed.name, registry: parsed.registry, repository: parsed.repository, tag: parsed.tag, username: parsed.username, platform: parsed.platform, dockerfile: parsed.dockerfile };
    } else if (values.image && values.user) {
      const image = parseImageRef(values.image);
      fields = { ...image, username: values.user, name: suggestName(image.repository) };
    } else {
      throw new UsageError('Give either --commands <file>, or both --image and --user.');
    }
    const app = store.createApp({
      ...fields,
      name: values.name ?? fields.name,
      platform: values.platform ?? fields.platform,
      dockerfile: values.dockerfile ?? fields.dockerfile,
      liveUrl: values['live-url'],
      contextDir: path.resolve(values.dir),
    });
    console.log(`Added ${bold(app.name)} (${app.id}) -> ${app.registry}/${app.repository}:${app.tag}`);
    console.log(`Next: liftoff set-password ${app.id}`);
    return 0;
  },

  async 'set-password'({ values, positionals, store, vault }) {
    const app = store.findApp(positionals[0]);
    const password = values.stdin ? await readAll(process.stdin) : await promptHidden(`Push password for ${app.username}: `);
    await vault.set(app.id, password);
    console.log(`Stored the password for ${app.name}, encrypted (${vault.label}).`);
    console.log(`Try it: liftoff check ${app.id}`);
    return 0;
  },

  /**
   * Catch passwords from the clipboard. While this runs, every secret you copy
   * (for example with the copy button Launchpad shows beside a new app's
   * registry secret) is tried against each app that has no password yet, and
   * stored for the one whose registry accepts it. Nothing is typed or pasted,
   * the order does not matter, and the secret is never printed.
   */
  async grab({ store, vault }) {
    if (process.platform !== 'win32') throw new UsageError('Catching passwords from the clipboard works on Windows only. Use: liftoff set-password <app>');
    const waiting = () => store.listApps().filter((app) => !vault.has(app.id)).sort((a, b) => a.number - b.number);
    if (!waiting().length) {
      console.log('Every app already has a password.');
      return 0;
    }
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const clipboard = () => new Promise((resolve) => {
      execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout.trim()));
    });
    const clear = () => new Promise((resolve) => {
      execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', "Set-Clipboard -Value ' '"], { windowsHide: true }, () => resolve());
    });

    console.log(`Waiting for passwords for: ${waiting().map((app) => `${app.number} ${app.name}`).join(', ')}`);
    console.log('Copy each secret (the copy button beside it is enough). Press Ctrl+C to stop.\n');
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    let last = await clipboard(); // whatever was there before does not count
    while (!stopped && waiting().length) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const text = await clipboard();
      if (!text || text === last) continue;
      last = text;
      if (/\s/.test(text) || text.length < 12 || text.length > 200) continue; // not a secret: a command, a path, a sentence
      let taken = null;
      for (const app of waiting()) {
        await vault.set(app.id, text);
        const result = await testLogin({ app, vault });
        if (result.ok) {
          taken = app;
          break;
        }
        vault.delete(app.id);
        if (/Docker is not available/.test(result.message)) {
          console.log(red(result.message));
          break;
        }
      }
      if (taken) {
        await clear();
        last = await clipboard();
        const left = waiting().length;
        console.log(`${green('stored')}  ${taken.number} ${taken.name}: its registry accepted the password. ${left ? `${left} to go.` : 'All done.'}`);
      } else {
        console.log(dim('That copy did not match any app that is waiting for a password.'));
      }
    }
    return 0;
  },

  async check({ positionals, store, vault }) {
    const result = await testLogin({ app: store.findApp(positionals[0]), vault });
    console.log(result.ok ? green(result.message) : red(result.message));
    return result.ok ? 0 : 1;
  },

  async deploy({ values, positionals, store, vault, queue }) {
    const app = store.findApp(positionals[0]);
    const state = { step: null };
    const { record, done, cancel } = startDeployment({
      store,
      vault,
      app,
      trigger: 'cli',
      // --src takes a folder, or a repository address that is cloned beside the queue file.
      options: { noCache: values['no-cache'], cloneInto: queue.folder, src: !values.src ? undefined : parseRepo(values.src) ? values.src : path.resolve(values.src) },
      onEvent: (event) => event.type === 'log' && !values.quiet && printLogEntry(event.entry, state),
    });
    // Ctrl+C cancels the deploy cleanly instead of leaving it half recorded.
    process.on('SIGINT', cancel);
    queue.record(record, store.getApp(app.id));
    const final = await done;
    process.off('SIGINT', cancel);
    queue.sync(); // write the result onto the entry, in case no Liftoff is watching the file
    console.log(`\n${summary(final)}`);
    return final.status === 'succeeded' ? 0 : final.status === 'cancelled' ? 130 : 1;
  },

  async queue({ values, queue }) {
    queue.sync();
    const limit = Number(values.number ?? 20);
    const view = queue.view();
    console.log(dim(`Queue file: ${view.file}`));
    if (view.error) {
      console.log(red(view.error));
      return 1;
    }
    if (!view.entries.length) {
      console.log('The queue is empty. Add { "app": 1, "src": "my-folder" } to the file to deploy.');
      return 0;
    }
    const tint = { verified: green, pushed: yellow, cancelled: yellow, failed: red, rejected: red, waiting: cyan, running: cyan, new: cyan };
    for (const entry of view.entries.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 20)) {
      const status = (tint[entry.status] ?? dim)(entry.status === 'new' ? 'not started' : entry.status);
      console.log(`${status.padEnd(useColor ? 20 : 11)} ${String(entry.asked ?? '').padEnd(19)} ${String(entry.took ?? '').padEnd(7)} app ${String(entry.app).padEnd(3)} ${entry.appName ?? ''}  ${dim(entry.src ?? '')}`);
      if (entry.error) console.log(`            ${dim(entry.error)}`);
    }
    return 0;
  },

  async 'queue-file'({ positionals, store, queue }) {
    if (positionals[0]) {
      store.setQueueFile(path.resolve(positionals[0]));
      queue.sync();
      console.log(`The queue file is now ${queue.file}`);
    } else {
      console.log(queue.file);
    }
    console.log(dim(`Relative "src" folders in entries start from ${queue.folder}`));
    return 0;
  },

  async watch({ queue }) {
    const watcher = new QueueWatcher(queue).start();
    if (!watcher.owner) {
      watcher.stop();
      throw new UsageError('Another Liftoff on this computer is already watching the queue file.');
    }
    console.log(`Watching ${bold(queue.file)}`);
    console.log(dim('Add { "app": 1, "src": "my-folder" } to the end of the file to deploy. Press Ctrl+C to stop.'));
    const stop = () => {
      watcher.stop();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  },

  async history({ values, positionals, store }) {
    const app = store.findApp(positionals[0]);
    const limit = Number(values.number ?? 10);
    const records = store.listDeployments(app.id, { limit: Number.isInteger(limit) && limit > 0 ? limit : 10 });
    if (!records.length) {
      console.log(`${app.name} has not been deployed from here yet.`);
      return 0;
    }
    for (const record of records) {
      const source = record.git ? `  ${record.git.commit}${record.git.dirty ? '+' : ''}` : '';
      console.log(`#${String(record.number).padEnd(4)} ${statusWord(record).padEnd(useColor ? 31 : 22)} ${when(record.startedAt).padEnd(22)} ${formatDuration(record.durationMs).padEnd(8)} ${shortDigest(record.digest) || '-'.padEnd(12)}${source}${record.imageSize ? `  ${formatBytes(record.imageSize)}` : ''}`);
      if (record.status === 'failed') console.log(`      ${dim(record.error)}`);
    }
    return 0;
  },

  async logs({ positionals, store }) {
    const app = store.findApp(positionals[0]);
    const records = store.listDeployments(app.id, { limit: 1000 });
    const record = positionals[1] ? records.find((candidate) => String(candidate.number) === String(positionals[1]).replace(/^#/, '')) : records[0];
    if (!record) throw new UsageError(positionals[1] ? `${app.name} has no deploy #${positionals[1]}.` : `${app.name} has not been deployed from here yet.`);
    const state = { step: null };
    for (const entry of store.readLog(app.id, record.id)) printLogEntry(entry, state);
    console.log(`\n${record.status === 'running' ? cyan('Still running.') : summary(record)}`);
    return 0;
  },

  async remove({ values, positionals, store, vault }) {
    const app = store.findApp(positionals[0]);
    if (!values.yes) throw new UsageError(`This forgets ${app.name}, its stored password and its deploy history on this computer. Nothing changes on Launchpad. Add --yes to go ahead.`);
    if (store.activeDeployments().some((record) => record.appId === app.id)) throw new UsageError('A deploy of this app is running or waiting. Cancel it first.');
    vault.delete(app.id);
    store.deleteApp(app.id);
    console.log(`Removed ${app.name}.`);
    return 0;
  },
};

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        port: { type: 'string' },
        open: { type: 'boolean' },
        dir: { type: 'string' },
        src: { type: 'string' },
        commands: { type: 'string' },
        image: { type: 'string' },
        user: { type: 'string' },
        name: { type: 'string' },
        platform: { type: 'string' },
        dockerfile: { type: 'string' },
        'live-url': { type: 'string' },
        stdin: { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        number: { type: 'string', short: 'n' },
        yes: { type: 'boolean', short: 'y' },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [name, ...rest] = positionals;
  if (values.version) {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  if (values.help || !name) {
    console.log(HELP);
    return name || values.help ? 0 : 2;
  }
  const command = commands[name];
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${HELP}`);
    return 2;
  }
  try {
    const home = resolveHome(values.home);
    const needsApp = ['set-password', 'check', 'deploy', 'history', 'logs', 'remove'].includes(name);
    if (needsApp && !rest[0]) throw new UsageError(`Which app? Usage: liftoff ${name} <app>`);
    const context = { values, positionals: rest, home };
    if (name !== 'serve') {
      context.store = new Store(home);
      context.vault = new Vault(home);
      context.queue = new QueueFile({ store: context.store, vault: context.vault });
    }
    return await command(context);
  } catch (error) {
    if (error.fields) {
      for (const message of Object.values(error.fields)) console.error(red(message));
    } else {
      console.error(red(error.message));
    }
    return error instanceof UsageError ? 2 : 1;
  }
}
