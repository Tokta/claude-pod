import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig } from '../config.js';
import { docker, imageStatus } from '../docker.js';
import { readToken } from '../host.js';
import { IMAGE, hostDir, projectStateDir, stateRoot, tokenPath } from '../paths.js';
import { kind } from '../safefs.js';
import { bold, err, info, ok, warn } from '../ui.js';

export const DOCTOR_HELP = `Usage: claude-pod doctor

Checks Docker, the image, the login token and the current project's config.`;

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
    ok(docker(['--version']).stdout.trim());
    dockerUp = docker(['info'], { stdio: 'ignore' }).status === 0;
    if (dockerUp) ok('Docker daemon running');
    else fail('Docker daemon is not running');
  } catch (e) {
    fail(e.message);
  }
  if (dockerUp) {
    const img = imageStatus();
    if (!img.exists) fail(`image '${IMAGE}' not built — run ${bold('claude-pod build')}`);
    else if (img.replaced) fail(`image '${IMAGE}' is not the one claude-pod built — run ${bold('claude-pod build')}`);
    else if (!img.recorded) warn(`image '${IMAGE}' predates this version — run ${bold('claude-pod build')}`);
    else if (img.stale) warn(`image '${IMAGE}' was built from a different Dockerfile — run ${bold('claude-pod build')}`);
    else ok(`image '${IMAGE}' up to date`);
  }

  info('Login');
  if (readToken()) ok(`token stored in ${tokenPath()}`);
  else fail(`no login token — run ${bold('claude setup-token')} on the host, then ${bold('claude-pod auth')}`);
  if (kind(hostDir()) === 'dir') ok(`${hostDir()} (host-only, never mounted)`);
  const legacy = path.join(stateRoot(), '.credentials.json');
  if (kind(legacy) !== 'missing') warn(`${legacy} is an old copied login (with a refresh token) that is no longer used — delete it, or run ${bold('claude-pod auth')}`);
  for (const old of ['projects', 'settings.json', '.claude.json']) {
    if (kind(path.join(stateRoot(), old)) !== 'missing') {
      warn(`${path.join(stateRoot(), old)} is state from the old shared layout (pods now use ${path.join(stateRoot(), 'pods')}/<project>); delete it when you no longer need the history`);
      break;
    }
  }

  info('Project');
  try {
    const found = findProjectRoot();
    assertSafeRoot(found.root);
    ok(`root: ${found.root}`);
    ok(`pod state: ${projectStateDir(found.root)}`);
    const config = loadConfig(found);
    if (!found.configPath) ok('no claude-pod.config.json (defaults: default network, no ports, no extra env)');
    else {
      ok(`config: ${found.configPath}`);
      if (isTrusted(found.root, config.hash)) ok('config trusted');
      else fail(`config is new or changed since you approved it — review it, then ${bold('claude-pod trust')}`);
      if (config.network && config.network !== 'none' && dockerUp) {
        const res = docker(['network', 'inspect', '--format', '{{.Driver}}', config.network]);
        if (res.status !== 0) fail(`network ${config.network} not found — start your stack (docker compose up -d)`);
        else if (res.stdout.trim() !== 'bridge') fail(`network ${config.network} uses the '${res.stdout.trim()}' driver; only bridge is allowed`);
        else ok(`network ${config.network} exists (bridge)`);
      }
      if (config.ports.length) ok(`ports: ${config.ports.join(', ')} (published on free host ports)`);
      if (Object.keys(config.env).length) ok(`env: ${Object.keys(config.env).join(', ')}`);
    }
  } catch (e) {
    fail(e.message);
  }

  return failed ? 1 : 0;
}
