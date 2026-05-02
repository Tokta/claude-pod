#!/usr/bin/env bash
set -euo pipefail

# ANSI color codes; auto-disabled when stdout isn't a TTY (e.g. piped to a logfile, run in CI).
BOLD=$'\e[1m'; BLUE=$'\e[34m'; GREEN=$'\e[32m'; RED=$'\e[31m'; DIM=$'\e[2m'; RESET=$'\e[0m'
[[ -t 1 ]] || { BOLD=; BLUE=; GREEN=; RED=; DIM=; RESET=; }
info() { printf '%s●%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s✓%s %s\n'       "$GREEN" "$RESET" "$*"; }
err()  { printf '%s✗%s %s\n'       "$RED"   "$RESET" "$*" >&2; }
# `trap - ERR` disarms the ERR trap below so the explicit `exit 1` doesn't double-report.
die()  { err "$*"; trap - ERR; exit 1; }
trap 'err "install.sh failed at line $LINENO"' ERR

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="claude-pod"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"

command -v docker >/dev/null || die "Docker is required but not on PATH."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."

# For pinned versions, the version literal in the Dockerfile RUN line is itself the cache key,
# so the layer rebuilds whenever the pin changes — no extra invalidator needed.
# For "latest", the literal never changes, so we pass CACHEBUST=$(date +%s) to force a refetch.
BUILD_ARGS=("--build-arg" "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION")
if [ "$CLAUDE_CODE_VERSION" = "latest" ]; then
  BUILD_ARGS+=("--build-arg" "CACHEBUST=$(date +%s)")
fi

info "Preflight"
printf '  %sdocker:        %s %s\n' "$DIM" "$RESET" "$(docker --version)"
printf '  %srepo:          %s %s\n' "$DIM" "$RESET" "$REPO_DIR"
printf '  %simage:         %s %s\n' "$DIM" "$RESET" "$IMAGE"
printf '  %sclaude-code:   %s %s\n' "$DIM" "$RESET" "$CLAUDE_CODE_VERSION"
echo

info "Building image '$IMAGE'"
# Stream the build output dimmed and indented. `--progress=plain` disables BuildKit's animated
# TUI (which can't be re-styled externally); the sed strips Docker's own ANSI codes so they don't
# cancel our dim formatting; the while-read prefixes each line with dim + 2-space indent.
docker build \
  --progress=plain \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE" "$REPO_DIR" 2>&1 \
  | sed $'s/\e\\[[0-9;]*m//g' \
  | while IFS= read -r line; do printf '%s  %s%s\n' "$DIM" "$line" "$RESET"; done
ok "Image '$IMAGE' built"
echo

info "Installed"
# `claude --version` prints the resolved npm version. Wrapped in if/else so a failure here
# (e.g. claude binary unexpectedly broken) is reported but doesn't abort the script via the ERR trap.
if RESOLVED_VERSION="$(docker run --rm "$IMAGE" claude --version 2>&1)"; then
  printf '  %sclaude-code:   %s %s\n' "$DIM" "$RESET" "$RESOLVED_VERSION"
else
  err "Could not determine Claude Code version (build succeeded; 'claude --version' failed)"
fi
echo

info "Next steps"
printf '  cd into your work-in-progress project folder first, then:\n'
printf '    Open shell in pod:        %s%s/claude-pod%s\n' "$BOLD" "$REPO_DIR" "$RESET"
printf '    Or run Claude directly:   %s%s/claude-pod claude --dangerously-skip-permissions%s\n' "$BOLD" "$REPO_DIR" "$RESET"
printf '    Optional shell alias:     %salias claude-pod=%s/claude-pod%s\n' "$BOLD" "$REPO_DIR" "$RESET"
