# Using claude-pod on a project

A step-by-step guide to running Claude Code (or a shell) inside the **claude-pod** sandbox for one
of your projects — including how to authenticate without the broken in-container browser login.

The pod bind-mounts **only your project folder** (at its real path) plus its own auth dir, drops
all Linux capabilities, and runs as your user. That tight blast radius is exactly why it's the
right place to run Claude with `--dangerously-skip-permissions`: an autonomous agent can churn
through a task without being able to touch the rest of your machine.

> Two ready-to-use scripts live in [`templates/`](templates/):
> - `claude-pod.sh` — per-project launcher (you copy + edit a small CONFIG block)
> - `claude-pod-auth.sh` — exports your host login into the pod (used as-is)

---

## Prerequisites

1. **Docker Desktop** installed and running.
2. **Build the image once:** clone this repo and run `./install.sh`. It builds the local
   `claude-pod` image (Node + git + gh + Claude Code + pnpm). Re-run it to pick up new Claude
   Code releases.
3. **Be logged in to Claude Code on your host** (desktop app or `claude` CLI) — the pod reuses
   that session.
4. **macOS** for the auth helper (it reads the login Keychain). Linux hosts: see the note in
   step 3.

---

## 1. Add the two scripts to your project

Copy both templates into your project's `scripts/` directory and make them executable:

```bash
mkdir -p scripts
cp /path/to/claude-pod/templates/claude-pod.sh       scripts/claude-pod.sh
cp /path/to/claude-pod/templates/claude-pod-auth.sh  scripts/claude-pod-auth.sh
chmod +x scripts/claude-pod.sh scripts/claude-pod-auth.sh
```

If it's a Node project, add convenience scripts to `package.json` (optional):

```json
{
  "scripts": {
    "pod": "bash scripts/claude-pod.sh",
    "pod:auth": "bash scripts/claude-pod-auth.sh"
  }
}
```

---

## 2. Configure the launcher

Open `scripts/claude-pod.sh` and edit the **CONFIG** block near the top:

| Setting | What to put |
|---|---|
| `NETWORK` | Your app's Docker network, so the pod can reach services by name (e.g. `postgres:5432`). Find it with `docker network ls` — it's usually `<compose-project>_default`. Leave empty if the pod doesn't need your services. |
| `EXPOSE_PORTS` | Ports to surface from the pod to `127.0.0.1`, e.g. `"3000 8080"` — only if you want to hit a dev server the pod runs. Empty otherwise. |
| `EXTRA_ENV` | Extra env to inject. Most commonly a DB URL pointing at the **service name** on `NETWORK`. ⚠️ Host `.env` values using `localhost` won't resolve inside the pod — inject a container-reachable URL here. Example is in the file. |

Why the same path on both sides? The project is mounted at its **identical absolute path**, so
file references in logs and stack traces read the same whether Claude is on the host or in the pod.

---

## 3. Authenticate the pod (one-time per host login)

The pod **cannot** use the in-container `/login` — its browser OAuth redirect is rejected by the
client. Instead, export your host session:

```bash
# Make sure you're logged in to Claude Code on the host first, then:
bash scripts/claude-pod-auth.sh      # or: pnpm pod:auth
```

This copies your OAuth token from the Keychain into `~/.claude-pod/.credentials.json` and pre-sets
the onboarding flags so the pod skips the theme/login wizard. The exported access token may show as
already expired — that's fine, the pod refreshes it from the long-lived refresh token on launch.

> **Linux hosts:** there's no Keychain. Instead copy your file-based creds directly:
> `mkdir -p ~/.claude-pod && cp ~/.claude/.credentials.json ~/.claude-pod/`.

**The one rule that avoids a world of pain:** the host and the pod share an OAuth lineage, and
whichever refreshes a token first **rotates the other one out**. So:

- Run `claude-pod-auth.sh` **once** after a host login, then leave it alone.
- **Don't** re-run it on a stale Keychain — re-exporting an already-rotated token causes a `401`.
- The script has a **guard**: it refuses to overwrite when the pod's token is newer than the
  Keychain's. After a deliberate fresh host `/login`, use `--force` to override it.

---

## 4. Launch

Free any ports you told the launcher to expose (if your host app is using them), then:

```bash
bash scripts/claude-pod.sh claude --dangerously-skip-permissions --model opus "<your prompt>"
```

- `--model` accepts `opus` | `sonnet` | `haiku` (or a full model id). Availability follows your
  subscription tier.
- On first launch you'll get a one-time **"Bypass Permissions mode"** warning — that's a simple
  terminal `y/N`, not the browser flow. Accept it; it persists.
- A plain `bash scripts/claude-pod.sh` (no `claude`) drops you into a shell in the pod.

**Confirm you're actually inside the pod** — ask the running Claude to `run: echo "$CLAUDE_POD"; uname -s`.
Inside the pod that prints `1` and `Linux`; on your host it's empty and `Darwin`. (Paths look
identical on both because of the same-path mount, so don't rely on the path.)

---

## 5. (Optional) pnpm monorepos: make `node_modules` work on host *and* pod

If you share one `node_modules` between your macOS host and the Linux pod (same bind-mounted
folder), native packages (esbuild, sharp, next-swc, …) need binaries for **both** platforms.
Add this to `pnpm-workspace.yaml` and re-run a clean `pnpm install`:

```yaml
supportedArchitectures:
  os: [current, linux, darwin]
  cpu: [current, arm64]
```

**Seamless `dev` across host and pod:** if your dev script runs `docker compose up` to start a DB,
that fails inside the pod (no Docker there). Gate it on the `CLAUDE_POD` marker the launcher injects:

```bash
# scripts/dev.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -z "${CLAUDE_POD:-}" ] && docker compose up -d   # host only; in the pod the DB is already up
# ...then run migrations + start your apps
```

---

## Daily use & lifecycle

- **Credentials persist across reboots** (they're on disk in `~/.claude-pod`). A new task is just a
  new prompt — no re-auth needed if the token's still valid.
- **After a restart:** start Docker, bring your app's network/services back up
  (`docker compose up -d`), then launch as usual.
- **If you hit `401 / Please run /login`:** do a fresh `/login` on the **host** (browser works
  there), then `claude-pod-auth.sh` once (the guard allows it — Keychain is now newest), then relaunch.

---

## Pushing code / opening PRs from a run

The pod has **no git or GitHub credentials** by design. Don't inject them into a
skip-permissions sandbox. Instead, let the agent create the branch and **commit locally** — because
the project is bind-mounted, those commits appear in your host repo instantly. Then **push and open
the PR from your host**, where your `gh`/SSH auth already lives:

```bash
git push -u origin <branch>
gh pr create --fill
```

---

## Gotchas (learned the hard way)

- **Commit or stash unrelated work before an autonomous run.** An agent told to commit its work
  often does `git add -A` — which will sweep *any* uncommitted file in the tree (including unrelated
  edits) into its commits. Start from a clean working tree.
- **Free exposed ports first.** The launcher publishes `EXPOSE_PORTS`; if your host app already holds
  one, the container fails with "port is already allocated."
- **Don't run git in the host repo while a pod session is mid-commit.** Host and pod share the same
  `.git` and working tree — concurrent git operations can collide.
- **Shell one-liners: call the script directly, don't go through `pnpm pod -- …`.** The image is
  `FROM node:*`, whose entrypoint prepends `node` when the first arg starts with `-`. A stray `--`
  becomes `node -- bash …` and fails. Use `bash scripts/claude-pod.sh bash -lc '…'`.
- **The pod *can* read your project's `.env`** (it's inside the mounted folder) and has **outbound
  internet**. It *cannot* see your home dir, SSH keys, Keychain, other repos, or your `gh` token.
- **`NET=none`** (env var, supported by the base image's `claude-pod` script) cuts all networking if
  you want to inspect untrusted code offline — but then Claude can't reach the API either.
