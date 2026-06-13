#!/usr/bin/env bash
# Seed the claude-pod sandbox with your host Claude Code login + skip the first-run wizard.
#
# Why this exists:
#   The in-container `/login` browser flow is broken (the OAuth client rejects the
#   container redirect URI), and the pod can't read the macOS Keychain where Claude Code
#   stores its credentials. So instead of logging in inside the pod, we export the host's
#   existing OAuth session to the file Claude Code reads on Linux:
#   ~/.claude-pod/.credentials.json (mounted into the pod at /home/claude-pod/.claude/).
#
#   It also pre-sets the onboarding flags so the pod skips the theme picker and the (broken)
#   login-method picker on first launch.
#
# Usage:
#   ./scripts/claude-pod-auth.sh           # export host Keychain creds into ~/.claude-pod
#   ./scripts/claude-pod-auth.sh --force   # overwrite even a newer pod token (see guard below)
#
# Prerequisites:
#   - macOS (credentials live in the login Keychain). Linux note: copy your
#     ~/.claude/.credentials.json into ~/.claude-pod/.credentials.json instead.
#   - You are logged in to Claude Code on the host (desktop app or CLI).

set -euo pipefail

BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
[[ -t 1 ]] || { BOLD=; GREEN=; YELLOW=; RED=; RESET=; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Keychain is macOS-only.
[ "$(uname -s)" = "Darwin" ] || die "macOS-only. On Linux, copy ~/.claude/.credentials.json into ~/.claude-pod/."
command -v security >/dev/null || die "'security' (macOS Keychain CLI) not found."
command -v node     >/dev/null || die "node is required (used to validate/seed JSON)."

KEYCHAIN_SERVICE="Claude Code-credentials"
POD_DIR="$HOME/.claude-pod"
DEST="$POD_DIR/.credentials.json"

# Read the OAuth blob from the Keychain. -w prints only the secret value (the JSON).
CREDS="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
  || die "No '$KEYCHAIN_SERVICE' entry in the Keychain. Log in to Claude Code on the host first."
[ -n "$CREDS" ] || die "Keychain entry '$KEYCHAIN_SERVICE' is empty."

# Sanity-check the shape before we write it, so a bad export fails here, not in the pod.
printf '%s' "$CREDS" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    let c; try { c=JSON.parse(s); } catch { console.error("not valid JSON"); process.exit(1); }
    if (!c.claudeAiOauth || !c.claudeAiOauth.refreshToken) { console.error("missing claudeAiOauth.refreshToken"); process.exit(1); }
  });
' || die "Keychain value is not the expected Claude credentials JSON."

# Rotation guard: once the pod is running, Claude Code refreshes its own access token and
# rotates the refresh token server-side — which invalidates the Keychain copy. Overwriting a
# newer pod token with the older Keychain one therefore breaks auth with a 401. So if the pod
# already holds a token newer than the Keychain's, refuse — unless --force (use that only right
# after a fresh host `/login`, when the Keychain is the authoritative copy).
if [ "$FORCE" -ne 1 ] && [ -f "$DEST" ]; then
  CMP="$(DEST_PATH="$DEST" KC="$CREDS" node -e '
    const fs=require("fs");
    const exp=s=>{try{return (JSON.parse(s).claudeAiOauth||{}).expiresAt||0;}catch{return 0;}};
    const kc=exp(process.env.KC);
    let pod=0; try{ pod=exp(fs.readFileSync(process.env.DEST_PATH,"utf8")); }catch{}
    process.stdout.write(pod>kc ? "pod-newer" : "ok");
  ')"
  if [ "$CMP" = "pod-newer" ]; then
    warn "Pod already holds a token newer than the Keychain's — not overwriting."
    warn "The pod self-refreshes; re-exporting a stale Keychain token is what causes 401s."
    die  "If you just did a fresh host ${BOLD}/login${RESET}, re-run with ${BOLD}--force${RESET}."
  fi
fi

# Pod state dir + login-file seed.
mkdir -p "$POD_DIR"
chmod 700 "$POD_DIR"
[ -s "$POD_DIR/.claude.json" ] || printf '{}' > "$POD_DIR/.claude.json"

# Skip the first-run onboarding wizard (theme + login-method picker). The login picker would
# otherwise trigger the broken in-container browser flow. These flags are global, not project-
# specific; existing keys are preserved.
CJ="$POD_DIR/.claude.json" node -e '
  const fs=require("fs"), p=process.env.CJ;
  let c={}; try{ c=JSON.parse(fs.readFileSync(p,"utf8")||"{}"); }catch{}
  c.hasCompletedOnboarding = true;
  if (!c.theme) c.theme = "dark";
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
'
chmod 600 "$POD_DIR/.claude.json"

# Write creds with a restrictive umask so the token is never briefly world-readable.
( umask 077; printf '%s' "$CREDS" > "$DEST" )
chmod 600 "$DEST"

# Report expiry (informational only — the refresh token is what matters).
EXPIRES="$(printf '%s' "$CREDS" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o=JSON.parse(s).claudeAiOauth||{};
    process.stdout.write(o.expiresAt ? new Date(o.expiresAt).toISOString() : "unknown");
  });
')"

ok "Pod credentials written to ${BOLD}$DEST${RESET}"
printf '  access token expires: %s (auto-refreshed by Claude Code on launch)\n' "$EXPIRES"
printf '  next: %s./scripts/claude-pod.sh claude --dangerously-skip-permissions "<prompt>"%s\n' "$BOLD" "$RESET"
