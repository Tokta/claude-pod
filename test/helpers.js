// Shared test setup: a throwaway HOME (all claude-pod state derives from it), a git project inside
// it, and a fake `docker` first on PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.join(here, '..', 'bin', 'claude-pod.js');
const FAKE = path.join(here, 'fixtures', 'fake-docker.js');

export const tmp = (prefix = 'claude-pod-test-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export function sandbox() {
  const dir = tmp();
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'work', 'app');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(project, '.git', 'config'), '[core]\n');
  fs.mkdirSync(bin);
  fs.symlinkSync(FAKE, path.join(bin, 'docker'));
  const hostDir = path.join(home, '.config', 'claude-pod');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'image-id'), 'sha256:fake\n');
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_LOG: path.join(dir, 'docker.log'),
    NO_COLOR: '1',
  };
  const runs = () => (fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { dir, home, hostDir, project, env, runs };
}

export function cli(args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Trust the project's current config the way `claude-pod trust` would, under the sandbox HOME.
export async function trustConfig(s) {
  const prev = process.env.HOME;
  process.env.HOME = s.home;
  try {
    const c = await import('../src/config.js');
    const found = c.findProjectRoot(s.project);
    c.trust(found.root, c.loadConfig(found).hash);
  } finally {
    process.env.HOME = prev;
  }
}
