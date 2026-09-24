import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root of this package (where the Dockerfile lives), resolved through the npm global symlink.
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const IMAGE = 'claude-pod';
export const CONFIG_FILE = 'claude-pod.config.json';

// Container label keys, used by `ps`/`stop` to find pods and by the image staleness check.
export const LABEL = 'claude-pod';
export const LABEL_PROJECT = 'claude-pod.project';
export const LABEL_MODE = 'claude-pod.mode';
export const LABEL_DOCKERFILE = 'claude-pod.dockerfile-sha256';

// Two state locations, split by who can write them:
//
//   ~/.config/claude-pod/   HOST-ONLY. Never mounted into any pod. Holds everything the launcher
//                           trusts: the login token, approved-config records, the built image ID,
//                           host settings, and short-lived private files (env-files, prompts).
//   ~/.claude-pod/pods/<p>/ POD-WRITABLE. One Claude config dir per project, mounted into that
//                           project's pods only. The launcher never trusts anything read from it.
//
// Both derive from os.homedir() only — no env-var overrides that a caller could use to redirect
// the launcher (tests set HOME).
export const hostDir = () => path.join(os.homedir(), '.config', 'claude-pod');
export const tokenPath = () => path.join(hostDir(), 'oauth-token');
export const trustDir = () => path.join(hostDir(), 'trust');
export const imageIdPath = () => path.join(hostDir(), 'image-id');
export const hostSettingsPath = () => path.join(hostDir(), 'settings.json');
export const runDir = () => path.join(hostDir(), 'run');

export const stateRoot = () => path.join(os.homedir(), '.claude-pod');
export const podsDir = () => path.join(stateRoot(), 'pods');

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Per-project pod state dir name: readable slug + hash of the real project path.
export function projectStateDir(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 30) || 'project';
  return path.join(podsDir(), `${slug}-${sha256(root).slice(0, 12)}`);
}

// Where the per-project state dir is mounted inside the pod; also CLAUDE_CONFIG_DIR, so Claude
// keeps .claude.json there too and no single-file mount is needed.
export const POD_CONFIG_DIR = '/home/claude-pod/.claude';
