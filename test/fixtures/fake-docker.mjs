#!/usr/bin/env node
// A stand-in for the docker CLI so the pipeline can be tested without Docker.
// It behaves like the real one where the pipeline depends on it: `login` reads
// the password from stdin and saves it into $DOCKER_CONFIG/config.json, and
// `push` only works when that file holds the right login.
//
// Driven by environment variables:
//   FAKE_DOCKER_CALLS      file that receives one JSON line per call
//   FAKE_DOCKER_USER/_PASSWORD   the only login the "registry" accepts
//   FAKE_DOCKER_DIGEST     digest that `push` reports
//   FAKE_DOCKER_DOWN, FAKE_DOCKER_BUILD_FAIL, FAKE_DOCKER_BUILD_MS, FAKE_DOCKER_ARCH, FAKE_DOCKER_PUSH_DENIED
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const env = process.env;
const note = (entry) => env.FAKE_DOCKER_CALLS && fs.appendFileSync(env.FAKE_DOCKER_CALLS, `${JSON.stringify(entry)}\n`);
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};
const configFile = () => path.join(env.DOCKER_CONFIG ?? '', 'config.json');

switch (args[0]) {
  case 'version':
    if (env.FAKE_DOCKER_DOWN) fail('error during connect: this error may indicate that the docker daemon is not running');
    console.log('24.0.2|24.0.2');
    break;

  case 'context':
    console.log('npipe:////./pipe/fake_engine');
    break;

  case 'login': {
    let password = '';
    for await (const chunk of process.stdin) password += chunk;
    const user = args[args.indexOf('-u') + 1];
    note({ cmd: 'login', registry: args[1], user, config: env.DOCKER_CONFIG ?? null, host: env.DOCKER_HOST ?? null, passwordOnCommandLine: args.includes(password) || args.includes('-p') || args.includes('--password') });
    if (user !== env.FAKE_DOCKER_USER || password !== env.FAKE_DOCKER_PASSWORD) {
      fail(`Error response from daemon: Get "https://${args[1]}/v2/": unauthorized: authentication required`);
    }
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    config.auths[args[1]] = { auth: Buffer.from(`${user}:${password}`).toString('base64') };
    fs.writeFileSync(configFile(), JSON.stringify(config));
    console.error(`WARNING! Your password will be stored unencrypted in ${configFile()}.`);
    console.error('Configure a credential helper to remove this warning. See');
    console.error('https://docs.docker.com/engine/reference/commandline/login/#credentials-store');
    console.error('');
    console.log('Login Succeeded');
    break;
  }

  case 'build':
    note({ cmd: 'build', args, cwd: process.cwd(), config: env.DOCKER_CONFIG ?? null });
    console.error('#1 [internal] load build definition from Dockerfile');
    console.error('#2 \x1b[32mcoloured tool output\x1b[0m');
    if (env.FAKE_DOCKER_BUILD_MS) await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_DOCKER_BUILD_MS)));
    if (env.FAKE_DOCKER_BUILD_FAIL) {
      console.error('ERROR: failed to solve: process "/bin/sh -c exit 3" did not complete successfully: exit code: 3');
      process.exit(1);
    }
    console.error(`#3 writing image sha256:${'a'.repeat(64)} done`);
    break;

  case 'image':
    console.log(JSON.stringify({
      Id: `sha256:${'a'.repeat(64)}`,
      Size: 12345,
      Os: 'linux',
      Architecture: env.FAKE_DOCKER_ARCH || 'amd64',
      Created: '2026-01-01T00:00:00Z',
      RepoDigests: [],
    }));
    break;

  case 'push': {
    const image = args[1];
    const registry = image.split('/')[0];
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')).auths?.[registry]?.auth ?? null;
    } catch { /* no config: not logged in */ }
    note({ cmd: 'push', image, loggedIn: Boolean(saved), config: env.DOCKER_CONFIG ?? null, host: env.DOCKER_HOST ?? null });
    console.log(`The push refers to repository [${image.replace(/:[^:/]+$/, '')}]`);
    const expected = Buffer.from(`${env.FAKE_DOCKER_USER}:${env.FAKE_DOCKER_PASSWORD}`).toString('base64');
    if (saved !== expected) fail('unauthorized: authentication required');
    if (env.FAKE_DOCKER_PUSH_DENIED) fail('denied: requested access to the resource is denied');
    console.log('0123456789ab: Pushed');
    console.log(`latest: digest: ${env.FAKE_DOCKER_DIGEST} size: 523`);
    break;
  }

  default:
    fail(`fake docker: unsupported command ${args.join(' ')}`, 125);
}
