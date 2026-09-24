// Terminal output helpers. Everything the launcher itself prints goes to stderr, so stdout stays
// reserved for whatever runs inside the pod (e.g. `claude --print` output an agent captures).

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const code = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));

export const bold = code(1);
export const dim = code(2);
const red = code(31);
const green = code(32);
const yellow = code(33);
const blue = code(34);

export const info = (msg) => process.stderr.write(`${blue('●')} ${bold(msg)}\n`);
export const ok = (msg) => process.stderr.write(`${green('✓')} ${msg}\n`);
export const warn = (msg) => process.stderr.write(`${yellow('!')} ${msg}\n`);
export const err = (msg) => process.stderr.write(`${red('✗')} ${msg}\n`);
export const detail = (msg) => process.stderr.write(`  ${dim(msg)}\n`);

// Escapes control characters (newlines, terminal escape codes, …) so text taken from files a pod
// can write — config keys, paths — prints as one visible line and can't fake extra output lines
// or hide itself from a human reading the terminal. `keep` lists characters to leave alone.
export function clean(text, keep = '') {
  return String(text).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (c) => (keep.includes(c) ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
}

// Thrown for expected, user-facing failures. The CLI entry point prints the message (no stack
// trace) and exits with `exitCode`.
export class CliError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(clean(message));
    this.exitCode = exitCode;
    this.hint = hint;
  }
}
