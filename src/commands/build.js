import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { docker, dockerfileHash } from '../docker.js';
import { IMAGE, LABEL_DOCKERFILE, PKG_DIR, dockerBin } from '../paths.js';
import { CliError, bold, detail, info, ok } from '../ui.js';

export const BUILD_HELP = `Usage: claude-pod build [--claude-version X.Y.Z]

Builds (or rebuilds) the local '${IMAGE}' image: Node + git + gh + jq + pnpm + Claude Code.
Re-run it to pick up a new Claude Code release.

Options:
  --claude-version V   pin a Claude Code version (default: latest, or $CLAUDE_CODE_VERSION)`;

export async function build(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'claude-version': { type: 'string', default: process.env.CLAUDE_CODE_VERSION || 'latest' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${BUILD_HELP}\n`);
    return 0;
  }
  if (docker(['info'], { stdio: 'ignore' }).status !== 0) throw new CliError('Docker daemon is not running.');

  const version = values['claude-version'];
  // A pinned version literal is its own cache key. "latest" never changes, so bust the cache to
  // force a fresh npm fetch.
  const args = ['build', '--progress=plain', '--build-arg', `CLAUDE_CODE_VERSION=${version}`];
  if (version === 'latest') args.push('--build-arg', `CACHEBUST=${Date.now()}`);
  // The Dockerfile hash label lets every launch warn when the image predates the current Dockerfile.
  args.push('--label', `${LABEL_DOCKERFILE}=${dockerfileHash()}`, '-t', IMAGE, PKG_DIR);

  info(`Building image '${IMAGE}' (claude-code ${version})`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(dockerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Dim + indent the build log; strip docker's own ANSI codes so they don't fight the dimming.
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => detail(line.replace(/\x1b\[[0-9;]*m/g, '')));
    }
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new CliError(`docker build failed (exit ${code}).`);
  ok(`Image '${IMAGE}' built`);

  const v = docker(['run', '--rm', IMAGE, 'claude', '--version']);
  if (v.status === 0) detail(`claude-code: ${v.stdout.trim()}`);

  info('Next steps');
  process.stderr.write(`  ${bold('claude-pod auth')}      copy your host login into the pod (once)\n`);
  process.stderr.write(`  ${bold('claude-pod init')}      add a claude-pod.config.json to a project (optional)\n`);
  process.stderr.write(`  ${bold('claude-pod')}           shell in the pod for the current project\n`);
  return 0;
}
