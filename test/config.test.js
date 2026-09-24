import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertSafeRoot, findProjectRoot, interpolate, isTrusted, loadConfig, trust } from '../src/config.js';
import { parseDotenv } from '../src/dotenv.js';
import { tmp } from './helpers.js';

test('project root: config file beats git root, git root beats cwd', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'repo/.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo/app/src'), { recursive: true });
  assert.equal(findProjectRoot(path.join(dir, 'repo/app/src')).root, path.join(dir, 'repo'));

  fs.writeFileSync(path.join(dir, 'repo/app/claude-pod.config.json'), '{}');
  const found = findProjectRoot(path.join(dir, 'repo/app/src'));
  assert.equal(found.root, path.join(dir, 'repo/app'));
  assert.equal(found.configPath, path.join(dir, 'repo/app/claude-pod.config.json'));
});

test('refuses to mount home, /, ancestors of home, home-like and non-project folders', () => {
  assert.throws(() => assertSafeRoot(os.homedir()), /home directory/);
  assert.throws(() => assertSafeRoot('/'), /filesystem root/);
  assert.throws(() => assertSafeRoot(path.dirname(os.homedir())), /contains your home|filesystem root/);

  const dir = tmp();
  assert.throws(() => assertSafeRoot(dir), /not a git repository/);
  assert.doesNotThrow(() => assertSafeRoot(dir, { requireProject: false }));
  fs.mkdirSync(path.join(dir, '.git'));
  assert.doesNotThrow(() => assertSafeRoot(dir));
  fs.mkdirSync(path.join(dir, '.ssh'));
  assert.throws(() => assertSafeRoot(dir), /looks like a home directory/);
});

test('dotenv: quotes, comments, export, first definition wins', () => {
  const vars = parseDotenv(['# c', 'A=plain # trailing', 'export B="q # not"', "C='s'", 'A=second', 'EMPTY=', 'junk'].join('\n'));
  assert.deepEqual(vars, { A: 'plain', B: 'q # not', C: 's', EMPTY: '' });
});

test('interpolate: envFile vars only, $$ escape, no newlines', () => {
  assert.equal(interpolate('u:${PW}@h $$HOME', { PW: 'x' }, 'env.X'), 'u:x@h $HOME');
  assert.throws(() => interpolate('${HOME}', {}, 'env.X'), /not set in the envFile/); // host env is never consulted
  assert.throws(() => interpolate('${toString}', {}, 'env.X'), /not set/); // no prototype lookups
  assert.throws(() => interpolate('${A}', { A: 'a\nb' }, 'env.X'), /newline/);
});

test('loadConfig resolves env from envFile and validates', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  const configPath = path.join(dir, 'claude-pod.config.json');
  fs.writeFileSync(path.join(dir, '.env'), 'PW=secret\n');
  fs.writeFileSync(configPath, JSON.stringify({
    $comment: 'x', network: 'app_default', ports: [3000, 3131], envFile: '.env',
    env: { DATABASE_URL: 'postgresql://u:${PW}@postgres/db' }, resources: { memory: '4g', cpus: 2, pids: 512 },
  }));
  const config = loadConfig({ root: dir, configPath });
  assert.equal(config.network, 'app_default');
  assert.deepEqual(config.env, { DATABASE_URL: 'postgresql://u:secret@postgres/db' });
  assert.match(config.hash, /^[0-9a-f]{64}$/);

  const bad = (obj, re) => {
    fs.writeFileSync(configPath, JSON.stringify(obj));
    assert.throws(() => loadConfig({ root: dir, configPath }), re);
  };
  bad({ port: [1] }, /unknown key "port"/);
  bad({ network: 'host' }, /bridge network/);
  bad({ network: 'container:db' }, /bridge network/);
  bad({ ports: [0] }, /not a port number/);
  bad({ ports: [80, 80] }, /duplicates/);
  bad({ env: { 'A-B': 'x' } }, /not a valid variable name/);
  bad({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }, /reserved/);
  bad({ env: { HOME: 'x' } }, /reserved/);
  bad({ envFile: '/etc/passwd' }, /relative to the project/);
  bad({ envFile: '../outside.env' }, /not found|outside the project/);
  bad({ resources: { memory: '0' } }, /memory/);
  bad({ resources: { cpus: '-1' } }, /cpus/);
  bad({ resources: { pids: 1 } }, /pids/);

  fs.writeFileSync(path.join(path.dirname(dir), 'outside.env'), 'A=1\n');
  fs.symlinkSync(path.join(path.dirname(dir), 'outside.env'), path.join(dir, 'link.env'));
  bad({ envFile: 'link.env' }, /resolves outside the project/);

  fs.rmSync(configPath);
  fs.symlinkSync(path.join(dir, '.env'), configPath);
  assert.throws(() => loadConfig({ root: dir, configPath }), /symlink/);
});

test('trust records are per project and per exact content', () => {
  const prev = process.env.HOME;
  process.env.HOME = tmp();
  try {
    const a = tmp();
    assert.equal(isTrusted(a, 'h1'), false);
    trust(a, 'h1');
    assert.equal(isTrusted(a, 'h1'), true);
    assert.equal(isTrusted(a, 'h2'), false);
    assert.equal(isTrusted(tmp(), 'h1'), false);
  } finally {
    process.env.HOME = prev;
  }
});
