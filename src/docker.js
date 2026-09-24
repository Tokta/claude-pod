import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  IMAGE, LABEL, LABEL_DOCKERFILE, LABEL_MODE, LABEL_PROJECT, PKG_DIR, POD_CONFIG_DIR, imageIdPath, sha256,
} from './paths.js';
import { readRegularFile } from './safefs.js';
import { CliError, bold, warn } from './ui.js';

// Runs docker and captures its output (for probes, not for the pod itself). The docker client
// always runs with the host's own environment: nothing from a project config ever reaches it.
export function docker(args, opts = {}) {
  const res = spawnSync('docker', args, { encoding: 'utf8', ...opts, env: process.env });
  if (res.error?.code === 'ENOENT') throw new CliError('Docker is required but not on PATH.');
  if (res.error) throw res.error;
  return res;
}

export const dockerfileHash = () => sha256(fs.readFileSync(path.join(PKG_DIR, 'Dockerfile')));

// Full image ID via `image ls` (not `image inspect <name>`, which some Docker Desktop builds
// false-negative on). Empty string when absent.
export function imageId() {
  return docker(['image', 'ls', '-q', '--no-trunc', IMAGE]).stdout.trim().split('\n')[0] || '';
}

export function recordedImageId() {
  try {
    return readRegularFile(imageIdPath())?.toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

export function imageStatus() {
  const id = imageId();
  if (!id) return { exists: false };
  const res = docker(['image', 'inspect', '--format', `{{index .Config.Labels "${LABEL_DOCKERFILE}"}}`, id]);
  const built = res.status === 0 ? res.stdout.trim() : '';
  const recorded = recordedImageId();
  return { exists: true, id, stale: built !== dockerfileHash(), recorded, replaced: !!recorded && recorded !== id };
}

// Checked in causal order, so a stopped daemon isn't misreported as a missing image.
export function preflight() {
  if (docker(['info'], { stdio: 'ignore' }).status !== 0) throw new CliError('Docker daemon is not running.');
  const img = imageStatus();
  if (!img.exists) throw new CliError(`Image '${IMAGE}' not found.`, { hint: `Build it once with ${bold('claude-pod build')}.` });
  // The image tag is global: anything that can talk to the Docker daemon could retag it. We only
  // run the exact image `claude-pod build` produced.
  if (img.replaced) {
    throw new CliError(`Image '${IMAGE}' is not the one claude-pod built (${img.id.slice(7, 19)} ≠ ${img.recorded.slice(7, 19)}).`, {
      hint: `If you rebuilt it yourself, run ${bold('claude-pod build')} to rebuild and re-record it.`,
    });
  }
  if (!img.recorded) warn(`Image '${IMAGE}' was not built by this version of claude-pod. Run ${bold('claude-pod build')}.`);
  else if (img.stale) warn(`Image '${IMAGE}' was built from a different Dockerfile. Rebuild with ${bold('claude-pod build')}.`);
}

// Only `none` and bridge-driver networks: `host`, macvlan/ipvlan and the like would put the pod on
// the host's (or the LAN's) network, where it can reach services bound to your localhost.
export function assertNetwork(network) {
  if (!network || network === 'none') return;
  const res = docker(['network', 'inspect', '--format', '{{.Driver}}', network]);
  if (res.status !== 0) {
    throw new CliError(`Docker network '${network}' not found.`, { hint: "Start your app's stack first (e.g. docker compose up -d)." });
  }
  const driver = res.stdout.trim();
  if (driver !== 'bridge') throw new CliError(`Docker network '${network}' uses the '${driver}' driver; only bridge networks are allowed.`);
}

// Builds the full `docker run` argument list. Pure, so the security-relevant flags are unit-tested.
//
//   --user uid:gid                  run as the host user, so files the pod writes are yours.
//   HOME=/home/claude-pod           a writable (ephemeral) home for that nameless user.
//   <root> -> <root>                project at its real path: logs and stack traces read the same.
//   <pinned…> -> same               .git as its own mount point, so it can't be swapped out.
//   <readOnly…> -> same, :ro        project files that run on the host (see protect.js).
//   <stateDir> -> ~/.claude         this project's Claude state; also CLAUDE_CONFIG_DIR, so
//                                   .claude.json lives there and no single-file mount is needed.
//   --env-file                      config env + login token, from a private host-only file: never
//                                   on the command line, never in the docker client's environment.
//   --cap-drop=ALL                  an unprivileged dev shell needs no Linux capabilities.
//   no-new-privileges               setuid binaries in the image can't elevate.
//   --pids-limit                    caps fork bombs; memory/cpus are opt-in.
//   --init                          a tiny init as PID 1: forwards signals (a bare PID 1 ignores
//                                   SIGTERM) and reaps zombie processes.
export function buildRunArgs({
  name, mode, root, workdir, stateDir, uid, gid, interactive, tty, envFile = null,
  ports = [], network = null, pinned = [], readOnly = [], resources = {}, command = [],
}) {
  // `-v src:dst[:ro]` splits on colons, so a path containing one (a folder a pod created, say)
  // could change what gets mounted where.
  for (const p of [root, workdir, stateDir, ...pinned, ...readOnly]) {
    if (/[:\n\r\0]/.test(p)) throw new CliError(`Path ${JSON.stringify(p)} contains a colon or control character; claude-pod can't mount it safely.`);
  }
  const args = ['run', '--rm', '--init', '--stop-timeout=10', '--name', name];
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
    '-e', `CLAUDE_CONFIG_DIR=${POD_CONFIG_DIR}`,
    '-e', 'CLAUDE_POD=1',
    '-e', `CLAUDE_POD_NAME=${name}`,
  );
  for (const { host, container } of ports) args.push('-e', `CLAUDE_POD_PORT_${container}=${host}`);
  if (envFile) args.push('--env-file', envFile);

  args.push('-v', `${root}:${root}`);
  for (const p of pinned) args.push('-v', `${p}:${p}`);
  for (const p of readOnly) args.push('-v', `${p}:${p}:ro`);
  args.push('-w', workdir, '-v', `${stateDir}:${POD_CONFIG_DIR}`, IMAGE, ...command);
  return args;
}
