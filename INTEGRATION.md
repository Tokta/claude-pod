# Using claude-pod on a project

How to wire a project into claude-pod: services on a Docker network, ports, secrets, and letting
agents launch pods without permission prompts. Assumes you've done the one-time setup from the
[README](README.md#install) (`npm install -g`, `claude-pod build`, `claude-pod auth`).

---

## 1. Create the project config

```bash
cd ~/projects/your-app
claude-pod init
```

This writes `claude-pod.config.json` at the project root (the git root). It pre-fills `network`
when it finds your Docker Compose network (`<folder>_default`) and `envFile` when there's a `.env`.
Then fill in the rest:

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

- **`network`** — lets the pod reach your services by name (`postgres:5432`). Find it with
  `docker network ls`. The stack must be up (`docker compose up -d`) before you launch a pod.
- **`env`** — ⚠️ host `.env` values using `localhost` don't resolve inside the pod; inject
  container-reachable URLs here. `${VAR}` pulls from `envFile` (then the host environment); an
  unset variable is an error, so a missing secret fails at launch rather than as a DB error.
- **`ports`** — container ports; each gets a free `127.0.0.1` host port per pod (printed at launch,
  and available in the pod as `CLAUDE_POD_PORT_<port>`).

Commit the config — it holds no secrets, only references to them. Check it with `claude-pod doctor`.

---

## 2. Agent permissions

Agents launch pods in many shapes — with `P=… &&`, after `cd …;`, with `"$(cat …)"`, redirects and
`echo exit=$?`. Each shape is a different command string, so path-based rules like
`Bash(./scripts/claude-pod.sh:*)` keep missing. `claude-pod run` removes the need for all of that
plumbing, so one rule covers it. In the project's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(claude-pod run:*)"]
  }
}
```

(Scoped to `run` on purpose: `claude-pod uninstall --yes` shouldn't be auto-approved.)

Then tell your agents how to call it — e.g. in `CLAUDE.md` or the orchestrating skill:

```markdown
## Delegating to a sandboxed Claude

Run sub-agents with exactly this form — one command, absolute paths, no `cd`, no variables,
no `$(…)`, no redirects:

    claude-pod run --model opus --prompt-file <abs>/step.md --out <abs>/step

It writes `<abs>/step.out`, `.err` and `.exit`, prints `exit=<code>`, and exits with that code.
Read the `.out` file for the result.
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

Note the exit code now lives in `impl-6b1.exit` (and on stdout as `exit=0`), not appended to `.out`.

---

## 3. Migrating from the per-project scripts

If the project has the old `scripts/claude-pod.sh` / `scripts/claude-pod-auth.sh`:

1. Move its `NETWORK`, ports and injected env into `claude-pod.config.json` (step 1).
2. Delete both scripts, and any `pod` / `pod:auth` entries in `package.json`
   (or point them at `claude-pod` / `claude-pod auth`).
3. Replace the old permission rules with `Bash(claude-pod run:*)` (step 2).
4. Update CLAUDE.md / skills that mention `./scripts/claude-pod.sh`.

The pod itself is unchanged: same image, mounts, `~/.claude-pod` login and hardening flags. Your
existing login keeps working — no need to re-run `auth`.

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

## Pushing code / opening PRs

The pod has **no git or GitHub credentials** by design — don't inject them into a skip-permissions
sandbox. Let the agent commit locally (the project is bind-mounted, so commits appear in your host
repo instantly), then push and open the PR from the host:

```bash
git push -u origin <branch>
gh pr create --fill
```

---

## Gotchas

- **Start autonomous runs from a clean working tree.** Agents often `git add -A`, sweeping unrelated
  uncommitted files into their commits.
- **Parallel pods on one project share the working tree and `.git`.** Concurrent commits can
  collide; per-pod worktrees are planned for v2. Don't run git on the host mid-commit either.
- **Confirm you're in the pod:** `echo "$CLAUDE_POD"; uname -s` prints `1` and `Linux` inside it.
  Paths look the same on both sides, so don't rely on them.
- **First interactive `claude-pod claude --dangerously-skip-permissions`** shows a one-time
  "Bypass Permissions mode" `y/N` in the terminal. Accept it; it persists.
- **The pod can read your project's `.env`** and has outbound internet. It cannot see your home
  dir, SSH keys, Keychain, other repos or your `gh` token.
- **Running a git worktree** as the project: its `.git` file points into the main repo, which is not
  mounted, so git commands inside the pod fail there. Launch from the main checkout for now.
