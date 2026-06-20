FROM node:24-slim

WORKDIR /app

RUN npm install -g mcp-proxy@6.4.3

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

CMD ["mcp-proxy", "--", "node", "mcp/servers/egc-memory/build/index.js"]
