#!/usr/bin/env bash
# Per-project launcher for claude-pod. Copy into <your-project>/scripts/ and edit the CONFIG block.
#
# Runs Claude Code (or a shell) inside the claude-pod sandbox, bind-mounted on your project at its
# real path, optionally attached to your app's Docker network with extra env injected. The same
# absolute path on host and pod keeps file references (logs, stack traces) consistent.
#
# Usage:
#   ./scripts/claude-pod.sh                                          # shell in the pod
#   ./scripts/claude-pod.sh claude --dangerously-skip-permissions    # Claude, no approval prompts
#   ./scripts/claude-pod.sh claude --dangerously-skip-permissions --model opus "<prompt>"
#
# Prerequisites:
#   - The `claude-pod` image is built (run install.sh in the claude-pod repo).
#   - If NETWORK is set, that Docker network exists (start your stack first).

set -euo pipefail

BOLD=$'\e[1m'; RED=$'\e[31m'; RESET=$'\e[0m'; [[ -t 1 ]] || { BOLD=; RED=; RESET=; }
die() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ─────────────────────────── CONFIG — edit for your project ───────────────────────────
# Docker network your app's services run on, so the pod can reach them by service name
# (e.g. postgres:5432). Usually "<docker-compose-project>_default" — find it with `docker network ls`.
# Leave empty to skip attaching to any network.
NETWORK=""

# Ports to publish from the pod to 127.0.0.1 (space-separated), e.g. "3000 8080".
# Needed only if you want to reach a dev server the pod runs. Leave empty for none.
EXPOSE_PORTS=""

# Extra environment to inject into the pod. Common case: a DB URL pointing at the service name
# on NETWORK (note: host .env values using "localhost" won't resolve inside the pod). Example:
#   PGPASS="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
#   EXTRA_ENV+=(-e "DATABASE_URL=postgresql://app:${PGPASS}@postgres:5432/appdb")
EXTRA_ENV=()
# ──────────────────────────────────────────────────────────────────────────────────────

command -v docker >/dev/null || die "Docker is required but not on PATH."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."
[ -n "$(docker image ls -q claude-pod 2>/dev/null)" ] \
  || die "Image 'claude-pod' not found. Run ${BOLD}install.sh${RESET} in the claude-pod repo."
if [ -n "$NETWORK" ]; then
  docker network inspect "$NETWORK" >/dev/null 2>&1 \
    || die "Docker network '$NETWORK' not found. Start your app's stack first (e.g. docker compose up -d)."
fi

# Pod state dir: persists Claude's auth + history across runs. Seed the login file (Claude treats
# an empty file as a parse error, and Docker would create a dir if the source path were missing).
mkdir -p "$HOME/.claude-pod"; chmod 700 "$HOME/.claude-pod"
[ -s "$HOME/.claude-pod/.claude.json" ] || printf '{}' > "$HOME/.claude-pod/.claude.json"
chmod 600 "$HOME/.claude-pod/.claude.json"

FLAGS=(--rm)
[ -t 0 ] && FLAGS+=(-i)
[ -t 1 ] && FLAGS+=(-t)
for p in $EXPOSE_PORTS; do FLAGS+=(-p "127.0.0.1:${p}:${p}"); done
[ -n "$NETWORK" ] && FLAGS+=(--network "$NETWORK")
FLAGS+=(--pids-limit="${PIDS:-4096}")
[ -n "${MEMORY:-}" ] && FLAGS+=(--memory="$MEMORY")
[ -n "${CPUS:-}" ]   && FLAGS+=(--cpus="$CPUS")

# Hardening: drop all caps + no-new-privileges; run as the host user so file ownership matches.
# CLAUDE_POD=1 lets a shared dev script detect the pod (e.g. skip `docker compose` inside it).
exec docker run "${FLAGS[@]}" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/claude-pod \
  -e CLAUDE_POD=1 \
  "${EXTRA_ENV[@]}" \
  -v "$PROJECT_ROOT:$PROJECT_ROOT" \
  -w "$PROJECT_ROOT" \
  -v "$HOME/.claude-pod:/home/claude-pod/.claude" \
  -v "$HOME/.claude-pod/.claude.json:/home/claude-pod/.claude.json" \
  claude-pod "$@"
