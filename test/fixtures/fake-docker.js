#!/usr/bin/env node
// Stand-in for the docker CLI in tests: the suite puts a `docker` symlink to this file first on
// PATH. Answers the launcher's probes, and for `run` records its argv, the --env-file contents and
// its own environment, echoes stdin to stdout, and exits with FAKE_EXIT.
import fs from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const record = (entry) => log && fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);

const [cmd, sub] = args;
if (cmd === 'info' || cmd === 'stop') process.exit(0);
if (cmd === 'image' && sub === 'ls') {
  process.stdout.write(`${process.env.FAKE_IMAGE_ID || 'sha256:fake'}\n`);
  process.exit(0);
}
if (cmd === 'image' && sub === 'inspect') {
  process.stdout.write(`${process.env.FAKE_IMAGE_HASH || ''}\n`);
  process.exit(0);
}
if (cmd === 'network' && sub === 'inspect') {
  if (process.env.FAKE_NO_NETWORK) process.exit(1);
  process.stdout.write(`${process.env.FAKE_NET_DRIVER || 'bridge'}\n`);
  process.exit(0);
}
if (cmd !== 'run') process.exit(0);

const envFile = args[args.indexOf('--env-file') + 1];
record({ args, envFile: args.includes('--env-file') ? fs.readFileSync(envFile, 'utf8') : null, clientEnvPath: process.env.PATH });

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  // no stdin
}
process.stdout.write(`stdin:${input}`);
process.stderr.write('fake-stderr\n');
process.exit(Number(process.env.FAKE_EXIT || 0));
