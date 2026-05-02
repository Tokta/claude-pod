# claude-pod

Unofficial Docker sandbox for Anthropic's Claude Code CLI. Runs [Claude Code](https://github.com/anthropics/claude-code) inside a container so it can only see the project folder you launched it from. Lets you use `--dangerously-skip-permissions` (auto-approve) without putting the rest of your machine at risk.

> *This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, used here nominatively to refer to the underlying tool this project wraps. All trademarks are the property of their respective owners.*

## Requirements

**Just Docker.** Claude Code runs inside the container, not on your host — you do **not** need Node.js, npm, or the `claude` CLI installed on your machine. The host stays untouched apart from one state folder (`~/.claude-pod/`) that exists only to keep your login across container restarts.

## What it actually does

The whole tool is four tiny files:

- **`Dockerfile`** — `node:24-slim` + `git` + `curl` + `less` + `@anthropic-ai/claude-code`.
- **`claude-pod`** — one `docker run` command that mounts your current directory and nothing else.
- **`install.sh`** — checks Docker and builds the image. Doesn't touch any system path; the tool stays self-contained in this folder.
- **`uninstall.sh`** — removes the image and `~/.claude-pod/` (auth + session history) after confirmation. Lists what it doesn't touch so you can clean those up yourself.

Read them. They are short on purpose.

## Setup (one time)

```sh
git clone <this repo> ~/tools/claude-pod
cd ~/tools/claude-pod
./install.sh
```

That builds the `claude-pod` Docker image. Nothing else is installed on your system. Move or rename the folder anytime — only the image tag matters at runtime.

### Updating Claude Code

The `install.sh` script is designed to bypass Docker's cache when fetching the Anthropic CLI. To update to the absolute latest version of Claude Code at any time, simply re-run the install script:

```sh
cd ~/tools/claude-pod
./install.sh
```

## Usage

Call the script by full path from any project:

```sh
cd ~/Projects/anything
~/tools/claude-pod/claude-pod
```

Prefer something shorter? Add an alias to your shell rc file:

```sh
alias claude-pod=~/tools/claude-pod/claude-pod
```

You land in a bash shell at the same path your project lives at on the host (e.g. `/Users/you/Projects/anything`), with `claude` on `PATH`. Run it however you like:

```sh
claude --dangerously-skip-permissions
```

By default, the container network is fully isolated. If you want to expose a dev server to your host, pass the `PORTS` variable (e.g., `PORTS=3000 claude-pod`). To exit, type `exit`.

### Skip the shell, go straight into Claude

Anything you pass to `claude-pod` is run inside the container instead of bash. So this drops you directly into Claude in one command, and exits the container when Claude exits:

```sh
~/tools/claude-pod/claude-pod claude --dangerously-skip-permissions
```

Pair with aliases for whichever style you prefer:

```sh
alias cp=~/tools/claude-pod/claude-pod                                       # shell first
alias cc='~/tools/claude-pod/claude-pod claude --dangerously-skip-permissions'  # claude directly
```

The shell-first form is more flexible (run `npm install`, dev server, tests, then `claude`), so it stays the default.

### Piping Data (Standard Input)

Because `claude-pod` correctly handles TTY detection, you can seamlessly pipe files or command outputs directly into Claude just like a native CLI tool:

```sh
# Review a git diff (using the alias from above)
git diff | cc -p "Please review these changes for bugs"

# Analyze a log file
cat crash.log | cc -p "Why did the server crash?"
```

## What is and isn't isolated

**Safe from Claude:**
- Everything outside the project folder you launched from. `~/.ssh`, `~/.aws`, `~/.zshrc`, browser data, other projects — all unreachable.
- The host shell. No way to execute commands on your host machine.

**Still exposed:**
- The project folder itself, including any `.env` files in it.
- The network. Code in the container can reach the internet, so a malicious payload could exfiltrate the project contents or burn your Anthropic API quota.
- Your Anthropic login (stored in `~/.claude-pod/` on the host, separate from any host Claude install, shared across sandboxed projects).

**Where Claude can actually write** — two paths, both intentional bind mounts:
- The project folder, bind-mounted at the same path inside the container (`$PWD:$PWD`). Edits land on your host's disk directly, no copy.
- `~/.claude-pod/` on the host, mounted at `/home/claude-pod/.claude`. Holds the auth token and session history.

> [!WARNING]
> Because the current directory (`$PWD`) is mounted into the container, **never run this tool from your root directory (`/`) or `/etc`**. If you run it from the root of your hard drive, you are giving the AI access to your entire machine, defeating the purpose of the sandbox. Always `cd` into your specific project folder first.

Everywhere else Claude writes is either in the container's ephemeral filesystem (discarded on exit thanks to `--rm`) or simply has no path to land at — the Linux kernel's mount namespace makes any other host directory invisible to the container. Symlinks inside the project folder pointing to `~/.ssh` or `/etc/passwd` appear broken for the same reason: those targets aren't mounted, so the container can't see them.

The tradeoff: the worst case becomes "something bad happens to one project folder," which is recoverable from git, instead of "my entire home directory is exposed."

## Customizing

The image is intentionally minimal: `node:24-slim` + `git` + `curl` + `less` + Claude Code. Nothing language-specific. Anything your projects need (Python, build tools, other toolchains) you add yourself — edit the `Dockerfile` and re-run `./install.sh`.

**Exposing Ports**

By default, `claude-pod` isolates the container network to prevent collisions. You can map ports using the `PORTS` environment variable:

```sh
# Map a single port (127.0.0.1:3000 -> container:3000)
PORTS=3000 claude-pod

# Map multiple ports
PORTS="3000 5173" claude-pod

# Map a specific host port to a different container port
PORTS="8080:80" claude-pod
```

**Python**

Edit the `apt-get install` line in `Dockerfile`:

```dockerfile
... git ca-certificates curl less python3 python3-pip python3-venv ...
```

**Native compilation** (e.g. `bcrypt`, `node-gyp`, Python C extensions)

```dockerfile
... git ca-certificates curl less build-essential ...
```

**Other language toolchains** (Go, Rust, Java, etc.)

Add a separate `RUN` line below the `apt-get` block. Example for Rust:

```dockerfile
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
```

After any change, re-run `./install.sh` to rebuild.

## Side effects outside the project folder

Everything this repo causes to exist outside the project you launch it from:

- `~/.claude-pod/` on your host — auth token, settings, and per-project session/conversation history (transcripts can include code snippets and command output Claude saw). Auth and settings are shared across projects (one login, ever); session history lives under `~/.claude-pod/projects/<encoded-host-path>/`, one folder per project, using the same encoding host-Claude uses — so if you ever switch to a host install, you can copy the folders over and keep your transcripts. This is *not* a host Claude install; it's a state directory for the container's Claude, kept on the host so it survives restarts.
- Docker image `claude-pod` (~600 MB) and its layers, plus the `node:24-slim` base image, in Docker's image store.
- Docker build cache from `apt-get` and `npm install` steps.
- Outbound network during build: Docker Hub, Debian apt mirrors, npm registry. During runtime: `api.anthropic.com` and whatever your project code reaches (network is unrestricted).
- While a session is running: one container process, and any ports you explicitly mapped via `PORTS` bound on `127.0.0.1`.

No `sudo`, no writes to `/usr/local/`, `/etc/`, `~/.zshrc`, `~/Library/`, your existing `~/.claude/`, or anywhere else on the host.

## Uninstall

```sh
./uninstall.sh
```

Removes `~/.claude-pod/` and the `claude-pod` image after confirmation. Tells you exactly what it isn't touching (`node:24-slim`, build cache, this repo) and how to clean those up yourself.

## Notes

- If your project has a host-built `node_modules`, delete it and reinstall inside the container — native binaries don't cross from host OS to container Linux.
- First launch of `claude` will print a login URL. Open it in your host browser, paste back the code; the session persists in `~/.claude-pod/` for next time.

## License & trademarks

The code in this repository is released under the MIT License — see [`LICENSE`](LICENSE) for the full text.

Claude Code itself is a separate product owned by Anthropic, PBC, and is **not** redistributed by this project — `install.sh` fetches it from npm at build time. This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, referenced here nominatively. No Anthropic logos, wordmarks, or other brand assets are used.
