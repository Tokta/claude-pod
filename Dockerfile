# If you bump this tag, also update the literal in uninstall.sh.
FROM node:24-slim

# git/curl/less are baseline dev tools; jq and gh are reached for by Claude's built-in workflows
# (JSON pipelines and the GitHub CLI for PRs/issues/releases). ca-certificates is needed for HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl less jq gh \
 && rm -rf /var/lib/apt/lists/*

# Override at build time with --build-arg CLAUDE_CODE_VERSION=2.x.y to pin a specific
# version. Default "latest" tracks whatever's current on npm.
ARG CLAUDE_CODE_VERSION=latest

# When CLAUDE_CODE_VERSION=latest, install.sh passes CACHEBUST=$(date +%s) to force a fresh
# refetch (the literal "latest" alone wouldn't change the layer's cache key). For pinned
# versions, the version literal itself is the cache key, so install.sh skips CACHEBUST and
# this layer caches normally.
ARG CACHEBUST=1
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install pnpm via corepack (ships with Node; activating it avoids a separate npm install).
RUN corepack enable && corepack prepare pnpm@latest --activate

# We DO NOT use `USER node` here. Instead, we pass `--user "$(id -u):$(id -g)"` dynamically
# at runtime in the `claude-pod` script. This ensures perfect file permission alignment
# between the host and the container, especially on Linux environments.
# Create a dedicated, globally writable home directory for our dynamic runtime user.
RUN mkdir -p /home/claude-pod && chmod 777 /home/claude-pod

# Override the default bash prompt to hide the "I have no name!" warning for dynamic users.
RUN echo 'PS1="claude-pod:\w\$ "' >> /etc/bash.bashrc

CMD ["bash"]
