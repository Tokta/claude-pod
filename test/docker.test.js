import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunArgs } from '../src/docker.js';
import { allocatePorts } from '../src/ports.js';

const base = {
  name: 'claude-pod-app-abc123', mode: 'run', root: '/work/app', workdir: '/work/app/sub',
  stateDir: '/home/me/.claude-pod/pods/app-123', uid: 501, gid: 20, interactive: false, tty: false,
  envFile: '/home/me/.config/claude-pod/run/x/env',
};

test('hardening, mounts and identity flags are always present', () => {
  const args = buildRunArgs({ ...base, command: ['claude', '--version'] });
  for (const flag of ['--rm', '--init', '--stop-timeout=10', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=4096']) {
    assert.ok(args.includes(flag), flag);
  }
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--user'), '501:20');
  assert.equal(after('--name'), 'claude-pod-app-abc123');
  assert.equal(after('-w'), '/work/app/sub');
  assert.equal(after('--env-file'), base.envFile);
  assert.ok(args.includes('/work/app:/work/app'));
  assert.ok(args.includes('/home/me/.claude-pod/pods/app-123:/home/claude-pod/.claude'));
  assert.ok(args.includes('CLAUDE_CONFIG_DIR=/home/claude-pod/.claude'));
  assert.ok(!args.some((a) => a.endsWith('.claude.json')), 'no single-file mounts');
  assert.deepEqual(args.slice(-3), ['claude-pod', 'claude', '--version']);
  assert.ok(!args.includes('-i') && !args.includes('-t'));
});

test('protected paths are mounted read-only after the project mount', () => {
  const args = buildRunArgs({ ...base, pinned: ['/work/app/.git'], readOnly: ['/work/app/.git/hooks', '/work/app/.claude'] });
  const project = args.indexOf('/work/app:/work/app');
  const pinned = args.indexOf('/work/app/.git:/work/app/.git');
  assert.ok(pinned > project && pinned < args.indexOf('/work/app/.git/hooks:/work/app/.git/hooks:ro'));
  assert.ok(args.indexOf('/work/app/.git/hooks:/work/app/.git/hooks:ro') > project);
  assert.ok(args.indexOf('/work/app/.claude:/work/app/.claude:ro') > project);
});

test('paths with colons are refused', () => {
  assert.throws(() => buildRunArgs({ ...base, root: '/work/a:/etc', workdir: '/work/a:/etc' }), /colon/);
  assert.throws(() => buildRunArgs({ ...base, readOnly: ['/work/app/x:y'] }), /colon/);
});

test('ports bind to loopback only and are exposed as env', () => {
  const args = buildRunArgs({ ...base, ports: [{ container: 3000, host: 51234 }] });
  assert.ok(args.includes('127.0.0.1:51234:3000'));
  assert.ok(args.includes('CLAUDE_POD_PORT_3000=51234'));
});

test('network, resources and tty flags', () => {
  const args = buildRunArgs({ ...base, interactive: true, tty: true, network: 'none', resources: { pids: 100, memory: '4g', cpus: 2 } });
  for (const flag of ['-i', '-t', '--network=none', '--pids-limit=100', '--memory=4g', '--cpus=2']) assert.ok(args.includes(flag), flag);
});

test('allocatePorts returns distinct host ports', async () => {
  const ports = await allocatePorts([3000, 3131, 8080]);
  assert.deepEqual(ports.map((p) => p.container), [3000, 3131, 8080]);
  assert.equal(new Set(ports.map((p) => p.host)).size, 3);
});
