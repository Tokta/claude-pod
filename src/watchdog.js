// Detached helper started by each launcher: if the launcher dies without cleaning up (SIGKILL, a
// crash, an orchestrator killing its process group), stop the pod, delete its private run files and
// quarantine anything it planted, so a "stopped" agent doesn't keep working in the background.
//
//   node watchdog.js <container-name> <private-run-dir>
//
// Liveness comes from a pipe, not a PID (which the OS may reuse): the launcher holds our stdin
// open, writes "done" when it exits cleanly, and the pipe closes however the launcher ends.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sweepRecord } from './protect.js';

const [name, dir] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exists = () => {
  const res = spawnSync('docker', ['ps', '-a', '-q', '--filter', `name=^${name}$`], { encoding: 'utf8' });
  return res.status !== 0 || res.stdout.trim() !== '';
};

let received = '';
process.stdin.on('data', (d) => {
  received += d;
});
process.stdin.on('error', () => {});
process.stdin.on('close', () => {
  if (received.includes('done')) process.exit(0);
  // Deleting the env-file first makes a `docker run` that hasn't read it yet fail to start.
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  spawnSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore' });
  // The docker client may still be creating the container: keep removing it until it's gone.
  for (let i = 0; i < 20 && exists(); i++) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    sleep(1000);
  }
  sweepRecord(name);
  process.exit(0);
});
