import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { docker } from '../docker.js';
import { IMAGE, hostDir, stateRoot } from '../paths.js';
import { CliError, bold, detail, info, ok } from '../ui.js';

export const UNINSTALL_HELP = `Usage: claude-pod uninstall [--yes]

Removes the '${IMAGE}' image, the pods' state (~/.claude-pod: session history) and the host-only
state (~/.config/claude-pod: login token, trusted configs).
Does not remove the claude-pod command itself: run \`npm uninstall -g claude-pod\` for that.`;

export async function uninstall(argv) {
  const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${UNINSTALL_HELP}\n`);
    return 0;
  }
  const dirs = [stateRoot(), hostDir()];
  info('Will remove');
  detail(`image: ${IMAGE}`);
  detail(`dir:   ${dirs[0]} (pod session history)`);
  detail(`dir:   ${dirs[1]} (login token, trusted configs)`);

  if (!values.yes) {
    if (!process.stdin.isTTY) throw new CliError('Refusing to uninstall without confirmation.', { hint: 'Pass --yes.' });
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const reply = await rl.question('Proceed? [y/N] ');
    rl.close();
    if (!/^y$/i.test(reply.trim())) {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }

  if (docker(['image', 'ls', '-q', IMAGE]).stdout.trim()) {
    const res = docker(['rmi', '-f', IMAGE]);
    if (res.status !== 0) throw new CliError(`docker rmi failed: ${res.stderr.trim()}`);
    ok(`Removed image '${IMAGE}'`);
  } else {
    ok(`Image '${IMAGE}' was not present`);
  }
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      ok(`Removed ${dir}`);
    } else {
      ok(`${dir} was not present`);
    }
  }
  process.stderr.write(`  To remove the command too: ${bold('npm uninstall -g claude-pod')}\n`);
  return 0;
}
