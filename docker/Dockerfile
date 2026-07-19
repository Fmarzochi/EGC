FROM node:24-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169

WORKDIR /app

COPY docker/package.json docker/package-lock.json /tmp/mcp-proxy-install/
RUN cd /tmp/mcp-proxy-install && npm ci --silent && \
    mkdir -p /usr/local/lib/node_modules && \
    cp -r node_modules/. /usr/local/lib/node_modules/ && \
    ln -sf /usr/local/lib/node_modules/mcp-proxy/dist/bin/mcp-proxy.mjs /usr/local/bin/mcp-proxy

COPY package*.json ./
COPY scripts/preinstall.js scripts/preinstall.js
RUN npm ci

COPY . .
RUN npm run build

CMD ["mcp-proxy", "--", "node", "mcp/servers/egc-memory/build/index.js"]
