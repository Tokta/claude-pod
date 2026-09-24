import { parseArgs } from 'node:util';
import { findProjectRoot } from '../config.js';
import { docker } from '../docker.js';
import { LABEL, LABEL_MODE, LABEL_PROJECT } from '../paths.js';
import { CliError, ok } from '../ui.js';

export const PS_HELP = `Usage: claude-pod ps [--all]

Lists running pods for the current project (--all: every project).`;

export const STOP_HELP = `Usage: claude-pod stop [NAME...] [--all]

Stops pods by name; with no names, every pod of the current project; --all stops every pod.`;

function listPods() {
  const fmt = `{{.Names}}\t{{.Label "${LABEL_PROJECT}"}}\t{{.Label "${LABEL_MODE}"}}\t{{.RunningFor}}\t{{.Ports}}`;
  const res = docker(['ps', '--filter', `label=${LABEL}`, '--format', fmt]);
  if (res.status !== 0) throw new CliError(`docker ps failed: ${res.stderr.trim()}`);
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, project, mode, age, ports] = line.split('\t');
    return { name, project, mode, age, ports };
  });
}

export async function ps(argv) {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${PS_HELP}\n`);
    return 0;
  }
  const root = findProjectRoot().root;
  const pods = listPods().filter((p) => values.all || p.project === root);
  if (!pods.length) {
    process.stderr.write(values.all ? 'No pods running.\n' : `No pods running for ${root} (--all for every project).\n`);
    return 0;
  }
  const rows = [['NAME', 'MODE', 'UP', 'PORTS', ...(values.all ? ['PROJECT'] : [])]];
  for (const p of pods) rows.push([p.name, p.mode, p.age, p.ports || '-', ...(values.all ? [p.project] : [])]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) process.stdout.write(`${r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()}\n`);
  return 0;
}

export async function stop(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    process.stdout.write(`${STOP_HELP}\n`);
    return 0;
  }
  const pods = listPods();
  let targets;
  if (positionals.length) {
    const known = new Set(pods.map((p) => p.name));
    for (const n of positionals) if (!known.has(n)) throw new CliError(`No running pod named ${n}.`);
    targets = positionals;
  } else {
    const root = findProjectRoot().root;
    targets = pods.filter((p) => values.all || p.project === root).map((p) => p.name);
  }
  if (!targets.length) {
    process.stderr.write('No pods to stop.\n');
    return 0;
  }
  const res = docker(['stop', ...targets]);
  if (res.status !== 0) throw new CliError(`docker stop failed: ${res.stderr.trim()}`);
  for (const t of targets) ok(`Stopped ${t}`);
  return 0;
}
