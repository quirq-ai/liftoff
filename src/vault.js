import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

/**
 * Passwords at rest.
 *
 * On Windows each password is sealed with DPAPI for the signed-in Windows
 * account: the file on disk is useless to another user or on another machine,
 * and no master password is needed. Elsewhere the fallback is AES-256-GCM with
 * a key file next to the vault, which only keeps the password out of plain
 * sight (anyone who can read both files can read the password).
 *
 * The plain password exists only in memory, only while a command needs it, and
 * it travels to PowerShell and to docker over stdin, never on a command line.
 */

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$mode, $payload = ([Console]::In.ReadToEnd().Trim() -split ':', 2)
$entropy = [Text.Encoding]::UTF8.GetBytes('liftoff/vault/v1')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$bytes = [Convert]::FromBase64String($payload)
if ($mode -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function dpapi(mode, buffer) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start PowerShell for Windows data protection: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) return resolve(Buffer.from(out.trim(), 'base64'));
      // PowerShell's own error text is left out on purpose: nothing derived from the input goes into messages.
      reject(new Error(mode === 'protect'
        ? `Windows could not encrypt the password (PowerShell exit ${code})`
        : 'Windows could not decrypt the stored password. It was saved by another Windows account or on another computer; save it again.'));
    });
    child.stdin.end(`${mode}:${buffer.toString('base64')}\n`);
  });
}

function keyfileKey(home) {
  const file = path.join(home, 'vault.key');
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    return key;
  }
}

const backends = {
  dpapi: {
    label: 'Windows data protection (DPAPI), tied to your Windows account',
    seal: (_home, plain) => dpapi('protect', plain),
    open: (_home, sealed) => dpapi('unprotect', sealed),
  },
  keyfile: {
    label: 'AES-256 with a key file in the Liftoff folder (obscured, not OS-protected)',
    async seal(home, plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyfileKey(home), iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async open(home, sealed) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyfileKey(home), sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    },
  },
};

export function defaultBackend() {
  const forced = process.env.LIFTOFF_VAULT;
  if (forced) {
    if (!backends[forced]) throw new Error(`Unknown LIFTOFF_VAULT "${forced}" (use dpapi or keyfile)`);
    return forced;
  }
  return process.platform === 'win32' ? 'dpapi' : 'keyfile';
}

/** Pasted secrets often carry a stray newline or space; registry secrets never start or end with one. */
export function cleanSecret(value) {
  if (typeof value !== 'string') throw new Error('Password is required');
  const secret = value.trim();
  if (!secret) throw new Error('Password is required');
  if (secret.length > 4096) throw new Error('Password is too long');
  if (/[\r\n]/.test(secret)) throw new Error('Password cannot contain line breaks');
  return secret;
}

export class Vault {
  constructor(home, { backend = defaultBackend() } = {}) {
    this.home = home;
    this.file = path.join(home, 'vault.json');
    this.backend = backend;
    this.label = backends[backend].label;
  }

  #read() {
    return readJson(this.file, { version: 1, entries: {} });
  }

  has(id) {
    return Boolean(this.#read().entries[id]);
  }

  /** When the password was last saved, without decrypting anything. */
  info(id) {
    const entry = this.#read().entries[id];
    return entry ? { savedAt: entry.savedAt, backend: entry.backend } : null;
  }

  async set(id, value) {
    const secret = cleanSecret(value);
    const sealed = await backends[this.backend].seal(this.home, Buffer.from(secret, 'utf8'));
    const data = this.#read();
    data.entries[id] = { backend: this.backend, blob: sealed.toString('base64'), savedAt: new Date().toISOString() };
    writeJson(this.file, data);
  }

  async get(id) {
    const entry = this.#read().entries[id];
    if (!entry) return null;
    const backend = backends[entry.backend];
    if (!backend) throw new Error(`Stored password uses an unknown protection "${entry.backend}"`);
    const plain = await backend.open(this.home, Buffer.from(entry.blob, 'base64'));
    return plain.toString('utf8');
  }

  delete(id) {
    const data = this.#read();
    if (!data.entries[id]) return false;
    delete data.entries[id];
    writeJson(this.file, data);
    return true;
  }
}
