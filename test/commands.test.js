import assert from 'node:assert/strict';
import test from 'node:test';
import { imageRef, liveUrlFor, parseImageRef, parseLaunchpadCommands, parseRepo, repoKey, splitArgs, suggestName } from '../src/commands.js';

test('tells a repository address from a folder, and finds its name and branch', () => {
  assert.deepEqual(parseRepo('https://github.com/owner/my-project'), { url: 'https://github.com/owner/my-project', branch: null, name: 'my-project' });
  assert.deepEqual(parseRepo(' https://github.com/owner/my-project.git/ '), { url: 'https://github.com/owner/my-project.git', branch: null, name: 'my-project' });
  assert.deepEqual(parseRepo('https://github.com/owner/my-project/tree/feature/x'), { url: 'https://github.com/owner/my-project', branch: 'feature/x', name: 'my-project' });
  assert.deepEqual(parseRepo('https://github.com/owner/my-project#staging'), { url: 'https://github.com/owner/my-project', branch: 'staging', name: 'my-project' });
  assert.deepEqual(parseRepo('git@github.com:owner/my-project.git'), { url: 'git@github.com:owner/my-project.git', branch: null, name: 'my-project' });
  for (const folder of ['my-project', 'D:\\projects\\my-project', '/home/me/project', '../web', 'github.com/owner/repo', '', 'https://github.com/o/r#bad branch;rm']) {
    assert.equal(parseRepo(folder), null, folder);
  }
});

test('the same repository is recognised whichever way its address is written', () => {
  const key = repoKey('https://github.com/Owner/My-Project');
  for (const other of ['https://github.com/owner/my-project.git', 'git@github.com:owner/my-project.git', 'https://token@github.com/owner/my-project/', 'ssh://git@github.com/owner/my-project.git']) {
    assert.equal(repoKey(other), key, other);
  }
  assert.notEqual(repoKey('https://github.com/owner/other'), key);
});

test('an app\'s address comes from its Launchpad id, unless it has its own', () => {
  assert.equal(liveUrlFor({ registry: 'registry.xo.builders', repository: 'tools-custom-3000-2-xo-lx670um/app' }), 'https://tools-custom-3000-2-xo-lx670um.apps.hello-xo.nl');
  assert.equal(liveUrlFor({ registry: 'registry.xo.builders', repository: 'x/app', liveUrl: 'https://mine.example/' }), 'https://mine.example/');
  assert.equal(liveUrlFor({ registry: 'localhost:5000', repository: 'x/app' }), null);
});

test('reads the three commands the way Launchpad lists them', () => {
  const parsed = parseLaunchpadCommands(`
* docker login registry.xo.builders -u xo-test-floating-containers-xo-n6d5yb4+push
* docker build --platform linux/amd64 -t registry.xo.builders/test-floating-containers-xo-n6d5yb4/app:latest .
* docker push registry.xo.builders/test-floating-containers-xo-n6d5yb4/app:latest
`);
  assert.deepEqual(parsed.recognized, ['login', 'build', 'push']);
  assert.equal(parsed.registry, 'registry.xo.builders');
  assert.equal(parsed.username, 'xo-test-floating-containers-xo-n6d5yb4+push');
  assert.equal(parsed.repository, 'test-floating-containers-xo-n6d5yb4/app');
  assert.equal(parsed.tag, 'latest');
  assert.equal(parsed.platform, 'linux/amd64');
  assert.equal(parsed.name, 'Test Floating Containers');
  assert.equal(parsed.warning, undefined);
});

test('copes with prompts, numbering, code fences and other flag spellings', () => {
  const parsed = parseLaunchpadCommands([
    '1. `docker login --username=robot+push registry.example.com:5000`',
    '$ docker buildx build -f deploy/prod.Dockerfile --tag registry.example.com:5000/team/web:v2 --platform=linux/arm64 .',
    'PS C:\\app> docker push registry.example.com:5000/team/web:v2',
  ].join('\r\n'));
  assert.equal(parsed.registry, 'registry.example.com:5000');
  assert.equal(parsed.username, 'robot+push');
  assert.equal(parsed.repository, 'team/web');
  assert.equal(parsed.tag, 'v2');
  assert.equal(parsed.platform, 'linux/arm64');
  assert.equal(parsed.dockerfile, 'deploy/prod.Dockerfile');
});

test('never picks a password up from a pasted command', () => {
  const parsed = parseLaunchpadCommands('docker login registry.xo.builders -u robot+push -p hunter2-secret');
  assert.equal(parsed.username, 'robot+push');
  assert.equal(parsed.registry, 'registry.xo.builders');
  assert.ok(!JSON.stringify(parsed).includes('hunter2'));
});

test('says so when the login and the image point at different registries', () => {
  const parsed = parseLaunchpadCommands('docker login one.example.com -u a\ndocker push two.example.com/app/web:latest');
  assert.match(parsed.warning, /one\.example\.com.*two\.example\.com/);
});

test('finds nothing in unrelated text', () => {
  assert.deepEqual(parseLaunchpadCommands('npm run build && echo docker is great').recognized, []);
  assert.deepEqual(parseLaunchpadCommands('').recognized, []);
});

test('a push alone still names the image', () => {
  const parsed = parseLaunchpadCommands('docker push registry.xo.builders/app-xo-1a2b3c/app:latest');
  assert.equal(parsed.repository, 'app-xo-1a2b3c/app');
  assert.equal(parsed.username, undefined);
});

test('splits an image name into registry, repository and tag', () => {
  assert.deepEqual(parseImageRef('registry.xo.builders/my-app/app:latest'), { registry: 'registry.xo.builders', repository: 'my-app/app', tag: 'latest' });
  assert.deepEqual(parseImageRef('localhost:5055/a/b/c'), { registry: 'localhost:5055', repository: 'a/b/c', tag: 'latest' });
  assert.deepEqual(parseImageRef(' Registry.Example.com/x:1.2.3 '), { registry: 'registry.example.com', repository: 'x', tag: '1.2.3' });
  assert.equal(imageRef({ registry: 'r.io', repository: 'a/b', tag: 'v1' }), 'r.io/a/b:v1');
});

test('an image needs its registry host and a tag, not a digest', () => {
  assert.throws(() => parseImageRef('my-app/app:latest'), /registry host/);
  assert.throws(() => parseImageRef('app'), /registry host/);
  assert.throws(() => parseImageRef(''), /empty/);
  assert.throws(() => parseImageRef(`r.io/a@sha256:${'0'.repeat(64)}`), /digest/);
});

test('splits flags like a shell', () => {
  assert.deepEqual(splitArgs('--build-arg A=1   --label "two words" --x=\'y z\''), ['--build-arg', 'A=1', '--label', 'two words', '--x=y z']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('--empty ""'), ['--empty', '']);
  assert.throws(() => splitArgs('--label "open'), /Unclosed quote/);
});

test('suggests a readable name from the Launchpad slug', () => {
  assert.equal(suggestName('dlt-xo-f1pf41p/app'), 'Dlt');
  assert.equal(suggestName('my_cool.app/web'), 'My Cool App');
  assert.equal(suggestName(''), '');
});
