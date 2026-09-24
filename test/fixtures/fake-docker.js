#!/usr/bin/env node
// Stand-in for the docker CLI in tests (selected via CLAUDE_POD_DOCKER). Answers the probes the
// launcher makes, and for `run` simulates a pod: logs its argv, optionally "refreshes" the OAuth
// token the way Claude would, echoes stdin to stdout, and exits with FAKE_EXIT.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const record = (entry) => log && fs.appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [cmd, sub] = args;
if (cmd === 'info' || cmd === 'network' || cmd === 'stop') process.exit(0);
if (cmd === 'image' && sub === 'ls') {
  process.stdout.write('abc123\n');
  process.exit(0);
}
if (cmd === 'image' && sub === 'inspect') {
  process.stdout.write(`${process.env.FAKE_IMAGE_HASH || ''}\n`);
  process.exit(0);
}
if (cmd !== 'run') process.exit(0);

// Simulated Claude refresh: if the stored token is expired when the pod starts, spend the refresh
// token (count it) and write a fresh one. Two pods starting on the same expired token would both
// count — that's the 401 race the credential lock prevents.
const creds = path.join(process.env.CLAUDE_POD_HOME, '.credentials.json');
const readExp = () => JSON.parse(fs.readFileSync(creds, 'utf8')).claudeAiOauth.expiresAt;
if (process.env.FAKE_REFRESH && fs.existsSync(creds)) {
  const expired = readExp() < Date.now() + 5 * 60_000;
  record({ run: true, args, sawExpired: expired });
  if (expired) {
    await sleep(Number(process.env.FAKE_REFRESH));
    fs.appendFileSync(`${creds}.refreshes`, 'x');
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 } }));
  }
} else {
  record({ run: true, args, env: { DB: process.env.DB } });
}

let input = '';
if (!process.stdin.isTTY) {
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    // no stdin
  }
}
process.stdout.write(`stdin:${input}`);
process.stderr.write('fake-stderr\n');
process.exit(Number(process.env.FAKE_EXIT || 0));
