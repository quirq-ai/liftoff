#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  },
);
