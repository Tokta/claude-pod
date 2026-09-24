// Project files that don't stay inside the pod: things that later EXECUTE on the host, or that
// configure the Claude session orchestrating pods from the host. A pod may write the whole project,
// so without this, one hostile run could plant e.g. a git hook that runs on your next `git push`.
//
//   - Existing ones are bind-mounted read-only over the project mount.
//   - `.claude/` and `.git/hooks/` are created empty first when missing, so they can be locked too.
//   - Others can't be pre-created without side effects (an empty .mcp.json breaks Claude), so if a
//     pod creates one it is renamed to `<name>.claude-pod-quarantine-<timestamp>` after the run.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, kind } from './safefs.js';
import { CliError, warn } from './ui.js';

const LOCKED = [
  { rel: '.git/hooks', type: 'dir', create: true }, // run by git on the host (commit, push, …)
  { rel: '.git/config', type: 'file' }, // core.fsmonitor, core.hooksPath, filters, aliases, sshCommand
  { rel: '.claude', type: 'dir', create: true }, // settings/hooks/agents loaded by host Claude
  { rel: '.mcp.json', type: 'file' }, // MCP servers started by host Claude
  { rel: '.envrc', type: 'file' }, // direnv runs it on `cd`
  { rel: '.vscode', type: 'dir' }, // tasks/settings run by the editor
  { rel: '.idea', type: 'dir' },
];

// Created by a pod where none existed → quarantined after the run. `.git/commondir` makes git read
// its config and hooks from another folder; normal repositories never have one.
const WATCHED = ['.mcp.json', '.envrc', '.vscode', '.idea', '.git', '.git/commondir'];

// Returns { pinned, readOnly } mounts for `root`. `pinned` are read-write self-mounts that make a
// directory a mount point, so the pod can't rename it away and put a fresh one (with its own
// hooks) in its place. Refuses when a protected path is a symlink or resolves outside the project:
// a pod may have planted it to get a host file mounted into the next pod.
export function protectedMounts(root) {
  const gitIsDir = kind(path.join(root, '.git')) === 'dir';
  if (gitIsDir && kind(path.join(root, '.git', 'commondir')) !== 'missing') {
    throw new CliError(`${path.join(root, '.git', 'commondir')} exists, which redirects git's config and hooks. Refusing to start a pod.`, {
      hint: 'A previous pod may have planted it. Inspect it, remove it, and relaunch.',
    });
  }
  const pinned = gitIsDir ? [path.join(root, '.git')] : [];
  const mounts = [];
  for (const { rel, type, create } of LOCKED) {
    if (rel.startsWith('.git/') && !gitIsDir) continue; // worktree/submodule: the real .git dir isn't mounted
    const p = path.join(root, rel);
    let k = kind(p);
    if (k === 'missing' && create) {
      fs.mkdirSync(p, { recursive: true });
      k = kind(p);
    }
    if (k === 'missing') continue;
    if (k !== type || !isInside(fs.realpathSync(p), root)) {
      throw new CliError(`${p} is a ${k === type ? 'path outside the project' : k}, not a ${type}. Refusing to start a pod.`, {
        hint: 'A previous pod may have planted it. Inspect it, remove it, and relaunch.',
      });
    }
    mounts.push(p);
  }
  return { pinned, readOnly: mounts };
}

export function snapshotMissing(root) {
  return WATCHED.filter((rel) => kind(path.join(root, rel)) === 'missing');
}

// After a run: rename protected paths the pod created. rename() moves a symlink itself, never its
// target. Returns the list of quarantined paths.
export function quarantineCreated(root, missingBefore) {
  const moved = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const rel of missingBefore) {
    const p = path.join(root, rel);
    if (kind(p) === 'missing') continue;
    const dest = `${p}.claude-pod-quarantine-${stamp}`;
    try {
      fs.renameSync(p, dest);
      moved.push(dest);
      warn(`The pod created ${rel}, which would run on your host. Quarantined as ${path.basename(dest)} — review it before restoring.`);
    } catch (e) {
      warn(`The pod created ${rel}, which would run on your host, and it could not be quarantined (${e.code}). Review it now.`);
    }
  }
  return moved;
}
