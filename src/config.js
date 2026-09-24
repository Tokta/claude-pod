import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, sha256, trustDir } from './paths.js';
import { parseDotenv } from './dotenv.js';
import { ensurePrivateDir, isInside, kind, readRegularFile, writeFileAtomic } from './safefs.js';
import { CliError } from './ui.js';

// SECURITY: claude-pod.config.json lives in the project, which every pod can write. So a config
// is only honoured once you have approved its exact bytes (see isTrusted), and even then it is
// validated to keep the pod's isolation intact: bridge-type networks only, an envFile inside the
// project, no host environment variables, no reserved env names.

// Walks up from `start` looking for a directory that satisfies `test`. Returns it, or null.
function findUp(start, test) {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolves which folder gets mounted into the pod. Agents launch from the project root, from a
// subfolder, after a `cd`, or not — so we never trust the cwd alone:
//   1. the nearest ancestor with a claude-pod.config.json (explicit opt-in wins),
//   2. else the nearest git root (`.git` dir, or file for worktrees/submodules),
//   3. else the cwd itself (rejected later by assertSafeRoot unless it's a project).
export function findProjectRoot(cwd = process.cwd()) {
  const real = fs.realpathSync(cwd);
  const withConfig = findUp(real, (d) => kind(path.join(d, CONFIG_FILE)) !== 'missing');
  if (withConfig) return { root: withConfig, configPath: path.join(withConfig, CONFIG_FILE) };
  const gitRoot = findUp(real, (d) => kind(path.join(d, '.git')) !== 'missing');
  return { root: gitRoot || real, configPath: null };
}

// Folders whose presence means "this is a home directory, not a project".
const HOME_MARKERS = ['.ssh', '.aws', '.gnupg'];

// Refuses to mount anything that would hand the pod more than one project: /, your home, any
// ancestor of your home, a home-like folder, or a folder that isn't a project at all (no .git
// and no claude-pod.config.json — e.g. ~/Documents holding many projects).
export function assertSafeRoot(root, { requireProject = true } = {}) {
  const real = fs.realpathSync(root);
  const home = fs.realpathSync(os.homedir());
  const refuse = (why) => new CliError(`Refusing to mount ${real} into the pod: ${why}.`, {
    hint: 'cd into a project folder first (a git repo, or run `claude-pod init` in it).',
  });
  if (real === path.parse(real).root) throw refuse('it is the filesystem root');
  if (isInside(home, real)) throw refuse(real === home ? 'it is your home directory' : 'it contains your home directory');
  const marker = HOME_MARKERS.find((m) => kind(path.join(real, m)) !== 'missing');
  if (marker) throw refuse(`it contains ${marker}, so it looks like a home directory`);
  if (requireProject && kind(path.join(real, '.git')) === 'missing' && kind(path.join(real, CONFIG_FILE)) === 'missing') {
    throw refuse('it is not a git repository and has no claude-pod.config.json');
  }
}

const KNOWN_KEYS = new Set(['network', 'ports', 'envFile', 'env', 'resources']);

// Env names the launcher sets itself, or that would change how Claude authenticates/stores state.
const RESERVED_ENV = /^(HOME|CLAUDE_POD(_.*)?|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_.*)$/;

// Docker network names; excludes `host`, `container:<id>` and anything else with special meaning.
// The driver is checked against Docker at launch (assertNetwork).
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const MEMORY_RE = /^[1-9][0-9]*(\.[0-9]+)?[bkmg]?$/i;
export const CPUS_RE = /^(0?\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$/;

export function validateResources(r, where) {
  const bad = (msg) => new CliError(`${where}: ${msg}`);
  if (r.pids !== undefined && !(Number.isInteger(Number(r.pids)) && Number(r.pids) >= 16)) {
    throw bad('pids must be an integer ≥ 16.');
  }
  if (r.memory !== undefined && !MEMORY_RE.test(String(r.memory))) {
    throw bad('memory must look like 512m, 4g or a byte count (not 0).');
  }
  if (r.cpus !== undefined && !CPUS_RE.test(String(r.cpus))) throw bad('cpus must be a positive number, e.g. 2 or 0.5.');
}

function validate(raw, file) {
  const bad = (msg) => new CliError(`${file}: ${msg}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be a JSON object.');
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('$')) throw bad(`unknown key "${key}".`);
  }
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'string' || !NETWORK_NAME.test(raw.network) || raw.network === 'host') {
      throw bad('"network" must be "none" or the name of a bridge network (not "host" or "container:…").');
    }
  }
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) throw bad('"ports" must be an array of container port numbers.');
    for (const p of raw.ports) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad(`"ports" entry ${JSON.stringify(p)} is not a port number (1-65535).`);
    }
    if (new Set(raw.ports).size !== raw.ports.length) throw bad('"ports" has duplicates.');
  }
  if (raw.envFile !== undefined && (typeof raw.envFile !== 'string' || !raw.envFile || path.isAbsolute(raw.envFile))) {
    throw bad('"envFile" must be a path relative to the project.');
  }
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw bad('"env" must be an object.');
    for (const [k, v] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad(`"env" key "${k}" is not a valid variable name.`);
      if (RESERVED_ENV.test(k)) throw bad(`"env.${k}" is reserved by claude-pod.`);
      if (typeof v !== 'string') throw bad(`"env.${k}" must be a string.`);
    }
  }
  if (raw.resources !== undefined) {
    const r = raw.resources;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw bad('"resources" must be an object.');
    for (const key of Object.keys(r)) {
      if (!['pids', 'memory', 'cpus'].includes(key)) throw bad(`unknown "resources" key "${key}".`);
    }
    validateResources(r, `${file} "resources"`);
  }
  return raw;
}

// Replaces ${VAR} with a value from `vars` (the envFile only — never the host environment, which
// would let a pod-written config pull host secrets into the next pod); `$$` is a literal `$`.
// Unknown variables are an error, so a missing secret fails here instead of as a DB error.
export function interpolate(template, vars, where) {
  const out = template.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (match === '$$') return '$';
    if (!Object.hasOwn(vars, name)) throw new CliError(`${where} references \${${name}}, which is not set in the envFile.`);
    return vars[name];
  });
  if (/[\n\r\0]/.test(out)) throw new CliError(`${where} contains a newline or NUL, which can't be passed to the pod.`);
  return out;
}

// Reads the envFile, which must resolve (after symlinks) to a regular file inside the project.
function readEnvFile(root, rel) {
  const envPath = path.resolve(root, rel);
  if (kind(envPath) === 'missing') {
    throw new CliError(`envFile ${envPath} not found.`, { hint: 'Create it (e.g. from .env.example) or remove "envFile" from the config.' });
  }
  const real = fs.realpathSync(envPath);
  if (!isInside(real, root)) throw new CliError(`envFile ${rel} resolves outside the project (${real}). Refusing to read it.`);
  return parseDotenv(readRegularFile(real).toString('utf8'));
}

// Loads and resolves the project's config. With no config file, returns the empty defaults.
// `hash` is the sha256 of the exact bytes, for the trust check.
export function loadConfig({ root, configPath }) {
  const empty = { network: null, ports: [], env: {}, resources: {}, file: null, hash: null, text: null };
  if (!configPath) return empty;

  let bytes;
  let raw;
  try {
    bytes = readRegularFile(configPath, 64 * 1024);
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`Could not read ${configPath}: ${e.message}`);
  }
  validate(raw, CONFIG_FILE);

  const vars = raw.envFile ? readEnvFile(root, raw.envFile) : {};
  const env = {};
  for (const [k, v] of Object.entries(raw.env || {})) env[k] = interpolate(v, vars, `${CONFIG_FILE} "env.${k}"`);

  return {
    network: raw.network || null,
    ports: raw.ports || [],
    env,
    resources: raw.resources || {},
    file: configPath,
    hash: sha256(bytes),
    text: bytes.toString('utf8'),
  };
}

// ── Trust records ─────────────────────────────────────────────────────────────────────────────
// Stored host-only (~/.config/claude-pod/trust/), keyed by project path: the sha256 of the config
// bytes you approved. Any change — by you or by a pod — needs approving again.

const trustFile = (root) => path.join(trustDir(), `${sha256(root)}.json`);

export function isTrusted(root, hash) {
  try {
    const rec = JSON.parse(readRegularFile(trustFile(root)).toString('utf8'));
    return rec.root === root && rec.sha256 === hash;
  } catch {
    return false;
  }
}

export function trust(root, hash) {
  ensurePrivateDir(trustDir());
  writeFileAtomic(trustFile(root), `${JSON.stringify({ root, sha256: hash, trustedAt: new Date().toISOString() }, null, 2)}\n`);
}
