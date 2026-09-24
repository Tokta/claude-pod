import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readToken, saveToken, validateToken } from '../host.js';
import { stateRoot, tokenPath } from '../paths.js';
import { canPrompt, readSecret } from '../prompt.js';
import { kind } from '../safefs.js';
import { CliError, bold, detail, ok, warn } from '../ui.js';

export const AUTH_HELP = `Usage: claude-pod auth [--from-env] [--remove]

Stores the login token the pods use. Create one on the host (browser login, needs a Claude
subscription) with:

  claude setup-token

then run \`claude-pod auth\` and paste it (or pipe it in: \`claude-pod auth < file\`).
The token is kept in ~/.config/claude-pod/oauth-token (0600), a folder no pod can see, and
handed to each pod as CLAUDE_CODE_OAUTH_TOKEN. It's long-lived and never rotates, so parallel
pods can't log each other out.

Options:
  --from-env   read the token from $CLAUDE_CODE_OAUTH_TOKEN
  --remove     delete the stored token`;

async function readAll(stream) {
  let s = '';
  for await (const chunk of stream) s += chunk;
  return s;
}

export async function auth(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'from-env': { type: 'boolean' },
      remove: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${AUTH_HELP}\n`);
    return 0;
  }
  if (values.remove) {
    fs.rmSync(tokenPath(), { force: true });
    ok('Login token removed.');
    return 0;
  }

  let raw;
  if (values['from-env']) {
    raw = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!raw) throw new CliError('$CLAUDE_CODE_OAUTH_TOKEN is not set.');
  } else if (!process.stdin.isTTY) {
    raw = await readAll(process.stdin);
  } else if (canPrompt()) {
    process.stderr.write(`Create a token on the host with ${bold('claude setup-token')}, then paste it here.\n`);
    raw = await readSecret('Token: ');
  } else {
    throw new CliError('No token given.', { hint: 'Pipe it in, or pass --from-env.' });
  }
  const token = validateToken(raw);
  if (!token.startsWith('sk-ant-oat')) warn('This does not look like a `claude setup-token` token (sk-ant-oat…); storing it anyway.');
  const had = readToken();
  saveToken(token);
  ok(`${had ? 'Replaced' : 'Stored'} the login token in ${bold(tokenPath())}`);

  // The pre-token design copied the host's OAuth login (with its refresh token) into a folder
  // every pod could read. It's unused now; don't leave it lying around.
  const legacy = path.join(stateRoot(), '.credentials.json');
  if (kind(legacy) !== 'missing') {
    fs.rmSync(legacy, { force: true });
    detail(`removed the old copied login ${legacy} (no longer used)`);
  }
  return 0;
}
