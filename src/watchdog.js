// Detached helper started by each launcher: if the launcher dies without cleaning up (SIGKILL, an
// orchestrator killing its process group), stop the pod and delete its private run files, so a
// "stopped" agent doesn't keep working in the background.
//
//   node watchdog.js <launcher-pid> <container-name> <private-run-dir>
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [pidArg, name, dir] = process.argv.slice(2);
const pid = Number(pidArg);

const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  spawnSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore' });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}, 1000);

// The launcher sends SIGTERM when it exits normally.
process.on('SIGTERM', () => process.exit(0));
