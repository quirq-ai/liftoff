// Shared by the server, the CLI and the browser (served as /lib/commands.js): no Node imports here.

/** Split text the way a shell would: spaces separate, quotes group. */
export function splitArgs(text) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Unclosed quote');
  if (started || current) args.push(current);
  return args;
}

/** "registry.host/some/repo:tag" -> its three parts. The registry host is required. */
export function parseImageRef(ref) {
  const text = String(ref ?? '').trim();
  if (!text) throw new Error('Image is empty');
  if (text.includes('@')) throw new Error('Use a tag (name:tag), not a digest');
  const slash = text.indexOf('/');
  const host = slash === -1 ? '' : text.slice(0, slash);
  if (!host || !(host.includes('.') || host.includes(':') || host === 'localhost')) {
    throw new Error('Image must start with the registry host, for example registry.xo.builders/my-app/app:latest');
  }
  const rest = text.slice(slash + 1);
  const lastSegment = rest.slice(rest.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon === -1) return { registry: host.toLowerCase(), repository: rest, tag: 'latest' };
  return {
    registry: host.toLowerCase(),
    repository: rest.slice(0, rest.length - (lastSegment.length - colon)),
    tag: lastSegment.slice(colon + 1),
  };
}

export function imageRef(app) {
  return `${app.registry}/${app.repository}:${app.tag || 'latest'}`;
}

/**
 * Is this source a repository address rather than a folder? If so, take it apart:
 *   https://github.com/owner/repo                 -> clone address, folder name "repo"
 *   https://github.com/owner/repo/tree/some-branch, or ...repo#some-branch -> that branch
 *   git@github.com:owner/repo.git                 -> the same over SSH
 * Returns null for anything that is a plain folder.
 */
export function parseRepo(source) {
  let text = String(source ?? '').trim();
  if (!/^(https?|ssh|git|file):\/\/\S+$|^git@[^\s:]+:\S+$/i.test(text)) return null;
  let branch = null;
  const hash = text.indexOf('#');
  if (hash !== -1) {
    branch = text.slice(hash + 1) || null;
    text = text.slice(0, hash);
  }
  const tree = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/tree\/(.+?)\/?$/i.exec(text);
  if (tree) {
    text = tree[1];
    branch ??= tree[2];
  }
  text = text.replace(/\/+$/, '');
  const name = text.split(/[/:]/).pop().replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  if (!name) return null;
  if (branch && !/^[A-Za-z0-9._\/-]+$/.test(branch)) return null;
  return { url: text, branch, name };
}

/** Two addresses of the same repository compare equal: https or SSH, with or without ".git". */
export function repoKey(address) {
  return String(address ?? '').trim().toLowerCase()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/**
 * Where a deployed app answers. Launchpad serves each app at its own id:
 * registry.xo.builders/my-app-xo-abc123/app -> https://my-app-xo-abc123.apps.hello-xo.nl
 * A live address set on the app wins. Other registries have no known address.
 */
export function liveUrlFor({ registry, repository, liveUrl }) {
  if (liveUrl) return liveUrl;
  const slug = String(repository ?? '').split('/')[0];
  return registry === 'registry.xo.builders' && slug ? `https://${slug}.apps.hello-xo.nl` : null;
}

/** "test-floating-containers-xo-n6d5yb4/app" -> "Test Floating Containers" */
export function suggestName(repository) {
  const slug = String(repository ?? '').split('/')[0].replace(/-xo-[a-z0-9]{4,}$/i, '');
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function takeFlags(args, valueFlags) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!valueFlags.includes(name)) continue;
    const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
    if (value !== undefined) flags[name] = value;
  }
  return { flags, positional };
}

/**
 * Read the commands Launchpad shows for a docker app:
 *
 *   docker login registry.xo.builders -u xo-my-app+push
 *   docker build --platform linux/amd64 -t registry.xo.builders/my-app/app:latest .
 *   docker push registry.xo.builders/my-app/app:latest
 *
 * Bullets, prompts and code fences copied along with them are ignored. A
 * password given with -p is ignored too: it belongs in the password field.
 */
export function parseLaunchpadCommands(text) {
  const found = {};
  const recognized = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const start = raw.search(/\bdocker\s+(login|build|buildx\s+build|push)\b/);
    if (start === -1) continue;
    let args;
    try {
      args = splitArgs(raw.slice(start).replace(/`+\s*$/, ''));
    } catch {
      continue;
    }
    args.shift();
    let verb = args.shift();
    if (verb === 'buildx') verb = args.shift();

    if (verb === 'login') {
      const { flags, positional } = takeFlags(args, ['-u', '--username', '-p', '--password']);
      if (positional[0]) found.registry = positional[0].toLowerCase();
      const username = flags['-u'] ?? flags['--username'];
      if (username) found.username = username;
      recognized.push('login');
    } else if (verb === 'build') {
      const { flags } = takeFlags(args, ['-t', '--tag', '--platform', '-f', '--file']);
      const image = flags['-t'] ?? flags['--tag'];
      if (image) found.image = image;
      if (flags['--platform']) found.platform = flags['--platform'];
      const dockerfile = flags['-f'] ?? flags['--file'];
      if (dockerfile) found.dockerfile = dockerfile;
      recognized.push('build');
    } else if (verb === 'push') {
      const { positional } = takeFlags(args, []);
      if (positional[0] && !found.image) found.image = positional[0];
      recognized.push('push');
    }
  }

  const result = { recognized, ...found };
  if (found.image) {
    try {
      const parts = parseImageRef(found.image);
      result.repository = parts.repository;
      result.tag = parts.tag;
      if (found.registry && found.registry !== parts.registry) {
        result.warning = `The login is for ${found.registry} but the image goes to ${parts.registry}.`;
      }
      result.registry = parts.registry;
      result.name = suggestName(parts.repository);
    } catch (error) {
      result.warning = error.message;
    }
  }
  return result;
}
