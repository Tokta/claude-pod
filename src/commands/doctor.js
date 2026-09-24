import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, loadConfig } from '../config.js';
import { isFresh, readExpiresAt } from '../creds.js';
import { docker, imageStatus } from '../docker.js';
import { IMAGE, podDir, refreshLockPath } from '../paths.js';
import { bold, err, info, ok, warn } from '../ui.js';

export const DOCTOR_HELP = `Usage: claude-pod doctor

Checks Docker, the image, the pod login and the current project's config.`;

export async function doctor(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${DOCTOR_HELP}\n`);
    return 0;
  }
  let failed = false;
  const fail = (msg) => {
    err(msg);
    failed = true;
  };

  info('Host');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} — claude-pod needs Node 20+`);

  let dockerUp = false;
  try {
    const v = docker(['--version']);
    ok(v.stdout.trim());
    dockerUp = docker(['info'], { stdio: 'ignore' }).status === 0;
    if (dockerUp) ok('Docker daemon running');
    else fail('Docker daemon is not running');
  } catch (e) {
    fail(e.message);
  }
  if (dockerUp) {
    const img = imageStatus();
    if (!img.exists) fail(`image '${IMAGE}' not built — run ${bold('claude-pod build')}`);
    else if (img.stale) warn(`image '${IMAGE}' was built from a different Dockerfile — run ${bold('claude-pod build')}`);
    else ok(`image '${IMAGE}' up to date`);
  }

  info('Login');
  const dir = podDir();
  if (fs.existsSync(dir)) {
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode === 0o700) ok(`${dir} (0700)`);
    else warn(`${dir} is ${mode.toString(8)}; the next launch resets it to 700`);
  }
  const exp = readExpiresAt();
  if (exp === null) fail(`no pod credentials — run ${bold('claude-pod auth')}`);
  else if (isFresh(exp)) ok(`access token valid until ${new Date(exp).toISOString()}`);
  else ok(`access token expired ${exp ? new Date(exp).toISOString() : '(unknown)'} — the next pod refreshes it`);
  if (fs.existsSync(refreshLockPath())) warn(`credential lock held: ${refreshLockPath()} (a pod is refreshing the login)`);

  info('Project');
  try {
    const found = findProjectRoot();
    assertSafeRoot(found.root);
    ok(`root: ${found.root}`);
    const config = loadConfig(found);
    if (!found.configPath) ok('no claude-pod.config.json (defaults: no network, no ports, no extra env)');
    else {
      ok(`config: ${found.configPath}`);
      if (config.network && config.network !== 'none' && dockerUp) {
        if (docker(['network', 'inspect', config.network], { stdio: 'ignore' }).status === 0) ok(`network ${config.network} exists`);
        else fail(`network ${config.network} not found — start your stack (docker compose up -d)`);
      }
      if (config.ports.length) ok(`ports: ${config.ports.join(', ')} (published on free host ports)`);
      if (Object.keys(config.env).length) ok(`env: ${Object.keys(config.env).join(', ')}`);
    }
  } catch (e) {
    fail(e.message);
  }

  return failed ? 1 : 0;
}
