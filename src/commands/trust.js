import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig, trust as recordTrust } from '../config.js';
import { canPrompt, confirm } from '../prompt.js';
import { CliError, bold, clean, ok, warn } from '../ui.js';

export const TRUST_HELP = `Usage: claude-pod trust

Shows this project's claude-pod.config.json and asks you to approve it. Pods can edit the
project, including this file, so a config is only used once you've approved its exact content;
unattended runs refuse a new or changed one. Needs a terminal (there is deliberately no --yes).`;

export async function trustCommand(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${TRUST_HELP}\n`);
    return 0;
  }
  const found = findProjectRoot();
  if (!found.configPath) throw new CliError('No claude-pod.config.json in this project.', { hint: `Create one with ${bold('claude-pod init')}.` });
  assertSafeRoot(found.root);
  const config = loadConfig(found); // validates before we ask
  if (isTrusted(found.root, config.hash)) {
    ok(`${config.file} is already trusted.`);
    return 0;
  }
  if (!canPrompt()) throw new CliError('claude-pod trust needs a terminal.');
  warn(`Review ${config.file} (a pod can edit this file):`);
  process.stderr.write(`\n${clean(config.text.trimEnd(), '\n\t')}\n\n`);
  if (!(await confirm('Trust this config for this project?'))) throw new CliError('Not trusted.');
  recordTrust(found.root, config.hash);
  ok('Trusted.');
  return 0;
}
