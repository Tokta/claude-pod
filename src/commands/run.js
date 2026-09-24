import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findProjectRoot } from '../config.js';
import { allowedRunDirs } from '../host.js';
import { launch } from '../launch.js';
import { hostSettingsPath } from '../paths.js';
import { createExclusive, isInside, kind, readRegularFile, realpathLoose, writeFileAtomic } from '../safefs.js';
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

FILE and BASE must be in the system temp dir, /tmp, or a "runDirs" entry of
~/.config/claude-pod/settings.json; FILE may also be inside the project, BASE may not.
Exits with Claude's exit code.`;

const MAX_PROMPT = 5 * 1024 * 1024;

// --prompt-file: a regular file in an allowed dir (or the project, which the pod sees anyway).
function readPromptFile(file, root) {
  const real = realpathLoose(file);
  const dirs = allowedRunDirs();
  if (!dirs.some((d) => isInside(real, d)) && !isInside(real, root)) {
    throw new CliError(`--prompt-file ${file} is outside the allowed folders (${dirs.join(', ')} or the project).`, {
      hint: `Put the prompt in a temp/scratchpad dir, or add its folder to "runDirs" in ${hostSettingsPath()}.`,
    });
  }
  const bytes = readRegularFile(real, MAX_PROMPT);
  if (bytes === null) throw new CliError(`Cannot read prompt file ${file}: ENOENT`);
  if (!bytes.length) throw new CliError(`Prompt file ${file} is empty.`);
  return bytes.toString('utf8');
}

// --out BASE: in an allowed dir and never inside the project, where a pod could pre-plant
// symlinks at BASE.out/.err/.exit to make the host overwrite files of its choosing.
function checkOutBase(base, root) {
  const real = realpathLoose(base);
  const dirs = allowedRunDirs();
  if (isInside(real, root)) throw new CliError(`--out ${base} is inside the project, which the pod can write. Use a temp/scratchpad dir.`);
  if (!dirs.some((d) => isInside(real, d))) {
    throw new CliError(`--out ${base} is outside the allowed folders (${dirs.join(', ')}).`, {
      hint: `Use a temp/scratchpad dir, or add its folder to "runDirs" in ${hostSettingsPath()}.`,
    });
  }
  return real;
}

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
  if ((values['prompt-file'] === undefined) === (values.prompt === undefined)) throw new CliError('Pass exactly one of --prompt-file or --prompt.');

  const { root } = findProjectRoot();
  const prompt = values.prompt ?? readPromptFile(values['prompt-file'], root);
  if (!prompt.trim()) throw new CliError('The prompt is empty.');

  const command = ['claude', '--print', '--dangerously-skip-permissions', '--output-format', values['output-format']];
  if (values.model) command.push('--model', values.model);
  command.push(...extra);

  // The prompt always goes over stdin (from a private host-only file), never on the command line
  // where the host's process list would show it.
  const common = { mode: 'run', command, usesClaude: true, publishPorts: values.ports, stdinText: prompt };

  if (!values.out) return launch({ ...common, stdio: ['ignore', 'inherit', 'inherit'] });

  const base = checkOutBase(values.out, root);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  if (kind(`${base}.exit`) !== 'missing') fs.rmSync(`${base}.exit`, { force: true }); // stale = looks finished
  const outFd = createExclusive(`${base}.out`);
  const errFd = createExclusive(`${base}.err`);
  let code;
  try {
    code = await launch({ ...common, stdio: ['ignore', outFd, errFd] });
  } catch (e) {
    // Record launcher failures where the caller will look for them.
    fs.writeSync(errFd, `claude-pod: ${e.message}\n${e.hint ? `${e.hint}\n` : ''}`);
    code = e.exitCode ?? 1;
    throw e;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    if (code !== undefined) {
      writeFileAtomic(`${base}.exit`, `${code}\n`, 0o644);
      process.stdout.write(`exit=${code}\n`); // also when the launcher itself failed
    }
  }
  return code;
}
