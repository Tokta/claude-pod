import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunArgs } from '../src/docker.js';
import { allocatePorts } from '../src/ports.js';

const base = {
  name: 'claude-pod-app-abc123', mode: 'run', root: '/work/app', workdir: '/work/app/sub',
  podDir: '/home/me/.claude-pod', uid: 501, gid: 20, interactive: false, tty: false,
};

test('hardening, mounts and identity flags are always present', () => {
  const args = buildRunArgs({ ...base, command: ['claude', '--version'] });
  for (const flag of ['--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=4096']) {
    assert.ok(args.includes(flag), flag);
  }
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--user'), '501:20');
  assert.equal(after('--name'), 'claude-pod-app-abc123');
  assert.equal(after('-w'), '/work/app/sub');
  assert.ok(args.includes('/work/app:/work/app'));
  assert.ok(args.includes('/home/me/.claude-pod:/home/claude-pod/.claude'));
  assert.ok(args.includes('/home/me/.claude-pod/.claude.json:/home/claude-pod/.claude.json'));
  assert.ok(args.includes('claude-pod.project=/work/app'));
  assert.deepEqual(args.slice(-3), ['claude-pod', 'claude', '--version']);
  assert.ok(!args.includes('-i') && !args.includes('-t'));
});

test('ports bind to loopback only and are exposed as env', () => {
  const args = buildRunArgs({ ...base, ports: [{ container: 3000, host: 51234 }] });
  assert.ok(args.includes('127.0.0.1:51234:3000'));
  assert.ok(args.includes('CLAUDE_POD_PORT_3000=51234'));
});

test('config env is passed by name only, never by value', () => {
  const args = buildRunArgs({ ...base, env: { DATABASE_URL: 'postgresql://u:hunter2@db/x' } });
  assert.equal(args[args.indexOf('DATABASE_URL') - 1], '-e');
  assert.ok(!args.join(' ').includes('hunter2'));
});

test('network, resources and tty flags', () => {
  const args = buildRunArgs({
    ...base, interactive: true, tty: true, network: 'none',
    resources: { pids: 100, memory: '4g', cpus: 2 },
  });
  for (const flag of ['-i', '-t', '--network=none', '--pids-limit=100', '--memory=4g', '--cpus=2']) {
    assert.ok(args.includes(flag), flag);
  }
});

test('allocatePorts returns distinct, bindable host ports', async () => {
  const ports = await allocatePorts([3000, 3131, 8080]);
  assert.deepEqual(ports.map((p) => p.container), [3000, 3131, 8080]);
  assert.equal(new Set(ports.map((p) => p.host)).size, 3);
  for (const { host } of ports) assert.ok(host > 0 && host < 65536);
});
