import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE } from './paths.js';
import { parseDotenv } from './dotenv.js';
import { CliError } from './ui.js';

// Walks up from `start` looking for a directory that satisfies `test`. Returns it, or null.
function findUp(start, test) {
  let dir = path.resolve(start);
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
//   3. else the cwd itself.
export function findProjectRoot(cwd = process.cwd()) {
  const withConfig = findUp(cwd, (d) => fs.existsSync(path.join(d, CONFIG_FILE)));
  if (withConfig) return { root: withConfig, configPath: path.join(withConfig, CONFIG_FILE) };
  const gitRoot = findUp(cwd, (d) => fs.existsSync(path.join(d, '.git')));
  return { root: gitRoot || path.resolve(cwd), configPath: null };
}

// Mounting $HOME or / would hand the pod your SSH keys, cloud creds and every other project —
// exactly what the sandbox exists to prevent.
export function assertSafeRoot(root) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new CliError(`Refusing to mount ${resolved} into the pod.`, {
      hint: 'cd into a project folder first (or add a claude-pod.config.json to it).',
    });
  }
}

const KNOWN_KEYS = new Set(['network', 'ports', 'envFile', 'env', 'resources']);

function validate(raw, file) {
  const bad = (msg) => new CliError(`${file}: ${msg}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be a JSON object.');
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('$')) throw bad(`unknown key "${key}".`);
  }
  if (raw.network !== undefined && (typeof raw.network !== 'string' || !raw.network)) {
    throw bad('"network" must be a non-empty string.');
  }
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) throw bad('"ports" must be an array of container port numbers.');
    for (const p of raw.ports) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad(`"ports" entry ${JSON.stringify(p)} is not a port number (1-65535).`);
    }
    if (new Set(raw.ports).size !== raw.ports.length) throw bad('"ports" has duplicates.');
  }
  if (raw.envFile !== undefined && (typeof raw.envFile !== 'string' || !raw.envFile)) {
    throw bad('"envFile" must be a non-empty string.');
  }
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw bad('"env" must be an object.');
    for (const [k, v] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad(`"env" key "${k}" is not a valid variable name.`);
      if (typeof v !== 'string') throw bad(`"env.${k}" must be a string.`);
    }
  }
  if (raw.resources !== undefined) {
    const r = raw.resources;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw bad('"resources" must be an object.');
    for (const key of Object.keys(r)) {
      if (!['pids', 'memory', 'cpus'].includes(key)) throw bad(`unknown "resources" key "${key}".`);
    }
    if (r.pids !== undefined && (!Number.isInteger(r.pids) || r.pids < 1)) throw bad('"resources.pids" must be a positive integer.');
    for (const key of ['memory', 'cpus']) {
      if (r[key] !== undefined && typeof r[key] !== 'string' && typeof r[key] !== 'number') {
        throw bad(`"resources.${key}" must be a string or number.`);
      }
    }
  }
  return raw;
}

// Replaces ${VAR} with a value from `vars`; `$$` is a literal `$`. Unknown variables are an error
// rather than an empty string, so a missing secret fails here instead of as a cryptic DB error.
export function interpolate(template, vars, where) {
  return template.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (match === '$$') return '$';
    if (!(name in vars)) throw new CliError(`${where} references \${${name}}, which is not set.`);
    return vars[name];
  });
}

// Loads and resolves the project's config. With no config file, returns the empty defaults.
export function loadConfig({ root, configPath }) {
  const empty = { network: null, ports: [], env: {}, resources: {}, file: null };
  if (!configPath) return empty;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new CliError(`Could not read ${configPath}: ${e.message}`);
  }
  validate(raw, CONFIG_FILE);

  // Interpolation sources: the envFile (if any) first, then the host environment.
  let fileVars = {};
  if (raw.envFile) {
    const envPath = path.resolve(root, raw.envFile);
    if (!fs.existsSync(envPath)) {
      throw new CliError(`envFile ${envPath} not found.`, { hint: 'Create it (e.g. from .env.example) or remove "envFile" from the config.' });
    }
    fileVars = parseDotenv(fs.readFileSync(envPath, 'utf8'));
  }
  const vars = { ...process.env, ...fileVars };
  const env = {};
  for (const [k, v] of Object.entries(raw.env || {})) env[k] = interpolate(v, vars, `${CONFIG_FILE} "env.${k}"`);

  return {
    network: raw.network || null,
    ports: raw.ports || [],
    env,
    resources: raw.resources || {},
    file: configPath,
  };
}
