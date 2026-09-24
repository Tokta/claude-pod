import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot } from '../config.js';
import { docker } from '../docker.js';
import { CONFIG_FILE } from '../paths.js';
import { CliError, bold, detail, info, ok } from '../ui.js';

export const INIT_HELP = `Usage: claude-pod init

Creates ${CONFIG_FILE} at the project root (the git root, or the current folder).
Keys:
  network    Docker network to join, e.g. "<compose-project>_default", so the pod reaches
             services by name (postgres:5432)
  ports      container ports to publish on free 127.0.0.1 ports, e.g. [3000, 3131]
  envFile    .env-style file whose values can be used as \${VAR} in "env"
  env        extra environment for the pod, e.g. {"DATABASE_URL": "postgresql://u:\${PW}@postgres/db"}
  resources  {"pids": 4096, "memory": "4g", "cpus": 2}`;

// Docker Compose names a project's default network "<folder>_default" (lowercased, and stripped
// of characters it doesn't allow). Suggest it when it exists.
function detectComposeNetwork(root) {
  const guess = `${path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '')}_default`;
  try {
    return docker(['network', 'inspect', guess], { stdio: 'ignore' }).status === 0 ? guess : null;
  } catch {
    return null;
  }
}

export async function init(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${INIT_HELP}\n`);
    return 0;
  }
  const { root, configPath } = findProjectRoot();
  if (configPath) throw new CliError(`${configPath} already exists.`);
  assertSafeRoot(root);

  const config = { $comment: 'claude-pod project config — run `claude-pod init --help` for the keys.' };
  const network = detectComposeNetwork(root);
  if (network) config.network = network;
  config.ports = [];
  if (fs.existsSync(path.join(root, '.env'))) config.envFile = '.env';
  config.env = {};

  const file = path.join(root, CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  ok(`Created ${bold(file)}`);
  if (network) detail(`detected Docker network: ${network}`);

  info('Next steps');
  process.stderr.write(`  1. Fill in ports/env in ${CONFIG_FILE} (see ${bold('claude-pod init --help')}).\n`);
  process.stderr.write(`  2. Let agents launch pods without prompts — add to .claude/settings.json:\n`);
  process.stderr.write(`       "permissions": { "allow": ["Bash(claude-pod run:*)"] }\n`);
  process.stderr.write(`  3. Headless runs: ${bold('claude-pod run --prompt-file task.md --out /tmp/task')}\n`);
  return 0;
}
