import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertSafeRoot, findProjectRoot, interpolate, loadConfig } from '../src/config.js';
import { parseDotenv } from '../src/dotenv.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pod-test-')));

test('project root: config file beats git root, git root beats cwd', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'repo/.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo/app/src'), { recursive: true });
  assert.equal(findProjectRoot(path.join(dir, 'repo/app/src')).root, path.join(dir, 'repo'));

  fs.writeFileSync(path.join(dir, 'repo/app/claude-pod.config.json'), '{}');
  const found = findProjectRoot(path.join(dir, 'repo/app/src'));
  assert.equal(found.root, path.join(dir, 'repo/app'));
  assert.equal(found.configPath, path.join(dir, 'repo/app/claude-pod.config.json'));

  fs.mkdirSync(path.join(dir, 'loose'));
  assert.equal(findProjectRoot(path.join(dir, 'loose')).root, path.join(dir, 'loose'));
});

test('refuses to mount home or filesystem root', () => {
  assert.throws(() => assertSafeRoot(os.homedir()), /Refusing/);
  assert.throws(() => assertSafeRoot('/'), /Refusing/);
  assert.doesNotThrow(() => assertSafeRoot(tmp()));
});

test('dotenv: quotes, comments, export, first definition wins', () => {
  const vars = parseDotenv([
    '# comment',
    'A=plain # trailing',
    'export B="quoted # not a comment"',
    "C='single'",
    'A=second',
    'EMPTY=',
    'not a line',
  ].join('\n'));
  assert.deepEqual(vars, { A: 'plain', B: 'quoted # not a comment', C: 'single', EMPTY: '' });
});

test('interpolate: ${VAR}, $$ escape, unknown var fails', () => {
  assert.equal(interpolate('u:${PW}@h $$HOME', { PW: 'x' }, 'env.X'), 'u:x@h $HOME');
  assert.throws(() => interpolate('${NOPE}', {}, 'env.X'), /env\.X references \$\{NOPE\}/);
});

test('loadConfig resolves env from envFile and validates', () => {
  const dir = tmp();
  const configPath = path.join(dir, 'claude-pod.config.json');
  fs.writeFileSync(path.join(dir, '.env'), 'PW=secret\n');
  fs.writeFileSync(configPath, JSON.stringify({
    $comment: 'ignored', network: 'app_default', ports: [3000, 3131], envFile: '.env',
    env: { DATABASE_URL: 'postgresql://u:${PW}@postgres/db' }, resources: { memory: '4g' },
  }));
  const config = loadConfig({ root: dir, configPath });
  assert.equal(config.network, 'app_default');
  assert.deepEqual(config.ports, [3000, 3131]);
  assert.deepEqual(config.env, { DATABASE_URL: 'postgresql://u:secret@postgres/db' });
  assert.deepEqual(config.resources, { memory: '4g' });

  const bad = (obj, re) => {
    fs.writeFileSync(configPath, JSON.stringify(obj));
    assert.throws(() => loadConfig({ root: dir, configPath }), re);
  };
  bad({ port: [1] }, /unknown key "port"/);
  bad({ ports: [0] }, /not a port number/);
  bad({ ports: ['3000'] }, /not a port number/);
  bad({ ports: [80, 80] }, /duplicates/);
  bad({ env: { 'A-B': 'x' } }, /not a valid variable name/);
  bad({ env: { A: 1 } }, /must be a string/);
  bad({ envFile: 'missing.env' }, /not found/);
  bad({ resources: { gpu: 1 } }, /unknown "resources" key/);
  fs.writeFileSync(configPath, '{ nope');
  assert.throws(() => loadConfig({ root: dir, configPath }), /Could not read/);
});

test('loadConfig with no config file returns defaults', () => {
  assert.deepEqual(loadConfig({ root: tmp(), configPath: null }), {
    network: null, ports: [], env: {}, resources: {}, file: null,
  });
});
