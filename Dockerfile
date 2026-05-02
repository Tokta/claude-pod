FROM node:lts-slim

# git/curl/less are baseline dev tools; jq and gh are reached for by Claude's built-in workflows
# (JSON pipelines and the GitHub CLI for PRs/issues/releases). ca-certificates is needed for HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl less jq gh \
 && rm -rf /var/lib/apt/lists/*

# CACHEBUST is passed from install.sh as the current timestamp.
# This invalidates the cache from this line onward, forcing Docker to always
# fetch the latest version of claude-code without rebuilding the slow apt-get layer.
ARG CACHEBUST=1
RUN npm install -g @anthropic-ai/claude-code

# Run as non-root so a process inside the container can't write to system paths even if it tries.
USER node

CMD ["bash"]
