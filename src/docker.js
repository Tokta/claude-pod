import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IMAGE, LABEL, LABEL_DOCKERFILE, LABEL_MODE, LABEL_PROJECT, PKG_DIR, dockerBin } from './paths.js';
import { CliError, bold, warn } from './ui.js';

// Runs docker and captures its output (for probes, not for the pod itself).
export function docker(args, opts = {}) {
  const res = spawnSync(dockerBin(), args, { encoding: 'utf8', ...opts });
  if (res.error?.code === 'ENOENT') throw new CliError('Docker is required but not on PATH.');
  if (res.error) throw res.error;
  return res;
}

export function dockerfileHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(PKG_DIR, 'Dockerfile'))).digest('hex');
}

// Probes with `image ls -q`, not `image inspect <name>`: it resolves the name the same way
// `docker run` does, and some Docker Desktop builds have a broken `image inspect <name>` that
// false-negatives on a present image. Inspecting by ID afterwards is unaffected.
export function imageStatus() {
  const id = docker(['image', 'ls', '-q', IMAGE]).stdout.trim().split('\n')[0];
  if (!id) return { exists: false, stale: false };
  const res = docker(['image', 'inspect', '--format', `{{index .Config.Labels "${LABEL_DOCKERFILE}"}}`, id]);
  const built = res.status === 0 ? res.stdout.trim() : '';
  return { exists: true, stale: built !== dockerfileHash(), id };
}

// Checked in causal order, so a stopped daemon isn't misreported as a missing image.
export function preflight() {
  if (docker(['info'], { stdio: 'ignore' }).status !== 0) throw new CliError('Docker daemon is not running.');
  const img = imageStatus();
  if (!img.exists) {
    throw new CliError(`Image '${IMAGE}' not found.`, { hint: `Build it once with ${bold('claude-pod build')}.` });
  }
  if (img.stale) warn(`Image '${IMAGE}' was built from a different Dockerfile. Rebuild with ${bold('claude-pod build')}.`);
}

export function assertNetwork(network) {
  if (!network || network === 'none') return;
  if (docker(['network', 'inspect', network], { stdio: 'ignore' }).status !== 0) {
    throw new CliError(`Docker network '${network}' not found.`, {
      hint: "Start your app's stack first (e.g. docker compose up -d).",
    });
  }
}

// Builds the full `docker run` argument list. Pure, so the security-relevant flags are unit-tested.
//
//   --user uid:gid                  run as the host user, so files the pod writes are yours.
//   HOME=/home/claude-pod           a writable home for that (nameless) user, baked into the image.
//   <root> -> <root>                project at its real path: logs and stack traces read the same
//                                   on host and pod.
//   <podDir> -> ~/.claude           credentials, sessions, history.
//   <podDir>/.claude.json -> ~/     account binding + onboarding/trust state (sibling file).
//   --cap-drop=ALL                  an unprivileged dev shell needs no Linux capabilities.
//   no-new-privileges               setuid binaries in the image can't elevate.
//   --pids-limit                    caps fork bombs; memory/cpus are opt-in.
//   --init                          a tiny init as PID 1: forwards signals (a bare PID 1 ignores
//                                   SIGTERM, so stopping the launcher left the pod running) and
//                                   reaps zombie processes from dev servers and test runners.
//
// `env` values are passed as bare `-e KEY` and supplied through the docker CLI's own environment
// (see launch.js), so secrets never appear in the host's process list.
export function buildRunArgs({
  name, mode, root, workdir, podDir, uid, gid, interactive, tty,
  ports = [], network = null, env = {}, resources = {}, command = [],
}) {
  const args = ['run', '--rm', '--init', '--name', name];
  if (interactive) args.push('-i');
  if (tty) args.push('-t');
  args.push('--label', `${LABEL}=1`, '--label', `${LABEL_PROJECT}=${root}`, '--label', `${LABEL_MODE}=${mode}`);

  for (const { host, container } of ports) args.push('-p', `127.0.0.1:${host}:${container}`);
  if (network) args.push(`--network=${network}`);

  args.push(`--pids-limit=${resources.pids ?? 4096}`);
  if (resources.memory !== undefined) args.push(`--memory=${resources.memory}`);
  if (resources.cpus !== undefined) args.push(`--cpus=${resources.cpus}`);

  args.push(
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user', `${uid}:${gid}`,
    '-e', 'HOME=/home/claude-pod',
    '-e', 'CLAUDE_POD=1',
    '-e', `CLAUDE_POD_NAME=${name}`,
  );
  for (const { host, container } of ports) args.push('-e', `CLAUDE_POD_PORT_${container}=${host}`);
  for (const key of Object.keys(env)) args.push('-e', key);

  args.push(
    '-v', `${root}:${root}`,
    '-w', workdir,
    '-v', `${podDir}:/home/claude-pod/.claude`,
    '-v', `${path.join(podDir, '.claude.json')}:/home/claude-pod/.claude.json`,
    IMAGE,
    ...command,
  );
  return args;
}
