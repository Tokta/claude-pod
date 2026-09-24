import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertSafeRoot, findProjectRoot, loadConfig } from './config.js';
import { acquireRefreshLock, isFresh, readExpiresAt, waitForRefresh } from './creds.js';
import { assertNetwork, buildRunArgs, preflight } from './docker.js';
import { claudeJsonPath, credentialsPath, dockerBin, podDir } from './paths.js';
import { allocatePorts } from './ports.js';
import { bold, detail, info, warn } from './ui.js';

// Creates the host state dir and seeds the login file. Docker would create a *directory* at a
// missing bind-mount source, and Claude treats an empty file as a JSON parse error, hence `{}`.
// Owner-only permissions: it holds the OAuth token and session transcripts.
export function ensurePodDir() {
  const dir = podDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const cj = claudeJsonPath();
  if (!fs.existsSync(cj) || fs.statSync(cj).size === 0) fs.writeFileSync(cj, '{}');
  fs.chmodSync(cj, 0o600);
}

export function podName(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 30) || 'project';
  return `claude-pod-${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

// Settings the old per-project scripts took from env vars; they still override the config file.
function applyEnvOverrides(config) {
  const resources = { ...config.resources };
  if (process.env.PIDS) resources.pids = process.env.PIDS;
  if (process.env.MEMORY) resources.memory = process.env.MEMORY;
  if (process.env.CPUS) resources.cpus = process.env.CPUS;
  const network = process.env.NET === 'none' ? 'none' : config.network;
  return { ...config, resources, network };
}

// Starts a pod for the project containing `cwd` and resolves to the exit code of `command`.
//   mode           label value shown by `claude-pod ps` (shell | claude | exec | run)
//   usesClaude     take the credential lock when the stored token needs a refresh
//   publishPorts   publish the config's ports on free loopback host ports
//   stdio          [stdin, stdout, stderr] for the docker client ('inherit' or fds)
export async function launch({ mode, command, cwd = process.cwd(), usesClaude, publishPorts, stdio = 'inherit' }) {
  const { root, configPath } = findProjectRoot(cwd);
  assertSafeRoot(root);
  const config = applyEnvOverrides(loadConfig({ root, configPath }));

  preflight();
  assertNetwork(config.network);
  ensurePodDir();

  let ports = [];
  if (publishPorts && config.ports.length) {
    if (config.network === 'none') warn('Network is "none": not publishing any ports.');
    else ports = await allocatePorts(config.ports);
  }

  const [stdin, stdout] = Array.isArray(stdio) ? stdio : [stdio, stdio];
  const stdinTty = stdin === 'inherit' ? !!process.stdin.isTTY : false;
  const stdoutTty = stdout === 'inherit' ? !!process.stdout.isTTY : false;
  // -i whenever stdin carries something (a terminal or a prompt file); -t only for a real terminal
  // on both ends — passing -t with piped input makes docker fail.
  const interactive = stdinTty || (stdin !== 'inherit' && stdin !== 'ignore');
  const tty = stdinTty && stdoutTty;

  const rel = path.relative(root, cwd);
  const workdir = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.resolve(cwd) : root;
  const name = podName(root);

  const args = buildRunArgs({
    name, mode, root, workdir, podDir: podDir(),
    uid: process.getuid(), gid: process.getgid(),
    interactive, tty,
    ports, network: config.network, env: config.env, resources: config.resources,
    command,
  });

  info(`claude-pod ${name}`);
  detail(`project: ${root}${configPath ? '' : ' (no claude-pod.config.json)'}`);
  if (config.network) detail(`network: ${config.network}`);
  for (const { container, host } of ports) detail(`port ${container} → http://127.0.0.1:${host}`);

  let release = null;
  let before = null;
  if (usesClaude) {
    before = readExpiresAt();
    if (before === null) {
      warn(`No pod credentials at ${credentialsPath()}. Run ${bold('claude-pod auth')} first.`);
    } else if (!isFresh(before)) {
      release = await acquireRefreshLock({ onWait: () => detail('waiting for another pod to refresh the login…') });
      before = readExpiresAt();
    }
  }

  const child = spawn(dockerBin(), args, {
    stdio: Array.isArray(stdio) ? stdio : 'inherit',
    env: { ...process.env, ...config.env },
  });

  // Forward signals to the docker client, whose sig-proxy passes them to the pod, and keep running
  // until docker exits. Signals may target the launcher alone (an agent harness killing its
  // child), so relying on the terminal's process-group delivery isn't enough.
  const onSignal = (sig) => child.kill(sig);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);

  let exited = false;
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      exited = true;
      resolve(code ?? 128 + (os.constants.signals[signal] || 0));
    });
  });

  if (release) {
    const refreshed = await waitForRefresh({ before, stop: () => exited });
    release();
    if (!refreshed && !exited) warn('The pod has not refreshed the login yet; releasing the lock anyway.');
  }

  try {
    return await exit;
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, onSignal);
  }
}
