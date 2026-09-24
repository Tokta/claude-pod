import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig } from '../config.js';
import { allowedRunDirs, readToken } from '../host.js';
import { recordedImageId } from '../docker.js';
import { hostSettingsPath } from '../paths.js';

export const GUIDE_HELP = `Usage: claude-pod guide [--no-status]

Prints a briefing for AI agents: how to delegate a task to a sandboxed Claude with
\`claude-pod run\`, how to read the results, what each failure means and what to do about it,
and what the pod can and can't do. Ends with a live status of the current project.
Read-only: it never changes anything, so it is safe to auto-approve.`;

const GUIDE = `# claude-pod — guide for agents

claude-pod runs Claude Code inside a Docker container ("pod") that can only see the current
project. Use it to hand a task to a sub-agent that runs with --dangerously-skip-permissions,
without giving that sub-agent the rest of this machine.

## Delegate a task

1. Write the full task prompt to a file in your scratchpad (a temp dir), e.g.
   /tmp/…/scratchpad/step-3.md. Never put prompts or outputs inside the project.
2. Run exactly this form — one command, absolute paths, no cd, no variables, no $(…),
   no redirects, no pipes:

       claude-pod run --model opus --prompt-file /abs/scratchpad/step-3.md --out /abs/scratchpad/step-3

   Run it from inside the project (any subfolder works; the project root is found upwards).
3. When it finishes it prints \`exit=<code>\` and exits with that code. Then read:
       /abs/scratchpad/step-3.out    the sub-agent's answer (stdout)
       /abs/scratchpad/step-3.err    its stderr, and launcher errors
       /abs/scratchpad/step-3.exit   the exit code (written last; its presence = finished)
4. The sub-agent's file edits and commits are already in the project (it's bind-mounted).
   Review them (git diff / git log) before relying on them.

Options: --model opus|sonnet|haiku|<id>, --output-format text|json|stream-json,
--prompt "short text" instead of --prompt-file, --ports to publish the project's dev-server
ports, and anything after \`--\` is passed to claude (e.g. -- --max-turns 30).
Long tasks: run the command in the background if your tool times out; the pod keeps running
until the launcher exits, and is stopped automatically if the launcher is killed.
Several runs may go in parallel, but runs in the same project share its files and git repo.

## When it fails

| You see (in .err or on stderr) | Meaning | Do this |
|---|---|---|
| "…config.json is new or has changed since you approved it" | the project config needs human approval | STOP. Tell the user to review it and run \`claude-pod trust\`. Never approve it yourself. |
| "No login token" / "Not logged in" / 401 | no or invalid login | Tell the user to run \`claude setup-token\` then \`claude-pod auth\`. |
| "Image 'claude-pod' not found" / "not the one claude-pod built" | image missing or replaced | Tell the user to run \`claude-pod build\`. |
| "Docker daemon is not running" / "network … not found" | Docker or the app stack is down | Tell the user (e.g. start Docker, \`docker compose up -d\`). |
| "--prompt-file/--out … outside the allowed folders" / "inside the project" | path rule | Move the file to your scratchpad (temp dir). |
| "Refusing to mount …" | not run from inside a project | Run from the project folder. |
| "…is a symlink…" / "…commondir exists…" / "quarantined" | a previous pod may have tampered with protected files | STOP and tell the user; don't delete or restore anything yourself. |
| "Unknown option" / "Unexpected argument" / "Pass exactly one of" | bad claude-pod arguments | Fix the command (see \`claude-pod run --help\`). |
| any other non-zero exit | the sub-agent itself failed | Read .out and .err; retry once at most with a clearer prompt. |

## Inside the pod (what the sub-agent can and can't do)

- Can: read and write the project, run its tools (node, pnpm, git, gh, jq, curl), reach the
  internet, reach the app's services if the project config joins a Docker network.
- Cannot: see anything outside the project (home dir, SSH keys, other repos), push to git
  or use GitHub credentials (none are present), change .git/hooks, .git/config, .claude/,
  .mcp.json, .envrc, .vscode/, .idea/ (read-only). Files like these that it creates are
  quarantined after the run. \`git config …\` fails; \`git commit\` works with the user's
  global identity; use \`git -c key=value …\` for anything else.
- Detect the pod from inside with \`[ "$CLAUDE_POD" = 1 ]\`.

## Never

- Never run \`claude-pod trust\`, \`claude-pod auth\`, \`claude-pod uninstall\`, or edit
  claude-pod.config.json to get a run working — those are the user's decisions.
- Never pass secrets in --prompt; the sub-agent sees everything you send it.
- Never push the sub-agent's work without reviewing the diff first.

Other commands (for humans): \`claude-pod doctor\` (full check), \`claude-pod ps\` / \`stop\`,
\`claude-pod --help\`.
`;

// Live status for the current folder, from host-side state only (no Docker calls, no writes).
function status() {
  const lines = ['## Status here', ''];
  const row = (okay, text) => lines.push(`- ${okay ? 'ok  ' : 'FAIL'} ${text}`);
  let found;
  try {
    found = findProjectRoot();
    assertSafeRoot(found.root);
    row(true, `project: ${found.root}`);
  } catch (e) {
    row(false, `project: ${e.message}`);
  }
  if (found) {
    if (!found.configPath) row(true, 'config: none (defaults)');
    else {
      try {
        const config = loadConfig(found);
        const trusted = isTrusted(found.root, config.hash);
        row(trusted, trusted
          ? `config: ${path.basename(found.configPath)} approved`
          : 'config: new or changed — runs will refuse until the user runs `claude-pod trust`');
      } catch (e) {
        row(false, `config: ${e.message}`);
      }
    }
  }
  const token = !!readToken();
  row(token, token ? 'login token: stored' : 'login token: missing — user must run `claude setup-token` + `claude-pod auth`');
  const image = !!recordedImageId();
  row(image, image ? 'image: built by claude-pod' : 'image: not built yet — user must run `claude-pod build`');
  try {
    lines.push(`- ok   allowed --prompt-file/--out folders: ${allowedRunDirs().join(', ')} (more via "runDirs" in ${hostSettingsPath()})`);
  } catch (e) {
    row(false, e.message);
  }
  return `${lines.join('\n')}\n`;
}

export async function guide(argv) {
  const { values } = parseArgs({ args: argv, options: { 'no-status': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${GUIDE_HELP}\n`);
    return 0;
  }
  process.stdout.write(GUIDE);
  if (!values['no-status']) process.stdout.write(`\n${status()}`);
  return 0;
}
