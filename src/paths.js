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

// Host-side state dir: Claude's credentials, sessions and history, persisted across pods.
// CLAUDE_POD_HOME overrides it (used by the test suite; also handy for a second identity).
export function podDir() {
  return process.env.CLAUDE_POD_HOME || path.join(os.homedir(), '.claude-pod');
}

export const credentialsPath = () => path.join(podDir(), '.credentials.json');
export const claudeJsonPath = () => path.join(podDir(), '.claude.json');
export const refreshLockPath = () => path.join(podDir(), 'refresh.lock');

// The docker binary. CLAUDE_POD_DOCKER overrides it so tests can substitute a fake.
export const dockerBin = () => process.env.CLAUDE_POD_DOCKER || 'docker';
