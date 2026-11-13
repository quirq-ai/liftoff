#!/usr/bin/env node
// Runs the spacehub agent "liftoff" on this computer:
//
//   node scripts/hub-sync.mjs            (or hub-sync.cmd on Windows)
//
// Liftoff's queue file lives in a spacehub project (hub/quirq/launch/queue.json).
// This keeps that project, and the rest of the space around it, in step with the
// hub both ways, pushing as the agent. An entry added to queue.json on the hub
// arrives here within a few seconds and Liftoff (liftoff serve) deploys it; the
// status Liftoff writes onto the entry goes back the same way. While this runs,
// the hub shows the agent as running in the space.
//
// It is spacehub's own "agent run", pointed at the folder that holds the space
// folder, and started again if it stops. You have to be signed in to spacehub as
// an owner of the agent (spacehub auth login); the agent's token is fetched by
// spacehub itself.
//
// Environment:
//   LIFTOFF_AGENT   the agent to run (default: liftoff)
//   LIFTOFF_HOME    Liftoff's data folder, to find the queue file (default: ~/.liftoff)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { resolveHome } from '../src/util.js';

const agent = process.env.LIFTOFF_AGENT || 'liftoff';
// <dir>/<space>/<project>/queue.json: spacehub wants <dir>.
const project = path.dirname(new Store(resolveHome()).queueFile());
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(project, '..', '..');

if (!process.argv[2] && !fs.existsSync(path.join(project, '.git'))) {
  console.error(`${project} is not a clone of a spacehub project, so there is nothing to sync.`);
  console.error('Move the queue file into one first: liftoff queue-file <folder>\\<space>\\<project>\\queue.json');
  process.exit(1);
}

console.log(`Running the spacehub agent ${agent} in ${dir}`);
console.log(`Queue file: ${path.join(project, 'queue.json')}`);
console.log('Press Ctrl+C to stop.\n');

let stopping = false;
let child = null;
function run() {
  // Through the shell so that the spacehub launcher on PATH is found on Windows too.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(agent)) {
    console.error(`"${agent}" is not an agent name.`);
    process.exit(1);
  }
  child = spawn(`spacehub agent run ${agent} "${dir}"`, { stdio: 'inherit', shell: true, windowsHide: true });
  child.on('error', (error) => {
    console.error(`Could not start spacehub: ${error.message}. Is it installed and on PATH?`);
    process.exit(1);
  });
  child.on('exit', (code) => {
    if (stopping) return;
    if (code === 2) {
      console.error('\nEvery project is paused on a conflict. Resolve them with git in their folders, then start this again.');
      process.exit(2);
    }
    console.error(`\nThe agent stopped (exit ${code}); starting it again in 5 seconds.`);
    setTimeout(run, 5000);
  });
}
run();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill();
    setTimeout(() => process.exit(0), 500);
  });
}
