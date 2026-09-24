#!/usr/bin/env node
import { main } from '../src/cli.js';

// Output piped into e.g. `head` closes early; that's not an error worth a stack trace.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2));
