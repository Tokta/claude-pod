# claude-pod

> Docker sandbox for the Claude Code CLI. Runs Claude against one project folder — built for unattended `--dangerously-skip-permissions` runs — while your home directory, SSH keys, and other projects stay invisible to the container. Unofficial.

![claude-pod](assets/cover.jpeg)

## TL;DR

`claude-pod` is a small CLI (command-line interface) that starts Claude Code inside a Docker container mounting only the project you run it from. Claude can read and edit that project; the rest of your machine isn't mounted, so the container can't see it. It's designed for leaving agents running while you're away: the pod is treated as hostile, and nothing it writes is trusted by the host afterwards.

```sh
# Once per machine
git clone <this repo> ~/Documents/GitHub/claude-pod
npm install -g ~/Documents/GitHub/claude-pod   # links the `claude-pod` command (not published anywhere)
claude-pod build                               # build the Docker image
claude setup-token                             # on the host: create a long-lived login token
claude-pod auth                                # paste it

# In any project (a git repo)
cd ~/projects/your-project
claude-pod                                     # bash shell in the pod
claude-pod claude                              # interactive Claude in the pod
claude-pod run --model opus --prompt-file /tmp/task.md --out /tmp/task   # headless agent run
```

Setting a project up (Docker network, ports, env, agent permissions)? See **[INTEGRATION.md](INTEGRATION.md)**.

## Contents

- [Install](#install)
- [Commands](#commands)
- [Project root and config](#project-root-and-config)
- [Ports](#ports)
- [Login](#login)
- [Running several pods](#running-several-pods)
- [Updating or pinning Claude Code](#updating-or-pinning-claude-code)
- [Security model](#security-model)
- [Reference](#reference)

## Install

Requirements: **Docker** (Desktop, OrbStack, Colima or Engine), **Node.js 20+**, and a Claude subscription (for `claude setup-token`).

```sh
npm install -g /path/to/claude-pod    # or: cd /path/to/claude-pod && npm link
claude-pod build
claude setup-token && claude-pod auth
claude-pod doctor                     # checks everything
```

`npm install -g <folder>` symlinks the folder, so a `git pull` in the clone updates the command immediately. The package is marked `private`, so it can't be published by accident. When the Dockerfile changes, launches warn you to re-run `claude-pod build`.

## Commands

| Command | What it does |
|---|---|
| `claude-pod` / `claude-pod shell` | bash shell in the pod |
| `claude-pod claude [args…]` | Claude in the pod; args passed through unchanged |
| `claude-pod exec <cmd> [args…]` | any command in the pod, e.g. `claude-pod exec pnpm test` |
| `claude-pod run …` | headless Claude task with `--print --dangerously-skip-permissions` (below) |
| `claude-pod build [--claude-version V]` | build or rebuild the image |
| `claude-pod auth [--from-env] [--remove]` | store the login token from `claude setup-token` |
| `claude-pod init` | create (and trust) `claude-pod.config.json` for the current project |
| `claude-pod trust` | review and approve a new or changed `claude-pod.config.json` |
| `claude-pod ps [--all]` / `claude-pod stop [NAME…] [--all]` | list / stop running pods |
| `claude-pod guide` | briefing for AI agents (how to delegate, read results, handle errors) + status of this project; read-only |
| `claude-pod doctor` | check Docker, image, login and project config |
| `claude-pod uninstall [--yes]` | remove the image and all claude-pod state |

Every command has `--help`. Launcher messages go to **stderr**, so stdout carries only what runs in the pod.

### `claude-pod run`

One command, no shell plumbing — designed for agents that orchestrate other agents:

```sh
claude-pod run --model opus --prompt-file /abs/scratchpad/step-6b1.md --out /abs/scratchpad/impl-6b1
```

- Runs `claude --print --dangerously-skip-permissions --output-format text [--model …]` in a fresh pod.
- Feeds the prompt on stdin — no `"$(cat …)"`, nothing in the host's process list.
- With `--out BASE`: writes `BASE.out`, `BASE.err`, `BASE.exit`, then prints `exit=<code>`. Without it, streams to stdout/stderr.
- Exits with Claude's exit code.
- `--prompt TEXT` for short prompts, `--output-format json`, `--ports` to publish the config's ports; anything after `--` goes to `claude` verbatim.
- `--prompt-file` and `--out` must be in the system temp dir, `/tmp`, `/var/tmp` (agent scratchpads live there) or a `runDirs` entry of `~/.config/claude-pod/settings.json`. `--prompt-file` may also be in the project; `--out` may not.

Because it's a single plain command, one permission rule covers every way an agent calls it — see [INTEGRATION.md](INTEGRATION.md#2-agent-permissions).

## Project root and config

The folder mounted into the pod is found the way git finds `.git`, so launching from a subfolder or after a `cd` gives the same result:

1. the nearest folder (walking up) containing `claude-pod.config.json`;
2. else the nearest git root.

It must be a project: claude-pod refuses `/`, your home directory, anything containing your home directory, folders that look like a home (`.ssh`, `.aws`, `.gnupg`), and folders with neither `.git` nor a config. It's mounted at its **real path**, so file paths in logs and stack traces match between host and pod.

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
| `network` | Docker **bridge** network to join so the pod reaches services by name (`postgres:5432`). `"none"` cuts all networking. `host`, `container:…` and non-bridge drivers are refused. |
| `ports` | Container ports to publish on **free** `127.0.0.1` host ports (see [Ports](#ports)). |
| `envFile` | `.env`-style file **inside the project** whose values can be used as `${VAR}` in `env`. |
| `env` | Extra environment for the pod. `${VAR}` comes from `envFile` only — never from your host environment. Unset variables are an error; `$$` is a literal `$`. |
| `resources` | `pids` (default 4096), `memory`, `cpus`. |

**The config must be approved.** The file lives in the project, which pods can write — so claude-pod only uses a config whose exact content you've approved. `init` approves what it creates; after any edit (yours or a pod's), run `claude-pod trust` to review and approve it. Interactive launches ask; unattended ones (`run` from an agent, no terminal) refuse to start. Approvals live in `~/.config/claude-pod/trust/`, which no pod can reach.

## Ports

Each port in `ports` is published on a free host port chosen at launch, bound to `127.0.0.1` only:

```
● claude-pod claude-pod-my-app-3f9a1c
  port 3000 → http://127.0.0.1:52341
  port 3131 → http://127.0.0.1:52342
```

Inside the pod, `CLAUDE_POD_PORT_3000=52341` etc. tell your app its host-side URL. There are no clashes with a dev server on your host or with other pods. `shell`, `claude` and `exec` publish ports; `run` doesn't unless you pass `--ports`. `claude-pod ps` shows the mappings.

> **Bind dev servers to `0.0.0.0` inside the pod**, not `localhost` (e.g. `"HOST": "0.0.0.0"` in `env`, `vite --host`, `next dev -H 0.0.0.0`). The host side stays `127.0.0.1`-only, so this doesn't expose anything to your LAN.

## Login

The in-pod `/login` browser flow doesn't work (the OAuth redirect is rejected), so pods use a **long-lived token**:

```sh
claude setup-token     # on the host; opens the browser, prints a token (needs a Claude subscription)
claude-pod auth        # paste it (hidden input), or: claude-pod auth < token.txt
```

This is a login for **your Claude subscription** (Pro/Max), the same plan you use on the host: usage counts against your plan's limits, and nothing is billed as API usage. It's an OAuth token (`sk-ant-oat…`), not an API key (`sk-ant-api…`).

Where it lives and who can see it:

- **The token file** is `~/.config/claude-pod/oauth-token` (mode 0600), in a folder that is never mounted into any pod. A pod can't read, change or replace that file.
- **The token itself** is handed to each pod as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable (through a private env-file, not the command line), because Claude inside the pod needs it to log in. So **anything running in the pod can read it** (`echo $CLAUDE_CODE_OAUTH_TOKEN`) and, with the network open, send it elsewhere — treat it like a password to your Claude plan. If you suspect a pod misbehaved, create a new one with `claude setup-token` and run `claude-pod auth`.

It doesn't refresh or rotate, so parallel pods can't log each other out — no shared credentials file, no refresh races.

## Running several pods

Pods are independent: unique names (`claude-pod-<project>-<id>`), free ports, per-project state, and a token that doesn't rotate. `claude-pod ps` lists them; `claude-pod stop` stops the current project's pods (or `--all`, or by name). If a launcher is killed (even with `kill -9`), a small watchdog stops its pod within seconds.

Pods of the **same project** share its working tree and `.git`, so parallel agents committing in one repo can collide. Per-pod git worktrees are planned for v2.

## Updating or pinning Claude Code

```sh
claude-pod build                          # refetch the latest Claude Code
claude-pod build --claude-version 2.0.0   # pin (also: CLAUDE_CODE_VERSION=2.0.0)
```

The image is intentionally minimal: `node:24-slim` + `git` + `curl` + `less` + `jq` + `gh` + `pnpm` (pinned) + Claude Code. Add toolchains your projects need by editing the `Dockerfile` and re-running `claude-pod build`. `build` records the image ID; launches refuse a `claude-pod` tag that points at any other image.

## Security model

The pod is treated as hostile: assume the agent inside was prompt-injected. Two rules follow — the pod can't reach beyond the project, and **nothing the pod writes is trusted by the host later**.

### What a pod gets

One `docker run` (see `buildRunArgs` in [`src/docker.js`](src/docker.js)):

- the project folder, read-write, at its real path — **except** the files below, which are read-only;
- its own project's state dir `~/.claude-pod/pods/<project>/` (sessions, Claude settings) — never another project's;
- the login token and config env through a private env-file (not on the command line, not in the docker client's environment);
- your user's uid (`--user`), `--cap-drop=ALL`, `no-new-privileges`, `--pids-limit`, `--init`, optional memory/CPU caps;
- outbound network (or none), and only the ports you configured, on `127.0.0.1`.

### Project files that would run on your host

Some project files are executed or loaded by tools on your host later. A pod must not be able to plant them:

| Path | Why | Protection |
|---|---|---|
| `.git/hooks/` | run by git on commit/push | read-only (created if missing) |
| `.git/config` | `core.fsmonitor` runs on `git status`; hooksPath, filters, aliases | read-only |
| `.claude/` | settings, hooks, agents of the Claude session orchestrating from the host | read-only (created if missing) |
| `.mcp.json` | MCP servers started by host Claude | read-only if present, quarantined if a pod creates it |
| `.envrc` | run by direnv on `cd` | read-only if present, quarantined if created |
| `.vscode/`, `.idea/` | editor tasks and settings | read-only if present, quarantined if created |
| `.git` itself | could be swapped for a fresh repo with its own hooks | mounted as its own mount point, so it can't be moved or replaced |
| `.git/commondir` | redirects where git reads config and hooks | pod refuses to start if present; quarantined if created |
| `.git` (in a non-git project) | a new repo with hooks | quarantined if created |

"Quarantined" means renamed to `<name>.claude-pod-quarantine-<timestamp>` after the run, with a warning. If any of these paths is a symlink, or resolves outside the project, the pod doesn't start: something planted it.

Git inside the pod still works for commits (identity comes from your global `user.name`/`user.email`), but `git config` writes to the repo fail — use `git -c key=value …` for one-off settings.

### What is still exposed

- **Everything else in the project**, read-write: source, `.env`, `package.json` scripts, `Makefile`, test configs, nested folders. **Review the diff before running project scripts on your host** (`npm test`, `make`, …) — a hostile pod can put anything in them.
- **Git beyond the top-level hooks and config.** The pod can write the git index and create nested repositories in subfolders (which the index can register as submodules), and host git reads their settings too. After an unattended run, inspect with hooks and fsmonitor off until you've reviewed the changes — see [After an unattended run](INTEGRATION.md#after-an-unattended-run).
- **The network.** Outbound is open by default, so a pod can send the project (and the login token) anywhere. `"network": "none"` or `NET=none` cuts it, but also takes Claude offline.
- **The login token** — see [Login](#login).
- **This project's pod history** in `~/.claude-pod/pods/<project>/`: a pod can read and alter its own project's past sessions and Claude settings.
- **Hardlinks.** A hardlink inside the project to a file elsewhere on the same filesystem is reachable through the mount. It only matters for projects from untrusted sources.

### What you shouldn't allow an orchestrator

Auto-approve only `Bash(claude-pod run:*)` and the read-only `Bash(claude-pod guide:*)`. `claude-pod trust`, `auth`, `uninstall`, `stop` and plain `claude-pod` should stay behind a prompt: `trust` deliberately needs a terminal, and there's no `--yes`.

### Environment overrides

```sh
NET=none claude-pod            # no networking at all
MEMORY=4g CPUS=2 claude-pod    # cap memory/CPU for untrusted builds
PIDS=512 claude-pod            # lower the process cap
```

### Side effects outside the project folder

- `~/.config/claude-pod/` — host-only: login token, config approvals, built image ID, settings, and short-lived private run files.
- `~/.claude-pod/pods/` — one Claude state dir per project (sessions, settings).
- The `claude-pod` Docker image (~700 MB), the `node:24-slim` base, and build cache.
- The global `claude-pod` command (a symlink created by `npm install -g`).
- In the project: an empty `.claude/` and `.git/hooks/` if they were missing, and any quarantined files.
- While running: one container per pod, one watchdog process, and published ports on `127.0.0.1`.

No `sudo`, no writes to your existing `~/.claude/`, shell rc files, or system paths.

## Reference

### Platforms

- **macOS** with Docker Desktop, OrbStack or Colima — primary target.
- **Linux** with Docker Engine or Desktop.
- **Windows** via WSL2 only.

Running as root on the host makes Claude refuse `--dangerously-skip-permissions` (the pod runs as your user) — use a regular user.

### Upgrading from the shared-state version

Earlier versions kept one shared `~/.claude-pod` (a copied OAuth login, history for all projects) and trusted configs blindly. After upgrading: `claude-pod build`, `claude setup-token` + `claude-pod auth` (this deletes the old copied login), and `claude-pod trust` in each project with a config. `claude-pod doctor` points at leftover old state you can delete.

### Uninstall

```sh
claude-pod uninstall        # image + ~/.claude-pod + ~/.config/claude-pod, after confirmation
npm uninstall -g claude-pod # the command itself
```

### Development

```sh
npm test    # node:test; uses a fake docker, no daemon needed
```

### License and trademarks

MIT — see [`LICENSE`](LICENSE).

Claude Code is a separate product owned by Anthropic, PBC, and is **not** redistributed by this project — `claude-pod build` fetches it from npm at build time. This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, referenced here nominatively.
