import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { expiresAtOf } from '../creds.js';
import { ensurePodDir } from '../launch.js';
import { claudeJsonPath, credentialsPath } from '../paths.js';
import { CliError, bold, detail, ok, warn } from '../ui.js';

export const AUTH_HELP = `Usage: claude-pod auth [--force] [--from FILE]

Copies your host Claude Code login into the pod (~/.claude-pod/.credentials.json).
The in-pod /login browser flow doesn't work (the OAuth redirect is rejected), so the pod
reuses the host session instead. Also marks onboarding as done so the pod skips the wizard.

Source: the macOS Keychain on macOS, ~/.claude/.credentials.json elsewhere, or --from FILE.

Options:
  --force      overwrite even if the pod holds a newer token. Only right after a fresh host
               /login — re-exporting an older token is what causes 401s.
  --from FILE  read the credentials JSON from FILE`;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function readHostCredentials(from) {
  if (from) {
    try {
      return { json: fs.readFileSync(from, 'utf8'), source: from };
    } catch (e) {
      throw new CliError(`Cannot read ${from}: ${e.code || e.message}`);
    }
  }
  if (process.platform === 'darwin') {
    const res = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' });
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      throw new CliError(`No '${KEYCHAIN_SERVICE}' entry in the Keychain.`, { hint: 'Log in to Claude Code on the host first.' });
    }
    return { json: res.stdout.trim(), source: 'macOS Keychain' };
  }
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  try {
    return { json: fs.readFileSync(file, 'utf8'), source: file };
  } catch {
    throw new CliError(`No host credentials at ${file}.`, { hint: 'Log in to Claude Code on the host first, or pass --from FILE.' });
  }
}

// Writes via a temp file + rename so the pod never sees a half-written token, and with 0600 from
// the start so the token is never briefly world-readable.
function writePrivate(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export async function auth(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: 'boolean', default: false },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${AUTH_HELP}\n`);
    return 0;
  }

  const { json, source } = readHostCredentials(values.from);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError(`Credentials from ${source} are not valid JSON.`);
  }
  if (!parsed?.claudeAiOauth?.refreshToken) {
    throw new CliError(`Credentials from ${source} have no claudeAiOauth.refreshToken.`);
  }

  // Rotation guard: a running pod refreshes its token and rotates the refresh token server-side,
  // which invalidates the host copy. Overwriting a newer pod token with that stale one breaks auth.
  const dest = credentialsPath();
  if (!values.force && fs.existsSync(dest)) {
    const pod = expiresAtOf(fs.readFileSync(dest, 'utf8'));
    if (pod > expiresAtOf(json)) {
      warn("The pod already holds a newer token than the host's — not overwriting.");
      warn('The pod refreshes itself; re-exporting an older host token is what causes 401s.');
      throw new CliError('Nothing to do.', { hint: `If you just did a fresh host ${bold('/login')}, re-run with ${bold('--force')}.` });
    }
  }

  ensurePodDir();

  // Skip the first-run wizard: its login-method picker would start the broken browser flow.
  const cj = claudeJsonPath();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(cj, 'utf8') || '{}');
  } catch {
    // Unparseable: start over rather than fail.
  }
  state.hasCompletedOnboarding = true;
  if (!state.theme) state.theme = 'dark';
  writePrivate(cj, JSON.stringify(state, null, 2));

  writePrivate(dest, json);

  const exp = expiresAtOf(json);
  ok(`Pod credentials written to ${bold(dest)} (from ${source})`);
  detail(`access token expires: ${exp ? new Date(exp).toISOString() : 'unknown'} (auto-refreshed by Claude in the pod)`);
  return 0;
}
