import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from '../launch.js';
import { CliError } from '../ui.js';

export const RUN_HELP = `Usage: claude-pod run (--prompt-file FILE | --prompt TEXT) [options] [-- <extra claude args>]

Runs one headless Claude task in a fresh pod:
  claude --print --dangerously-skip-permissions --output-format <fmt> [--model M] [extra args]
The prompt is fed on stdin, so there's no need for "$(cat …)" in the calling command.

Options:
  --prompt-file FILE     read the prompt from FILE
  --prompt TEXT          use TEXT as the prompt (short prompts)
  --out BASE             write BASE.out (stdout), BASE.err (stderr) and BASE.exit (exit code)
                         instead of streaming; then prints "exit=<code>"
  --model M              opus | sonnet | haiku | a full model id
  --output-format F      text (default) | json | stream-json
  --ports                publish the config's ports (off by default for headless runs)

Exits with Claude's exit code.`;

export async function run(argv) {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const extra = sep === -1 ? [] : argv.slice(sep + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      'prompt-file': { type: 'string' },
      prompt: { type: 'string' },
      out: { type: 'string' },
      model: { type: 'string' },
      'output-format': { type: 'string', default: 'text' },
      ports: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${RUN_HELP}\n`);
    return 0;
  }
  if (positionals.length) {
    throw new CliError(`Unexpected argument "${positionals[0]}".`, { hint: 'Pass extra Claude arguments after "--".' });
  }
  if (!!values['prompt-file'] === !!values.prompt) throw new CliError('Pass exactly one of --prompt-file or --prompt.');

  let promptFd = null;
  if (values['prompt-file']) {
    const file = path.resolve(values['prompt-file']);
    try {
      if (fs.statSync(file).size === 0) throw new CliError(`Prompt file ${file} is empty.`);
      promptFd = fs.openSync(file, 'r');
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`Cannot read prompt file ${file}: ${e.code || e.message}`);
    }
  }

  const command = ['claude', '--print', '--dangerously-skip-permissions', '--output-format', values['output-format']];
  if (values.model) command.push('--model', values.model);
  command.push(...extra);
  if (values.prompt) command.push(values.prompt);

  const stdin = promptFd ?? 'ignore';
  const common = { mode: 'run', command, usesClaude: true, publishPorts: values.ports };

  if (!values.out) return launch({ ...common, stdio: [stdin, 'inherit', 'inherit'] });

  const base = path.resolve(values.out);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.rmSync(`${base}.exit`, { force: true }); // a leftover would look like this run already finished
  const outFd = fs.openSync(`${base}.out`, 'w');
  const errFd = fs.openSync(`${base}.err`, 'w');
  let code;
  try {
    code = await launch({ ...common, stdio: [stdin, outFd, errFd] });
  } catch (e) {
    // Record launcher failures where the caller will look for them.
    fs.writeSync(errFd, `claude-pod: ${e.message}\n${e.hint ? `${e.hint}\n` : ''}`);
    code = e.exitCode ?? 1;
    throw e;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    if (code !== undefined) fs.writeFileSync(`${base}.exit`, `${code}\n`);
  }
  process.stdout.write(`exit=${code}\n`);
  return code;
}
