// End-to-end tests of the CLI against a fake docker (test/fixtures/fake-docker.js).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dockerfileHash } from '../src/docker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'claude-pod.js');
const FAKE = path.join(here, 'fixtures', 'fake-docker.js');

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pod-cli-')));
  const project = path.join(dir, 'app');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_POD_DOCKER: FAKE,
    CLAUDE_POD_HOME: path.join(dir, 'pod-home'),
    FAKE_LOG: path.join(dir, 'docker.log'),
    FAKE_IMAGE_HASH: dockerfileHash(),
    NO_COLOR: '1',
  };
  const runs = () => (fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { dir, project, env, runs };
}

function cli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const writeCreds = (env, expiresAt) => {
  fs.mkdirSync(env.CLAUDE_POD_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_POD_HOME, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r1', expiresAt } }));
};

test('run: prompt on stdin, output files, exit code', async () => {
  const { dir, project, env, runs } = sandbox();
  writeCreds(env, Date.now() + 3_600_000);
  fs.writeFileSync(path.join(dir, 'task.md'), 'do the thing');
  const out = path.join(dir, 'scratch', 'impl-1');

  const res = await cli(['run', '--model', 'opus', '--prompt-file', path.join(dir, 'task.md'), '--out', out, '--', '--max-turns', '3'], {
    cwd: project, env: { ...env, FAKE_EXIT: '3' },
  });
  assert.equal(res.code, 3, res.stderr);
  assert.equal(res.stdout, 'exit=3\n');
  assert.equal(fs.readFileSync(`${out}.out`, 'utf8'), 'stdin:do the thing');
  assert.equal(fs.readFileSync(`${out}.err`, 'utf8'), 'fake-stderr\n');
  assert.equal(fs.readFileSync(`${out}.exit`, 'utf8'), '3\n');

  const { args } = runs()[0];
  const cmd = args.slice(args.indexOf('claude-pod') + 1);
  assert.deepEqual(cmd, ['claude', '--print', '--dangerously-skip-permissions', '--output-format', 'text', '--model', 'opus', '--max-turns', '3']);
  assert.ok(args.includes('-i'), 'stdin attached for the prompt');
  assert.ok(!args.includes('-t'));
  assert.ok(!args.includes('-p'), 'run publishes no ports by default');
  assert.ok(args.includes('claude-pod.mode=run'));
});

test('run without --out streams and still exits with the pod code', async () => {
  const { project, env } = sandbox();
  writeCreds(env, Date.now() + 3_600_000);
  const res = await cli(['run', '--prompt', 'hello'], { cwd: project, env: { ...env, FAKE_EXIT: '0' } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'stdin:');
});

test('claude passes args through unchanged; exec publishes config ports and injects env', async () => {
  const { project, env, runs } = sandbox();
  fs.writeFileSync(path.join(project, '.env'), 'PW=hunter2\n');
  fs.writeFileSync(path.join(project, 'claude-pod.config.json'), JSON.stringify({
    ports: [3000], envFile: '.env', env: { DB: 'postgresql://u:${PW}@postgres/db' },
  }));
  fs.mkdirSync(path.join(project, 'sub'));

  assert.equal((await cli(['claude', '--model', 'opus'], { cwd: project, env })).code, 0);
  const claudeArgs = runs()[0].args;
  assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf('claude-pod') + 1), ['claude', '--model', 'opus']);

  const res = await cli(['exec', 'pnpm', 'test'], { cwd: path.join(project, 'sub'), env });
  assert.equal(res.code, 0, res.stderr);
  const { args, env: podEnv } = runs()[1];
  assert.equal(podEnv.DB, 'postgresql://u:hunter2@postgres/db');
  assert.ok(!args.join(' ').includes('hunter2'), 'secret not on the command line');
  assert.equal(args[args.indexOf('-w') + 1], path.join(project, 'sub'));
  const port = args[args.indexOf('-p') + 1];
  assert.match(port, /^127\.0\.0\.1:\d+:3000$/);
  assert.match(res.stderr, /port 3000 → http:\/\/127\.0\.0\.1:\d+/);
});

test('credential lock: parallel runs on an expired token refresh it exactly once', async () => {
  const { dir, project, env, runs } = sandbox();
  writeCreds(env, Date.now() - 60_000);
  const e = { ...env, FAKE_REFRESH: '400' };
  const results = await Promise.all([1, 2, 3].map((i) => cli(['run', '--prompt', 'x', '--out', path.join(dir, `r${i}`)], { cwd: project, env: e })));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(env.CLAUDE_POD_HOME, '.credentials.json.refreshes'), 'utf8'), 'x');
  assert.equal(runs().filter((r) => r.sawExpired).length, 1);
  assert.equal(fs.existsSync(path.join(env.CLAUDE_POD_HOME, 'refresh.lock')), false);
});

test('auth --from: writes private creds, skips onboarding, guards against older tokens', async () => {
  const { dir, project, env } = sandbox();
  const src = path.join(dir, 'host-creds.json');
  const credsFile = path.join(env.CLAUDE_POD_HOME, '.credentials.json');
  const write = (exp) => fs.writeFileSync(src, JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: exp } }));

  write(1000);
  assert.equal((await cli(['auth', '--from', src], { cwd: project, env })).code, 0);
  assert.equal(fs.statSync(credsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(env.CLAUDE_POD_HOME).mode & 0o777, 0o700);
  const state = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_POD_HOME, '.claude.json'), 'utf8'));
  assert.equal(state.hasCompletedOnboarding, true);

  writeCreds(env, 5000); // the pod refreshed since
  const refused = await cli(['auth', '--from', src], { cwd: project, env });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /newer token/);
  assert.equal((await cli(['auth', '--from', src, '--force'], { cwd: project, env })).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(credsFile, 'utf8')).claudeAiOauth.expiresAt, 1000);

  fs.writeFileSync(src, '{"claudeAiOauth":{}}');
  assert.match((await cli(['auth', '--from', src, '--force'], { cwd: project, env })).stderr, /no claudeAiOauth\.refreshToken/);
});

test('usage errors', async () => {
  const { project, env } = sandbox();
  assert.equal((await cli(['nope'], { cwd: project, env })).code, 1);
  assert.equal((await cli(['run'], { cwd: project, env })).code, 1);
  assert.equal((await cli(['run', '--prompt', 'x', 'stray'], { cwd: project, env })).code, 1);
  assert.equal((await cli(['run', '--bogus'], { cwd: project, env })).code, 2);
  assert.equal((await cli(['exec'], { cwd: project, env })).code, 1);
});
