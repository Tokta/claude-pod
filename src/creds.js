import fs from 'node:fs';
import os from 'node:os';
import { credentialsPath, refreshLockPath } from './paths.js';
import { warn } from './ui.js';

// Treat a token this close to expiry as already expired: Claude refreshes a little early.
export const FRESH_MARGIN_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The access token's expiry (ms since epoch) from a credentials JSON string, or 0.
export function expiresAtOf(json) {
  try {
    return JSON.parse(json)?.claudeAiOauth?.expiresAt || 0;
  } catch {
    return 0;
  }
}

// Expiry of the pod's stored token, or null if there are no credentials yet.
export function readExpiresAt(file = credentialsPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return expiresAtOf(text);
}

export const isFresh = (expiresAt, now = Date.now()) => !!expiresAt && expiresAt > now + FRESH_MARGIN_MS;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A lock is stale when its owner is gone (crashed launcher) or it has been held implausibly long.
function lockIsStale(file, staleMs, now) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (owner.hostname === os.hostname() && !pidAlive(owner.pid)) return true;
    return now - owner.createdAt > staleMs;
  } catch {
    // Unreadable: possibly mid-write by its creator. Stale only if it has sat there a while.
    try {
      return now - fs.statSync(file).mtimeMs > staleMs;
    } catch {
      return false; // vanished; the next loop iteration will just retry.
    }
  }
}

// Credential lock. Every pod shares one OAuth login, and the server rotates the refresh token on
// each refresh — so if two pods start with the same expired token, both refresh with it and the
// loser gets a 401. When the stored token is expired, launchers take this lock one at a time:
// the holder starts its pod and releases once that pod has written a fresh token; the next
// launcher then sees a fresh token and starts without waiting.
//
// Resolves to a release function, or null if no lock was needed (the token is fresh — possibly
// refreshed by another pod while we waited — or we gave up waiting after `timeoutMs`).
export async function acquireRefreshLock({
  file = refreshLockPath(), credsFile = credentialsPath(),
  timeoutMs = 120_000, pollMs = 500, staleMs = 120_000, onWait = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    if (isFresh(readExpiresAt(credsFile))) return null;
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener('exit', release);
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
        } catch {
          // Already gone (e.g. judged stale and removed by another launcher).
        }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (lockIsStale(file, staleMs, Date.now())) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Someone else removed it first.
      }
      continue;
    }
    if (Date.now() > deadline) {
      warn('Gave up waiting for another pod to refresh the login; starting anyway.');
      return null;
    }
    if (!announced) {
      onWait();
      announced = true;
    }
    await sleep(pollMs);
  }
}

// Resolves true once the stored token has been refreshed past `before`, false on timeout or when
// `stop()` returns true (e.g. the pod already exited).
export async function waitForRefresh({ before, credsFile = credentialsPath(), timeoutMs = 60_000, pollMs = 250, stop = () => false }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stop()) {
    const now = readExpiresAt(credsFile);
    if (now && now > (before || 0) && isFresh(now)) return true;
    await sleep(pollMs);
  }
  return false;
}
