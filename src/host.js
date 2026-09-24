// Host-only state (~/.config/claude-pod): never mounted into a pod, so a pod can't read or forge it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostDir, hostSettingsPath, tokenPath } from './paths.js';
import { ensurePrivateDir, readRegularFile, writeFileAtomic } from './safefs.js';
import { CliError } from './ui.js';

// ── Login token ───────────────────────────────────────────────────────────────────────────────
// A long-lived token from `claude setup-token`, handed to each pod as CLAUDE_CODE_OAUTH_TOKEN.
// Unlike a copied OAuth login it never refreshes or rotates, so pods share nothing writable about
// the login: no credentials file in the pod state, no refresh races, no lock.

export function readToken() {
  try {
    return readRegularFile(tokenPath(), 16 * 1024)?.toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

export function validateToken(token) {
  const t = token.trim();
  if (!t) throw new CliError('No token given.');
  if (!/^[\x21-\x7e]{20,4096}$/.test(t)) throw new CliError('That does not look like a token (expected one line of printable characters).');
  return t;
}

export function saveToken(token) {
  ensurePrivateDir(hostDir());
  writeFileAtomic(tokenPath(), `${token}\n`);
}

// ── Host settings ─────────────────────────────────────────────────────────────────────────────
// ~/.config/claude-pod/settings.json, e.g. {"runDirs": ["/Users/me/scratch"]}

function hostSettings() {
  try {
    const s = JSON.parse(readRegularFile(hostSettingsPath())?.toString('utf8') || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    throw new CliError(`Could not read ${hostSettingsPath()}: ${e.message}`);
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Where `claude-pod run` may read --prompt-file and write --out: the system temp dirs (agent
// scratchpads live there) plus any `runDirs` you list. Stops an orchestrating agent that is
// auto-approved for `claude-pod run` from using it to ship arbitrary host files (~/.ssh/…) into a
// pod, or to write output files anywhere.
export function allowedRunDirs() {
  const dirs = [os.tmpdir(), '/tmp', '/var/tmp'];
  const extra = hostSettings().runDirs;
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.some((d) => typeof d !== 'string' || !path.isAbsolute(d))) {
      throw new CliError(`${hostSettingsPath()}: "runDirs" must be an array of absolute paths.`);
    }
    dirs.push(...extra);
  }
  return [...new Set(dirs.map(realOrNull).filter(Boolean))];
}
