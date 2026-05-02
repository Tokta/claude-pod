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

command -v docker >/dev/null || die "Docker is required but not on PATH."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."

info "Preflight"
printf '  %sdocker:%s %s\n' "$DIM" "$RESET" "$(docker --version)"
printf '  %srepo:  %s %s\n' "$DIM" "$RESET" "$REPO_DIR"
printf '  %simage: %s %s\n' "$DIM" "$RESET" "$IMAGE"
echo

info "Building image '$IMAGE'"
# Stream the build output dimmed and indented. `--progress=plain` disables BuildKit's animated
# TUI (which can't be re-styled externally); the sed strips Docker's own ANSI codes so they don't
# cancel our dim formatting; the while-read prefixes each line with dim + 2-space indent.
# CACHEBUST=$(date +%s) forces Docker to skip cache for the Claude CLI npm installation step.
docker build --progress=plain --build-arg CACHEBUST="$(date +%s)" -t "$IMAGE" "$REPO_DIR" 2>&1 \
  | sed $'s/\e\\[[0-9;]*m//g' \
  | while IFS= read -r line; do printf '%s  %s%s\n' "$DIM" "$line" "$RESET"; done
ok "Image '$IMAGE' built"
echo

info "Next steps"
printf '  Open shell in pod:        %s%s/claude-pod%s\n' "$BOLD" "$REPO_DIR" "$RESET"
printf '  Or run Claude directly:   %s%s/claude-pod claude --dangerously-skip-permissions%s\n' "$BOLD" "$REPO_DIR" "$RESET"
printf '  Optional shell aliases: %s(add to ~/.zshrc or ~/.bashrc)%s\n' "$DIM" "$RESET"
printf '    %salias claude-pod=%s/claude-pod%s\n' "$BOLD" "$REPO_DIR" "$RESET"
printf '    %salias cpod='"'"'%s/claude-pod claude --dangerously-skip-permissions'"'"'%s\n' "$BOLD" "$REPO_DIR" "$RESET"
