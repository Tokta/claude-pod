import fs from 'node:fs';
import path from 'node:path';
import { auth } from './commands/auth.js';
import { build } from './commands/build.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { ps, stop } from './commands/pods.js';
import { run } from './commands/run.js';
import { trustCommand } from './commands/trust.js';
import { uninstall } from './commands/uninstall.js';
import { launch } from './launch.js';
import { PKG_DIR } from './paths.js';
import { CliError, err } from './ui.js';

const HELP = `claude-pod — run Claude Code in a Docker sandbox scoped to one project folder.

Usage: claude-pod [command] [args]

Pod commands (mount the current project and start a container):
  (none) | shell          bash shell in the pod
  claude [args...]        Claude in the pod; args are passed through unchanged
  exec <cmd> [args...]    any command in the pod, e.g. exec pnpm test
  run --prompt-file F …   headless Claude task with --dangerously-skip-permissions
                          (see: claude-pod run --help)

Setup & management:
  build                   build the image (once, and to update Claude Code)
  auth                    store the login token from \`claude setup-token\`
  init                    create claude-pod.config.json for this project
  trust                   review and approve this project's (changed) config
  ps [--all]              list running pods
  stop [NAME...] [--all]  stop pods
  doctor                  check Docker, image, login and project config
  uninstall [--yes]       remove the image and pod state
  --version | --help

The project root is the nearest folder (upwards) with claude-pod.config.json, else the git root.
Pods get CLAUDE_POD=1 and, per published port, CLAUDE_POD_PORT_<n>.

Env overrides: NET=none (no network); PIDS, MEMORY, CPUS (resource caps).`;

const version = () => JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;

// Commands that open a pod. `shell`/`claude`/`exec` publish the config's ports (you're likely
// hitting a dev server); `run` doesn't by default (see run.js).
const pod = (mode, command, usesClaude) => launch({ mode, command, usesClaude, publishPorts: true });

const COMMANDS = {
  shell: () => pod('shell', ['bash'], false),
  claude: (args) => pod('claude', ['claude', ...args], true),
  exec: (args) => {
    if (!args.length) throw new CliError('Usage: claude-pod exec <command> [args...]');
    return pod('exec', args, false);
  },
  run,
  build,
  auth,
  init,
  trust: trustCommand,
  ps,
  stop,
  doctor,
  uninstall,
};

export async function main(argv) {
  const [cmd = 'shell', ...rest] = argv;
  try {
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
    if (!handler) throw new CliError(`Unknown command "${cmd}".`, { hint: 'Run claude-pod --help. To run a program in the pod: claude-pod exec <cmd>.' });
    if (cmd === 'shell' && rest.length) throw new CliError('shell takes no arguments; use claude-pod exec <cmd>.');
    return await handler(rest);
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message);
      if (e.hint) process.stderr.write(`  ${e.hint}\n`);
      return e.exitCode;
    }
    if (e?.code && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      err(e.message);
      return 2;
    }
    throw e;
  }
}
