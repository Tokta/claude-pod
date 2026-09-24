import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig, trust, validateResources } from './config.js';
import { assertNetwork, buildRunArgs, docker, preflight } from './docker.js';
import { readToken } from './host.js';
import { podsDir, projectStateDir, runDir, stateRoot } from './paths.js';
import { allocatePorts } from './ports.js';
import { canPrompt, confirm } from './prompt.js';
import {
  clearPending, protectedMounts, quarantineCreated, recordPending, snapshotMissing, sweepPending,
} from './protect.js';
import { ensurePrivateDir, isInside, kind, writeFileAtomic } from './safefs.js';
import { CliError, bold, clean, detail, info, warn } from './ui.js';

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog.js');

// Whether a container with this exact name exists in any state (created, running, exiting).
// Errs on "yes" when Docker can't answer, so a live pod's record is never swept by mistake.
export function containerExists(name) {
  try {
    const res = docker(['ps', '-a', '-q', '--filter', `name=^${name}$`]);
    return res.status !== 0 || res.stdout.trim() !== '';
  } catch {
    return true;
  }
}

export function podName(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 30) || 'project';
  return `claude-pod-${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

// Host overrides from the old per-project scripts. They can only narrow or cap, and are validated.
function applyEnvOverrides(config) {
  const resources = { ...config.resources };
  if (process.env.PIDS) resources.pids = process.env.PIDS;
  if (process.env.MEMORY) resources.memory = process.env.MEMORY;
  if (process.env.CPUS) resources.cpus = process.env.CPUS;
  validateResources(resources, 'PIDS/MEMORY/CPUS');
  if (process.env.NET && process.env.NET !== 'none') throw new CliError('NET only accepts "none".');
  const network = process.env.NET === 'none' ? 'none' : config.network;
  return { ...config, resources, network };
}

// A config is honoured only once you have approved its exact bytes. Interactive launches ask;
// unattended ones (no terminal — e.g. an orchestrating agent) fail closed.
async function ensureTrusted(root, config) {
  if (!config.file || isTrusted(root, config.hash)) return;
  if (!canPrompt()) {
    throw new CliError(`${config.file} is new or has changed since you approved it.`, {
      hint: `Review it (a pod can edit it), then run ${bold('claude-pod trust')} in a terminal. Unattended runs never approve configs.`,
    });
  }
  warn(`${config.file} is new or has changed since you approved it. A pod can edit this file, so review it:`);
  process.stderr.write(`\n${clean(config.text.trimEnd(), '\n\t')}\n\n`);
  if (!(await confirm('Trust this config for this project?'))) throw new CliError('Config not trusted; not starting the pod.');
  trust(root, config.hash);
}

// This project's Claude state dir (sessions, settings, .claude.json). The pod can write anything in
// it, so we only ever (re)create files by rename and never read them back.
function ensureProjectState(root) {
  ensurePrivateDir(stateRoot());
  ensurePrivateDir(podsDir());
  const dir = projectStateDir(root);
  ensurePrivateDir(dir);
  const cj = path.join(dir, '.claude.json');
  if (kind(cj) !== 'file') {
    fs.rmSync(cj, { recursive: true, force: true }); // a symlink is removed itself, not its target
    // Skip the first-run wizard: its login picker would start the broken in-container browser flow.
    writeFileAtomic(cj, `${JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }, null, 2)}\n`);
  }
  return dir;
}

// The host's global git identity, so agents can commit without touching the (read-only) repo
// config. Written as a global gitconfig in the pod's state dir: lower precedence than the repo's
// own config, so a per-repo identity still wins.
function writeGitIdentity(stateDir) {
  const get = (key) => {
    const res = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' });
    const v = res.status === 0 ? res.stdout.trim() : '';
    return /^[^\n\r\0]{1,200}$/.test(v) ? v : '';
  };
  const quote = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const name = get('user.name');
  const email = get('user.email');
  const lines = ['# Written by claude-pod on every launch.'];
  if (name || email) lines.push('[user]');
  if (name) lines.push(`\tname = ${quote(name)}`);
  if (email) lines.push(`\temail = ${quote(email)}`);
  writeFileAtomic(path.join(stateDir, 'gitconfig'), `${lines.join('\n')}\n`, 0o644);
}

// Docker --env-file content. Values can't contain newlines (config.js and host.js reject them).
function envFileContent(env) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join('');
}

// Starts a pod for the project containing `cwd` and resolves to the exit code of `command`.
//   mode           label value shown by `claude-pod ps` (shell | claude | exec | run)
//   usesClaude     warn when there's no login token
//   publishPorts   publish the config's ports on free loopback host ports
//   stdio          [stdin, stdout, stderr] for the docker client ('inherit' or fds)
//   stdinText      feed this text on the pod's stdin (via a private file, never argv)
export async function launch({ mode, command, cwd = process.cwd(), usesClaude, publishPorts, stdio = 'inherit', stdinText = null }) {
  const { root, configPath } = findProjectRoot(cwd);
  assertSafeRoot(root);
  const config = applyEnvOverrides(loadConfig({ root, configPath }));
  await ensureTrusted(root, config);

  preflight();
  assertNetwork(config.network);

  const stateDir = ensureProjectState(root);
  writeGitIdentity(stateDir);
  // Quarantine what earlier runs' pods planted if their launcher never got to (see protect.js),
  // before deciding what's protected: a leftover must not pass for a file of yours.
  sweepPending(root, containerExists);
  const { pinned, readOnly } = protectedMounts(root);

  const token = readToken();
  if (usesClaude && !token) warn(`No login token. Run ${bold('claude-pod auth')} first.`);

  let ports = [];
  if (publishPorts && config.ports.length) {
    if (config.network === 'none') warn('Network is "none": not publishing any ports.');
    else ports = await allocatePorts(config.ports);
  }

  const name = podName(root);
  ensurePrivateDir(runDir());
  const priv = path.join(runDir(), name);
  ensurePrivateDir(priv);

  const podEnv = { ...config.env, GIT_CONFIG_GLOBAL: '/home/claude-pod/.claude/gitconfig' };
  if (token) podEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
  const envFile = path.join(priv, 'env');
  writeFileAtomic(envFile, envFileContent(podEnv));

  let io = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
  if (stdinText !== null) {
    const promptFile = path.join(priv, 'stdin');
    writeFileAtomic(promptFile, stdinText);
    io[0] = fs.openSync(promptFile, 'r');
  }

  const [stdin, stdout] = io;
  const stdinTty = stdin === 'inherit' ? !!process.stdin.isTTY : false;
  const stdoutTty = stdout === 'inherit' ? !!process.stdout.isTTY : false;
  // -i whenever stdin carries something (a terminal or a prompt file); -t only for a real terminal
  // on both ends — passing -t with piped input makes docker fail.
  const interactive = stdinTty || (stdin !== 'inherit' && stdin !== 'ignore');
  const tty = stdinTty && stdoutTty;

  const realCwd = fs.realpathSync(cwd);
  const workdir = isInside(realCwd, root) ? realCwd : root;

  const args = buildRunArgs({
    name, mode, root, workdir, stateDir,
    uid: process.getuid(), gid: process.getgid(),
    interactive, tty, envFile,
    ports, network: config.network, pinned, readOnly, resources: config.resources,
    command,
  });

  info(`claude-pod ${name}`);
  detail(`project: ${clean(root)}${configPath ? '' : ' (no claude-pod.config.json)'}`);
  if (config.network) detail(`network: ${config.network}`);
  for (const { container, host } of ports) detail(`port ${container} → http://127.0.0.1:${host}`);

  const missingBefore = snapshotMissing(root);
  recordPending(root, name, missingBefore);
  const watchdog = spawn(process.execPath, [WATCHDOG, name, priv], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  watchdog.stdin.on('error', () => {});
  watchdog.stdin.unref?.();
  watchdog.unref();

  // Forward signals to the docker client, whose sig-proxy passes them to the pod, and keep running
  // until docker exits. Signals may target the launcher alone (an agent harness killing its
  // child), so relying on the terminal's process-group delivery isn't enough.
  let child;
  const onSignal = (sig) => child?.kill(sig);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);

  try {
    child = spawn('docker', args, { stdio: io, env: process.env });
    return await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] || 0)));
    });
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, onSignal);
    if (typeof io[0] === 'number' && stdinText !== null) fs.closeSync(io[0]);
    fs.rmSync(priv, { recursive: true, force: true });
    watchdog.stdin.end('done');
    quarantineCreated(root, missingBefore);
    clearPending(name);
  }
}
