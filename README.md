# claude-pod

> Unofficial Docker sandbox for Anthropic's Claude Code CLI. Use `--dangerously-skip-permissions` safely — Claude only sees the project folder you launched from.

![claude-pod](assets/cover.jpeg)

## Install & run

```sh
# Clone the repo
git clone https://github.com/trekhleb/claude-pod.git ~/tools/claude-pod

# Install claude-pod CLI (builds Docker image)
cd ~/tools/claude-pod && ./install.sh

# Open your project folder and launch claude code inside container
# cd ~/projects/my-work-in-progress-project
~/tools/claude-pod/claude-pod claude --dangerously-skip-permissions
```

Docker is the only requirement. The install path (`~/tools/claude-pod`) is just a convention — put it wherever you want.

**The outcome:** You can run Claude Code in auto-approval mode without exposing your whole machine. `claude-pod` launches Claude inside a Docker container with only your current project folder mounted, so Claude can read and edit that project, but not your home directory, SSH keys, other projects, or host shell. This turns the main risk from “Claude can touch my machine” into “Claude can touch this project folder.” Read more about [what is and isn't isolated](#what-is-and-isnt-isolated).

Prefer the official approach? See Anthropic's [Claude Code sandboxing documentation](https://code.claude.com/docs/en/sandboxing).

## Requirements

**Just Docker.** 

Claude Code runs inside the container, not on your host — you do not need Node.js, npm, or the `claude` CLI installed on your machine. The host stays untouched apart from one state folder (`~/.claude-pod/`) that exists only to keep your login across container restarts.

## What it actually does

The whole tool is four tiny files:

- **`Dockerfile`** — `node:24-slim` + `git` + `curl` + `less` + `jq` + `gh` + `@anthropic-ai/claude-code`.
- **`claude-pod`** — one `docker run` command that mounts your current directory and nothing else.
- **`install.sh`** — checks Docker and builds the image. Doesn't touch any system path; the tool stays self-contained in this folder.
- **`uninstall.sh`** — removes the image and `~/.claude-pod/` (auth + session history) after confirmation. Lists what it doesn't touch so you can clean those up yourself.

## First launch (login)

The first time you start Claude inside the pod, it will print a login URL. Open it in your host browser, complete the login, paste the verification code back into the container, and you're done. The session persists in `~/.claude-pod/` and survives container restarts — you only do this once per machine.

## Usage

Call the script by full or relative path from any project:

```sh
cd ~/Projects/anything
~/tools/claude-pod/claude-pod
```

You land in a bash shell at the same path your project lives at on the host (e.g. `/Users/you/Projects/anything`), with `claude` on `PATH`. Run it however you like:

```sh
claude --dangerously-skip-permissions
```

Alternatively, you may skip the shell and go straight into Claude. Anything you pass to `claude-pod` is run inside the container instead of bash. So this drops you directly into Claude in one command, and exits the container when Claude exits:

```sh
~/tools/claude-pod/claude-pod claude --dangerously-skip-permissions
```

To exit, type `exit`.

**Aliases**

```sh
alias claude-pod=~/tools/claude-pod/claude-pod                                  # shell first
alias cc='~/tools/claude-pod/claude-pod claude --dangerously-skip-permissions'  # claude directly
```

The shell-first form is more flexible (run `npm install`, dev server, tests, then `claude`), so it stays the default.

## Exposing ports

By default, `claude-pod` doesn't publish any ports to the host (outbound traffic is still unrestricted — see [What is and isn't isolated](#what-is-and-isnt-isolated)). Map ports through with the `PORTS` environment variable:

```sh
# Map a single port (127.0.0.1:3000 -> container:3000)
PORTS=3000 claude-pod

# Map multiple ports
PORTS="3000 5173" claude-pod

# Map a specific host port to a different container port
PORTS="8080:80" claude-pod
```

## Updating or pinning the Claude Code version

By default, `install.sh` fetches whatever's currently `latest` on npm, bypassing Docker's cache for that step. To update, just re-run:

```sh
cd ~/tools/claude-pod
./install.sh
```

To pin a specific version, set `CLAUDE_CODE_VERSION`:

```sh
CLAUDE_CODE_VERSION=2.0.0 ./install.sh
```

Pinned versions cache normally across rebuilds. The script prints the resolved version after each build, so you always know what you got.

## What is and isn't isolated

**Safe from Claude:**
- Everything outside the project folder you launched from. `~/.ssh`, `~/.aws`, `~/.zshrc`, browser data, other projects — all unreachable.
- The host shell. No way to execute commands on your host machine.

**Still exposed:**
- **The project folder itself.** Anything inside it — `.env`, `.git/config` (which can carry credentials for private remotes), private keys committed by mistake, `node_modules`, sibling worktrees, scratch files — is fully readable *and* writable by code running in the container. Don't run `claude-pod` from a folder whose contents you wouldn't trust the AI (or a malicious dependency it just installed) to see and modify.
- **The network.** Outbound is unrestricted. A malicious payload could exfiltrate the project contents or burn your Anthropic API quota.
- **Your Anthropic login** (stored in `~/.claude-pod/` on the host, separate from any host Claude install, shared across sandboxed projects).

**Where Claude can actually write** — two paths, both intentional bind mounts:
- The project folder, bind-mounted at the same path inside the container (`$PWD:$PWD`). Edits land on your host's disk directly, no copy.
- `~/.claude-pod/` on the host, mounted at `/home/claude-pod/.claude`. Holds the auth token and session history.

> [!WARNING]
> Because the current directory (`$PWD`) is mounted into the container, **never run this tool from your root directory (`/`) or `/etc`**. If you run it from the root of your hard drive, you are giving the AI access to your entire machine, defeating the purpose of the sandbox. Always `cd` into your specific project folder first.

Everywhere else Claude writes is either in the container's ephemeral filesystem (discarded on exit thanks to `--rm`) or simply has no path to land at — the Linux kernel's mount namespace makes any other host directory invisible to the container. Symlinks inside the project folder pointing to `~/.ssh` or `/etc/passwd` appear broken for the same reason: those targets aren't mounted, so the container can't see them.

> [!NOTE]
> **Hardlinks are different.** A hardlink is a second name for an existing inode on the same filesystem. If a file inside your project folder is hardlinked to a sensitive file elsewhere on the same filesystem (e.g., `~/.ssh/id_rsa`), the container *can* reach it through the hardlink — the bind-mount exposes the inode, not just the path. This requires the hardlink to already exist in the project folder, so it's a real concern only when you're inspecting code from an untrusted source. Treat unfamiliar projects with the same caution you'd apply to running their code directly: don't run `claude-pod` inside a folder you don't trust.

The tradeoff: the worst case becomes "something bad happens to one project folder," which is recoverable from git, instead of "my entire home directory is exposed."

<details>
<summary><strong>Customizing the image</strong> (Python, Rust, port mapping examples)</summary>

The image is intentionally minimal: `node:24-slim` + `git` + `curl` + `less` + `jq` + `gh` + Claude Code. Nothing language-specific. Anything your projects need (Python, build tools, other toolchains) you add yourself — edit the `Dockerfile` and re-run `./install.sh`.

### Notes

> The wrapper is a transparent passthrough — there is no `claude-pod --help` or `claude-pod --version` of its own. Those flags would just be forwarded to `bash` inside the container. For Claude's own flags use `claude-pod claude --help` / `claude-pod claude --version`.

> If your project has a host-built `node_modules`, delete it and reinstall inside the container — native binaries don't cross from host OS to container Linux.

### Python

Edit the `apt-get install` line in `Dockerfile`:

```dockerfile
... git ca-certificates curl less python3 python3-pip python3-venv ...
```

### Native compilation (e.g. `bcrypt`, `node-gyp`, Python C extensions)

```dockerfile
... git ca-certificates curl less build-essential ...
```

### Other language toolchains (Go, Rust, Java, etc.)

Add a separate `RUN` line below the `apt-get` block. Example for Rust:

```dockerfile
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
```

After any change, re-run `./install.sh` to rebuild.

</details>

<details>
<summary><strong>Side effects outside the project folder</strong></summary>

Everything this repo causes to exist outside the project you launch it from:

- `~/.claude-pod/` on your host — auth token, settings, and per-project session/conversation history (transcripts can include code snippets and command output Claude saw). Auth and settings are shared across projects (one login, ever); session history lives under `~/.claude-pod/projects/<encoded-host-path>/`, one folder per project, using the same encoding host-Claude uses — so if you ever switch to a host install, you can copy the folders over and keep your transcripts. This is *not* a host Claude install; it's a state directory for the container's Claude, kept on the host so it survives restarts.
- Docker image `claude-pod` (~600 MB) and its layers, plus the `node:24-slim` base image, in Docker's image store.
- Docker build cache from `apt-get` and `npm install` steps.
- Outbound network during build: Docker Hub, Debian apt mirrors, npm registry. During runtime: `api.anthropic.com` and whatever your project code reaches (network is unrestricted).
- While a session is running: one container process, and any ports you explicitly mapped via `PORTS` bound on `127.0.0.1`.

No `sudo`, no writes to `/usr/local/`, `/etc/`, `~/.zshrc`, `~/Library/`, your existing `~/.claude/`, or anywhere else on the host.

</details>

## Uninstall

```sh
./uninstall.sh
```

Removes `~/.claude-pod/` and the `claude-pod` image after confirmation. Tells you exactly what it isn't touching (`node:24-slim`, build cache, this repo) and how to clean those up yourself.

If you added a shell alias for convenience (e.g. `alias claude-pod=...` or `alias cc=...` in `~/.zshrc` / `~/.bashrc`), remove that line too — `uninstall.sh` doesn't touch your shell rc files.

## Platforms

The wrapper is portable POSIX bash + Docker. It should work on any host with a recent Docker:

- **macOS** (Apple Silicon and Intel) with Docker Desktop, OrbStack, or Colima — primary development target.
- **Linux** with Docker Engine or Docker Desktop — bind mounts and `--user` UID/GID map directly here, the most native experience.
- **Windows + WSL2** with Docker Desktop's WSL2 backend — run `claude-pod` from inside a WSL distribution's bash shell.

**Native Windows** (`cmd.exe` / PowerShell) is not supported. The wrapper is a bash script and uses POSIX tools (`id`, etc.); use WSL2 instead.

If a platform doesn't behave as expected, please open an issue.

## License & trademarks

The code in this repository is released under the MIT License — see [`LICENSE`](LICENSE) for the full text.

Claude Code itself is a separate product owned by Anthropic, PBC, and is **not** redistributed by this project — `install.sh` fetches it from npm at build time. This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, referenced here nominatively. No Anthropic logos, wordmarks, or other brand assets are used.
