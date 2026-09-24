# claude-pod

> Docker sandbox for the Claude Code CLI. Runs Claude against one project folder — built for `--dangerously-skip-permissions` — while your home directory, SSH keys, and other projects stay invisible to the container. Unofficial.

![claude-pod](assets/cover.jpeg)

## TL;DR

`claude-pod` is a small CLI (command-line interface) that starts Claude Code inside a Docker container mounting only the project you run it from. Claude can read and edit that project; the rest of your machine — home directory, SSH keys, other projects, host shell — isn't mounted, so the container can't see it. That makes it the right place for autonomous runs with `--dangerously-skip-permissions`.

```sh
# Once per machine
git clone <this repo> ~/Documents/GitHub/claude-pod
npm install -g ~/Documents/GitHub/claude-pod   # links the `claude-pod` command (not published anywhere)
claude-pod build                               # build the Docker image
claude-pod auth                                # copy your host Claude login into the pod

# In any project
cd ~/projects/your-project
claude-pod                                     # bash shell in the pod
claude-pod claude                              # interactive Claude in the pod
claude-pod run --model opus --prompt-file task.md --out /tmp/task   # headless agent run
```

Setting a project up (Docker network, ports, env, agent permissions)? See **[INTEGRATION.md](INTEGRATION.md)**.

It's not full isolation — here's the boundary:

- ✅ **Outside the project folder is unreachable.** Home directory, `~/.ssh`, `~/.aws`, other projects and the host shell aren't mounted.
- ⚠️ **Inside the project folder is fully exposed.** Any `.env`, `.git/config`, or keys in it are readable and writable; outbound network is open; your pod login lives on the host under `~/.claude-pod/`.
- 🚫 **`claude-pod` refuses to mount your home directory or `/`.** Run it inside a project.

## Contents

- [Install](#install)
- [Commands](#commands)
- [Project root and config](#project-root-and-config)
- [Ports](#ports)
- [Login and the credential lock](#login-and-the-credential-lock)
- [Running several pods](#running-several-pods)
- [Updating or pinning Claude Code](#updating-or-pinning-claude-code)
- [Security and limits](#security-and-limits)
- [Reference](#reference)

## Install

Requirements: **Docker** (Desktop, OrbStack, Colima or Engine) and **Node.js 20+** on the host.

```sh
npm install -g /path/to/claude-pod    # or: cd /path/to/claude-pod && npm link
claude-pod build
claude-pod auth
claude-pod doctor                     # checks everything
```

`npm install -g <folder>` symlinks the folder, so a `git pull` in the clone updates the command immediately. The package is marked `private`, so it can't be published by accident. If the Dockerfile changes, every launch warns you to re-run `claude-pod build`.

## Commands

| Command | What it does |
|---|---|
| `claude-pod` / `claude-pod shell` | bash shell in the pod |
| `claude-pod claude [args…]` | Claude in the pod; args passed through unchanged |
| `claude-pod exec <cmd> [args…]` | any command in the pod, e.g. `claude-pod exec pnpm test` |
| `claude-pod run …` | headless Claude task with `--print --dangerously-skip-permissions` (below) |
| `claude-pod build [--claude-version V]` | build or rebuild the image |
| `claude-pod auth [--force] [--from FILE]` | copy your host login into the pod |
| `claude-pod init` | create `claude-pod.config.json` for the current project |
| `claude-pod ps [--all]` / `claude-pod stop [NAME…] [--all]` | list / stop running pods |
| `claude-pod doctor` | check Docker, image, login and project config |
| `claude-pod uninstall [--yes]` | remove the image and `~/.claude-pod` |

Every command has `--help`. Launcher messages go to **stderr**, so stdout carries only what runs in the pod.

### `claude-pod run`

One command, no shell plumbing — designed for agents that orchestrate other agents:

```sh
claude-pod run --model opus --prompt-file /abs/scratchpad/step-6b1.md --out /abs/scratchpad/impl-6b1
```

- Runs `claude --print --dangerously-skip-permissions --output-format text [--model …]` in a fresh pod.
- Feeds the prompt file on stdin — no `"$(cat …)"`, no argument-length limits.
- With `--out BASE`: writes `BASE.out`, `BASE.err`, `BASE.exit`, then prints `exit=<code>`. Without it, streams to stdout/stderr.
- Exits with Claude's exit code.
- `--prompt TEXT` for short prompts, `--output-format json`, `--ports` to publish the config's ports, and anything after `--` goes to `claude` verbatim.

Because it's a single plain command, one permission rule covers every way an agent calls it — see [INTEGRATION.md](INTEGRATION.md#agent-permissions).

## Project root and config

The folder mounted into the pod is found the way git finds `.git`, so launching from a subfolder or after a `cd` gives the same result:

1. the nearest folder (walking up) containing `claude-pod.config.json`;
2. else the nearest git root;
3. else the current folder.

It is mounted at its **real path**, so file paths in logs and stack traces match between host and pod. The pod starts in your current subfolder when you're inside the project.

`claude-pod.config.json` is optional:

```json
{
  "network": "my-app_default",
  "ports": [3000, 3131],
  "envFile": ".env",
  "env": {
    "HOST": "0.0.0.0",
    "DATABASE_URL": "postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/app"
  },
  "resources": { "pids": 4096, "memory": "4g", "cpus": 2 }
}
```

| Key | Meaning |
|---|---|
| `network` | Docker network to join so the pod reaches services by name (`postgres:5432`). `"none"` cuts all networking. |
| `ports` | Container ports to publish on **free** `127.0.0.1` host ports (see [Ports](#ports)). |
| `envFile` | `.env`-style file whose values can be used as `${VAR}` in `env` (host env vars work too). |
| `env` | Extra environment for the pod. A `${VAR}` that isn't set is an error; `$$` is a literal `$`. |
| `resources` | `pids` (default 4096), `memory`, `cpus`. |

Env values are handed to Docker through its environment, never on the command line, so secrets don't show up in `ps`.

## Ports

Each port in `ports` is published on a free host port chosen at launch, bound to `127.0.0.1` only:

```
● claude-pod claude-pod-my-app-3f9a1c
  port 3000 → http://127.0.0.1:52341
  port 3131 → http://127.0.0.1:52342
```

Inside the pod, `CLAUDE_POD_PORT_3000=52341` etc. tell your app its host-side URL. No clashes with a dev server already running on your host, or with other pods. `shell`, `claude` and `exec` publish ports; `run` doesn't unless you pass `--ports`. `claude-pod ps` shows the mappings.

> **Bind dev servers to `0.0.0.0` inside the pod**, not `localhost` (e.g. `"HOST": "0.0.0.0"` in `env`, `vite --host`, `next dev -H 0.0.0.0`). The host side stays `127.0.0.1`-only, so this doesn't expose anything to your LAN.

## Login and the credential lock

The in-pod `/login` browser flow doesn't work (the OAuth redirect is rejected), so `claude-pod auth` copies your host session into `~/.claude-pod/.credentials.json` — from the macOS Keychain on macOS, from `~/.claude/.credentials.json` on Linux, or `--from FILE`. It also marks onboarding as done so the pod skips the setup wizard.

The host and the pod share one OAuth lineage, and every token refresh rotates the refresh token. So:

- Run `claude-pod auth` once after a host login, then leave it alone — the pod refreshes itself.
- `auth` refuses to overwrite a newer pod token with an older host one (that's what causes 401s). After a deliberate fresh host `/login`, use `--force`.
- On `401 / Please run /login`: fresh `/login` on the host, then `claude-pod auth`.

**Credential lock.** All pods share the same credentials file. If several start at once with an expired access token, they'd all refresh with the same refresh token and all but one would get a 401. When the token is expired, launchers of `claude` and `run` take a lock (`~/.claude-pod/refresh.lock`) one at a time: the first starts its pod and holds the lock until that pod has written a fresh token (up to 60 s); the rest then start with the fresh token. With a valid token there's no lock and no waiting. Locks left by a crashed launcher are cleared automatically.

## Running several pods

Pods are independent: unique names (`claude-pod-<project>-<id>`), free ports, and the credential lock above. `claude-pod ps` lists them; `claude-pod stop` stops the current project's pods (or `--all`, or by name).

Pods of the **same project** share its working tree and `.git`, so parallel agents committing in one repo can collide. Per-pod git worktrees are planned for v2.

## Updating or pinning Claude Code

```sh
claude-pod build                          # refetch the latest Claude Code
claude-pod build --claude-version 2.0.0   # pin (also: CLAUDE_CODE_VERSION=2.0.0)
```

The image is intentionally minimal: `node:24-slim` + `git` + `curl` + `less` + `jq` + `gh` + `pnpm` + Claude Code. Add toolchains your projects need by editing the `Dockerfile` and re-running `claude-pod build`.

## Security and limits

### What a pod is

One `docker run` (see `buildRunArgs` in [`src/docker.js`](src/docker.js)):

- runs as your host user (`--user uid:gid`), so files it writes are yours;
- `--cap-drop=ALL` and `--security-opt=no-new-privileges`;
- `--pids-limit` (default 4096) against fork bombs; memory/CPU caps opt-in;
- mounts only the project folder (same path) and `~/.claude-pod` (login, sessions, history);
- `--rm`: everything else the pod writes is discarded on exit;
- sets `CLAUDE_POD=1`, so scripts can detect the pod (e.g. skip `docker compose` inside it).

### What is and isn't isolated

**Safe from Claude:** everything outside the project folder (`~/.ssh`, `~/.aws`, shell rc files, browser data, other projects) and the host shell. Symlinks pointing outside the project appear broken inside the pod.

**Still exposed:**
- **The project folder.** `.env`, `.git/config`, stray keys, `node_modules` — readable and writable. Don't run `claude-pod` in a folder whose contents you wouldn't let the AI (or a malicious dependency it installs) see and modify.
- **The network.** Outbound is open by default. `NET=none` (or `"network": "none"`) cuts it entirely — but that also takes Claude offline, so it's for inspecting untrusted code, not for a live session.
- **Your pod login** in `~/.claude-pod/` (owner-only permissions, separate from your host `~/.claude`).

> **Hardlinks are different.** A hardlink inside the project to a sensitive file elsewhere on the same filesystem is reachable through the bind mount. It only matters for projects from untrusted sources — treat those as you would running their code directly.

### Environment overrides

```sh
NET=none claude-pod            # no networking at all
MEMORY=4g CPUS=2 claude-pod    # cap memory/CPU for untrusted builds
PIDS=512 claude-pod            # lower the process cap
```

These override `claude-pod.config.json`.

### Side effects outside the project folder

- `~/.claude-pod/` — pod login, settings, per-project session history, and the transient `refresh.lock`.
- The `claude-pod` Docker image (~700 MB), the `node:24-slim` base, and build cache.
- The global `claude-pod` command (a symlink created by `npm install -g`).
- While running: one container per pod, and published ports on `127.0.0.1`.

No `sudo`, no writes to your existing `~/.claude/`, shell rc files, or system paths.

## Reference

### Platforms

- **macOS** with Docker Desktop, OrbStack or Colima — primary target.
- **Linux** with Docker Engine or Desktop.
- **Windows** via WSL2 only.

Running as root on the host makes Claude refuse `--dangerously-skip-permissions` (the pod runs as your user) — use a regular user.

### Uninstall

```sh
claude-pod uninstall        # image + ~/.claude-pod, after confirmation
npm uninstall -g claude-pod # the command itself
```

### Development

```sh
npm test    # node:test; uses a fake docker, no daemon needed
```

### License and trademarks

MIT — see [`LICENSE`](LICENSE).

Claude Code is a separate product owned by Anthropic, PBC, and is **not** redistributed by this project — `claude-pod build` fetches it from npm at build time. This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, referenced here nominatively.
