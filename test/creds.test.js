import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireRefreshLock, isFresh, waitForRefresh } from '../src/creds.js';

function setup(expiresAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pod-lock-'));
  const credsFile = path.join(dir, '.credentials.json');
  const file = path.join(dir, 'refresh.lock');
  const writeCreds = (exp) => fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: exp } }));
  if (expiresAt !== undefined) writeCreds(expiresAt);
  return { credsFile, file, writeCreds };
}

test('isFresh applies a safety margin', () => {
  const now = 1_000_000_000;
  assert.equal(isFresh(now + 60 * 60_000, now), true);
  assert.equal(isFresh(now + 60_000, now), false);
  assert.equal(isFresh(0, now), false);
});

test('no lock needed while the token is fresh', async () => {
  const { credsFile, file } = setup(Date.now() + 3_600_000);
  assert.equal(await acquireRefreshLock({ file, credsFile }), null);
  assert.equal(fs.existsSync(file), false);
});

test('expired token: first launcher holds the lock, second waits until the refresh lands', async () => {
  const { credsFile, file, writeCreds } = setup(Date.now() - 1000);
  const release = await acquireRefreshLock({ file, credsFile });
  assert.equal(typeof release, 'function');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);

  let waited = false;
  const second = acquireRefreshLock({ file, credsFile, pollMs: 20, onWait: () => { waited = true; } });
  setTimeout(() => {
    writeCreds(Date.now() + 3_600_000); // the first pod refreshed
    release();
  }, 100);
  assert.equal(await second, null); // fresh token → starts without taking the lock
  assert.equal(waited, true);
  assert.equal(fs.existsSync(file), false);
});

test('a lock left by a dead process is taken over', async () => {
  const { credsFile, file } = setup(Date.now() - 1000);
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), createdAt: Date.now() }));
  const release = await acquireRefreshLock({ file, credsFile, pollMs: 10 });
  assert.equal(typeof release, 'function');
  release();
  assert.equal(fs.existsSync(file), false);
});

test('an old lock is treated as stale', async () => {
  const { credsFile, file } = setup(Date.now() - 1000);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: 'elsewhere', createdAt: Date.now() - 10 * 60_000 }));
  const release = await acquireRefreshLock({ file, credsFile, pollMs: 10, staleMs: 60_000 });
  assert.equal(typeof release, 'function');
  release();
});

test('gives up after the timeout instead of hanging', async () => {
  const { credsFile, file } = setup(Date.now() - 1000);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: 'elsewhere', createdAt: Date.now() }));
  assert.equal(await acquireRefreshLock({ file, credsFile, pollMs: 10, timeoutMs: 50 }), null);
});

test('waitForRefresh sees a newer token, and stops early when asked', async () => {
  const { credsFile, writeCreds } = setup(Date.now() - 1000);
  const before = Date.now() - 1000;
  setTimeout(() => writeCreds(Date.now() + 3_600_000), 50);
  assert.equal(await waitForRefresh({ before, credsFile, pollMs: 10 }), true);
  assert.equal(await waitForRefresh({ before: Date.now() + 3_600_000 * 2, credsFile, pollMs: 10, stop: () => true }), false);
});
