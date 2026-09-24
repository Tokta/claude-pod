# Using claude-pod on a project

How to wire a project into claude-pod: services on a Docker network, ports, secrets, and letting
agents launch pods without permission prompts. Assumes you've done the one-time setup from the
[README](README.md#install): `npm install -g`, `claude-pod build`, `claude setup-token` +
`claude-pod auth`.

---

## 1. Create the project config

```bash
cd ~/projects/your-app
claude-pod init
```

This writes `claude-pod.config.json` at the project root (the git root) and approves it. It
pre-fills `network` when it finds your Docker Compose network (`<folder>_default`) and `envFile`
when there's a `.env`. Then fill in the rest, for example:

```json
{
  "network": "ops-olive_default",
  "ports": [3000, 3131],
  "envFile": ".env",
  "env": {
    "HOST": "0.0.0.0",
    "DATABASE_URL": "postgresql://app_user:${APP_USER_PASSWORD}@postgres:5432/ops_olive_database",
    "MIGRATION_DATABASE_URL": "postgresql://ops_olive:${POSTGRES_PASSWORD}@postgres:5432/ops_olive_database"
  }
}
```

and approve the edit:

```bash
claude-pod trust     # shows the file, asks y/N
```

- **`network`** — lets the pod reach your services by name (`postgres:5432`). Find it with
  `docker network ls`. Must be a bridge network (Compose networks are); the stack must be up
  (`docker compose up -d`) before you launch a pod.
- **`env`** — ⚠️ host `.env` values using `localhost` don't resolve inside the pod; inject
  container-reachable URLs here. `${VAR}` comes from `envFile` only (a file inside the project) —
  never from your shell environment. An unset variable is an error, so a missing secret fails at
  launch rather than as a DB error.
- **`ports`** — container ports; each gets a free `127.0.0.1` host port per pod (printed at launch,
  and available in the pod as `CLAUDE_POD_PORT_<port>`).

Commit the config — it holds no secrets, only references to them. Check with `claude-pod doctor`.

**Why the approval step:** the config sits in the project, which pods can write. Without it, one
hostile run could edit the config so the *next* pod joins a more powerful network or pulls in more
secrets. Any change — yours, a teammate's via `git pull`, or a pod's — must be approved again with
`claude-pod trust`, and unattended runs refuse to start until it is. If an agent run fails with
"is new or has changed since you approved it" and you didn't change the config, **look at
`git diff claude-pod.config.json` before trusting it.**

---

## 2. Agent permissions

Agents launch pods in many shapes — with `P=… &&`, after `cd …;`, with `"$(cat …)"`, redirects and
`echo exit=$?`. Each shape is a different command string, so path-based rules like
`Bash(./scripts/claude-pod.sh:*)` keep missing. `claude-pod run` removes the need for all of that
plumbing, so one rule covers it. In the project's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(claude-pod run:*)", "Bash(claude-pod guide:*)"]
  }
}
```

Only `run` and the read-only `guide`. Keep `claude-pod trust`, `auth`, `uninstall` and friends behind a prompt: an
orchestrator that could approve configs itself would defeat the approval step.

Then point your agents at it — e.g. in `CLAUDE.md` or the orchestrating skill. `claude-pod guide`
prints the full agent briefing (exact command form, how to read results, what each error means
and whether to stop and ask you) plus a live status of the project, so a short pointer is enough:

```markdown
## Delegating to a sandboxed Claude

Before delegating, run `claude-pod guide` once and follow it. In short:

Run sub-agents with exactly this form — one command, absolute paths, no `cd`, no variables,
no `$(…)`, no redirects:

    claude-pod run --model opus --prompt-file <scratchpad>/step.md --out <scratchpad>/step

Both paths must be in your scratchpad (a temp dir), never inside the project.
It writes `<scratchpad>/step.out`, `.err` and `.exit`, prints `exit=<code>`, and exits with that
code. Read the `.out` file for the result. If it fails because the config is untrusted, stop and
tell the user — never try to approve it yourself.
```

Before → after:

```bash
# before
P=/private/tmp/…/scratchpad && ./scripts/claude-pod.sh claude --print --dangerously-skip-permissions \
  --model opus --output-format text "$(cat $P/step-implementer-6b1.md)" > $P/impl-6b1.out 2> $P/impl-6b1.err; \
  echo "exit=$?" >> $P/impl-6b1.out

# after
claude-pod run --model opus --prompt-file /private/tmp/…/scratchpad/step-implementer-6b1.md --out /private/tmp/…/scratchpad/impl-6b1
```

The exit code now lives in `impl-6b1.exit` (and on stdout as `exit=0`), not appended to `.out`.

If your scratchpads live somewhere other than a temp dir, allow that folder host-side in
`~/.config/claude-pod/settings.json`:

```json
{ "runDirs": ["/Users/you/agent-scratch"] }
```

---

## 3. Migrating from the per-project scripts

If the project has the old `scripts/claude-pod.sh` / `scripts/claude-pod-auth.sh`:

1. Move its `NETWORK`, ports and injected env into `claude-pod.config.json` (step 1), then
   `claude-pod trust`.
2. Delete both scripts, and any `pod` / `pod:auth` entries in `package.json`
   (or point them at `claude-pod` / `claude-pod auth`).
3. Replace the old permission rules with `Bash(claude-pod run:*)` and `Bash(claude-pod guide:*)` (step 2).
4. Update CLAUDE.md / skills that mention `./scripts/claude-pod.sh`.
5. Once per machine: `claude setup-token` + `claude-pod auth` (replaces the Keychain export; it
   also deletes the old copied login from `~/.claude-pod`).

---

## 4. (Optional) pnpm monorepos: `node_modules` for host *and* pod

Host (macOS) and pod (Linux) share the same `node_modules`, so native packages (esbuild, sharp,
next-swc, …) need binaries for both. In `pnpm-workspace.yaml`, then a clean `pnpm install`:

```yaml
supportedArchitectures:
  os: [current, linux, darwin]
  cpu: [current, arm64]
```

**One `dev` script for host and pod:** `docker compose` isn't available inside the pod. Gate it on
the `CLAUDE_POD` marker:

```bash
[ -z "${CLAUDE_POD:-}" ] && docker compose up -d   # host only; in the pod the DB is already up
```

---

## After an unattended run

The pod has **no git or GitHub credentials** by design. Let the agent commit locally (the project
is bind-mounted, so commits appear in your host repo instantly), then review and push from the host:

```bash
# Review with git's hook/fsmonitor/submodule features off: a pod can't change the top-level hooks
# or config, but it can create nested repos in subfolders and register them in the index.
alias gsafe='git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c submodule.recurse=false -c diff.ignoreSubmodules=all'
gsafe status                    # anything claude-pod quarantined shows up as *.claude-pod-quarantine-*
gsafe log -p --stat origin/main..HEAD   # what the agent committed — incl. package.json scripts,
                                        # Makefiles and test configs you're about to run on your host
gsafe ls-files --stage | grep '^160000'           # submodule entries: should be only ones you expect
find . -path ./node_modules -prune -o -name .git -not -path ./.git -print   # nested repos: ditto
git push -u origin <branch>
gh pr create --fill
```

Top-level git hooks, `.git/config` and `.git` itself are protected inside the pod, so pushing
can't trigger anything a pod planted there. Unexpected new submodules or nested `.git` folders
are the thing to look for before running plain `git` commands.

---

## Gotchas

- **Start autonomous runs from a clean working tree.** Agents often `git add -A`, sweeping unrelated
  uncommitted files into their commits.
- **Parallel pods on one project share the working tree and `.git`.** Concurrent commits can
  collide; per-pod worktrees are planned for v2. Don't run git on the host mid-commit either.
- **`git config …` fails inside the pod** (`.git/config` is read-only). Commits use your global
  git identity; use `git -c key=value …` for anything else.
- **Editing `.claude/`, `.mcp.json`, `.envrc`, `.vscode/` from inside the pod fails** (read-only),
  and creating them gets them quarantined. Edit those on the host.
- **Confirm you're in the pod:** `echo "$CLAUDE_POD"; uname -s` prints `1` and `Linux` inside it.
- **First interactive `claude-pod claude --dangerously-skip-permissions`** shows a one-time
  "Bypass Permissions mode" `y/N` in the terminal. Accept it; it persists for that project.
- **The pod can read your project's `.env`** and has outbound internet. It cannot see your home
  dir, SSH keys, Keychain, other repos, other projects' pod history, or your `gh` token.
- **Running from a git worktree** as the project: its `.git` file points into the main repo, which
  is not mounted, so git commands inside the pod fail there. Launch from the main checkout for now.
