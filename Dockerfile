FROM node:24-slim@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a

WORKDIR /app

COPY docker/package.json docker/package-lock.json /tmp/mcp-proxy-install/
RUN cd /tmp/mcp-proxy-install && npm ci --silent && \
    cp -r node_modules/mcp-proxy /usr/local/lib/node_modules/mcp-proxy && \
    ln -sf /usr/local/lib/node_modules/mcp-proxy/dist/bin/mcp-proxy.mjs /usr/local/bin/mcp-proxy

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

CMD ["mcp-proxy", "--", "node", "mcp/servers/egc-memory/build/index.js"]
