import crypto from 'node:crypto';

/**
 * A small read-only client for the registry's HTTP API, used to check what a
 * tag points to after a push. It signs in the way the registry asks to: Harbor
 * (registry.xo.builders) hands out a short-lived token from its token service,
 * simpler registries accept the username and password directly.
 */

const MANIFEST_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

export class RegistryError extends Error {
  /** kind: 'auth' wrong login, 'denied' no permission, 'network' unreachable, 'http' anything else */
  constructor(message, kind, status = null) {
    super(message);
    this.name = 'RegistryError';
    this.kind = kind;
    this.status = status;
  }
}

function isLoopback(registry) {
  const host = registry.replace(/:\d+$/, '');
  return host === 'localhost' || host === '[::1]' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Docker talks plain HTTP to a registry on this machine and HTTPS to everything else; so do we. */
export function registryBase(registry) {
  return `${isLoopback(registry) ? 'http' : 'https'}://${registry}`;
}

function parseChallenge(header) {
  const match = /^\s*(\w+)\s*(.*)$/s.exec(header ?? '');
  if (!match) return null;
  const params = {};
  for (const [, key, value] of match[2].matchAll(/(\w+)="([^"]*)"/g)) params[key] = value;
  return { scheme: match[1].toLowerCase(), params };
}

async function send(url, init) {
  try {
    return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), ...init });
  } catch (error) {
    const host = new URL(url).host;
    const code = error.cause?.code ?? error.name;
    const reason = {
      ENOTFOUND: 'its name could not be found',
      EAI_AGAIN: 'its name could not be looked up (no network?)',
      ECONNREFUSED: 'it refused the connection',
      ECONNRESET: 'the connection was dropped',
      TimeoutError: 'it did not answer in time',
    }[code] ?? (error.cause?.message || error.message);
    throw new RegistryError(`Could not reach ${host}: ${reason}`, 'network');
  }
}

async function fetchToken(target, challenge, scope, basic) {
  let realm;
  try {
    realm = new URL(challenge.params.realm);
  } catch {
    throw new RegistryError('The registry pointed to a sign-in service with no usable address', 'http');
  }
  // The password goes to this address, so it has to be as trustworthy as the registry itself.
  if (realm.protocol !== 'https:' && !isLoopback(target.registry)) {
    throw new RegistryError('The registry pointed to a sign-in service without HTTPS; not sending the password there', 'http');
  }
  if (challenge.params.service) realm.searchParams.set('service', challenge.params.service);
  realm.searchParams.set('scope', challenge.params.scope || scope);
  const response = await send(realm, { headers: { Authorization: basic } });
  if (response.status === 401) throw new RegistryError('The registry rejected the username or password', 'auth', 401);
  if (!response.ok) throw new RegistryError(`The registry's sign-in service answered ${response.status}`, 'http', response.status);
  const body = await response.json().catch(() => ({}));
  const token = body.token || body.access_token;
  if (!token) throw new RegistryError("The registry's sign-in service returned no token", 'http');
  return token;
}

async function request(target, { method = 'GET', path, accept, scope }) {
  const url = registryBase(target.registry) + path;
  const headers = accept ? { Accept: accept } : {};
  let response = await send(url, { method, headers });
  if (response.status !== 401) return response;

  const challenge = parseChallenge(response.headers.get('www-authenticate'));
  await response.body?.cancel();
  const basic = `Basic ${Buffer.from(`${target.username}:${target.password}`, 'utf8').toString('base64')}`;
  if (challenge?.scheme === 'bearer') {
    const token = await fetchToken(target, challenge, scope, basic);
    response = await send(url, { method, headers: { ...headers, Authorization: `Bearer ${token}` } });
  } else if (challenge?.scheme === 'basic') {
    response = await send(url, { method, headers: { ...headers, Authorization: basic } });
  } else {
    throw new RegistryError('The registry asked for a kind of sign-in Liftoff does not know', 'http', 401);
  }

  if (response.status === 401 || response.status === 403) {
    const again = response.headers.get('www-authenticate') ?? '';
    await response.body?.cancel();
    // A valid login that lacks the right gets a token with no access, then a 401 naming the missing scope.
    if (response.status === 403 || /insufficient_scope/.test(again) || challenge.scheme === 'bearer') {
      throw new RegistryError('This account is not allowed to read the repository', 'denied', response.status);
    }
    throw new RegistryError('The registry rejected the username or password', 'auth', 401);
  }
  return response;
}

/**
 * Which image does a tag point to right now?
 * Returns { found: false } or { found: true, digest, mediaType }.
 */
export async function headManifest(target, repository, reference) {
  const options = { path: `/v2/${repository}/manifests/${reference}`, accept: MANIFEST_TYPES, scope: `repository:${repository}:pull` };
  let response = await request(target, { ...options, method: 'HEAD' });
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new RegistryError(`The registry answered ${response.status} for ${repository}:${reference}`, 'http', response.status);
  let digest = response.headers.get('docker-content-digest');
  if (!digest) {
    // Some registries leave the digest off HEAD answers; it is the SHA-256 of the manifest itself.
    response = await request(target, { ...options, method: 'GET' });
    if (!response.ok) throw new RegistryError(`The registry answered ${response.status} for ${repository}:${reference}`, 'http', response.status);
    const body = Buffer.from(await response.arrayBuffer());
    digest = response.headers.get('docker-content-digest') || `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
  }
  return { found: true, digest, mediaType: response.headers.get('content-type') };
}

/** Tags in a repository (first page; a repository that does not exist yet has none). */
export async function listTags(target, repository) {
  const response = await request(target, { path: `/v2/${repository}/tags/list?n=100`, scope: `repository:${repository}:pull` });
  if (response.status === 404) return [];
  if (!response.ok) throw new RegistryError(`The registry answered ${response.status} listing tags of ${repository}`, 'http', response.status);
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body.tags) ? body.tags : [];
}
