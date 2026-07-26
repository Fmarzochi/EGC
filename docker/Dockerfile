# --- Build stage: install dependencies and compile the MCP servers ---
FROM node:24-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169 AS builder

WORKDIR /app

COPY package*.json ./
COPY scripts/preinstall.js scripts/preinstall.js
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage: minimal image that runs as a non-root user ---
FROM node:24-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169 AS runtime

WORKDIR /app

# Install the mcp-proxy launcher into the runtime image.
COPY docker/package.json docker/package-lock.json /tmp/mcp-proxy-install/
RUN cd /tmp/mcp-proxy-install && npm ci --silent && \
    mkdir -p /usr/local/lib/node_modules && \
    cp -r node_modules/. /usr/local/lib/node_modules/ && \
    ln -sf /usr/local/lib/node_modules/mcp-proxy/dist/bin/mcp-proxy.mjs /usr/local/bin/mcp-proxy && \
    rm -rf /tmp/mcp-proxy-install

# Bring in the built application (dependencies + compiled MCP servers) from the
# builder so the build toolchain and its layers never reach the runtime image.
COPY --from=builder --chown=node:node /app /app

# Drop root: the node base image ships an unprivileged "node" user.
USER node

CMD ["mcp-proxy", "--", "node", "mcp/servers/egc-memory/build/index.js"]
