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

let received = '';
process.stdin.on('data', (d) => {
  received += d;
});
process.stdin.on('error', () => {});
process.stdin.on('close', () => {
  if (received.includes('done')) process.exit(0);
  spawnSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore' });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  sweepRecord(name);
  process.exit(0);
});
