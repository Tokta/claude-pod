// Filesystem helpers for touching paths a pod may have tampered with. The rules:
//   - never follow a symlink we didn't create (lstat, O_EXCL creates),
//   - replace files by rename (which swaps a planted symlink instead of writing through it),
//   - decide "inside a folder" on real paths, after resolving every symlink.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './ui.js';

// 'missing' | 'file' | 'dir' | 'symlink' | 'other' — without following a final symlink.
export function kind(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing';
    throw e;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// realpath of `p`, or of its nearest existing ancestor joined with the missing tail.
export function realpathLoose(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Creates `dir` (and parents) owner-only, and refuses if it is, or has been swapped for, anything
// but a real directory.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (kind(dir) !== 'dir') throw new CliError(`${dir} is not a real directory (symlink?). Refusing to use it.`);
  fs.chmodSync(dir, 0o700);
}

// Writes `content` to `file` atomically with mode 0600: exclusive-create a random temp name next
// to it (never follows a pre-planted symlink), then rename over the target.
export function writeFileAtomic(file, content, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Opens `file` for writing as a brand-new file: removes whatever is there (a symlink is removed
// itself, not its target), then exclusive-creates. Returns the fd.
export function createExclusive(file, mode = 0o600) {
  if (kind(file) !== 'missing') fs.rmSync(file, { force: true });
  return fs.openSync(file, 'wx', mode);
}

// Reads a small regular file, refusing symlinks and anything oversized.
export function readRegularFile(file, maxBytes = 1024 * 1024) {
  const k = kind(file);
  if (k === 'missing') return null;
  if (k !== 'file') throw new CliError(`${file} is a ${k}, not a regular file. Refusing to read it.`);
  const size = fs.statSync(file).size;
  if (size > maxBytes) throw new CliError(`${file} is too large (${size} bytes).`);
  return fs.readFileSync(file);
}
