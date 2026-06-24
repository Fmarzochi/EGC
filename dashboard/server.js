#!/usr/bin/env node
'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execSync } = require('child_process');

const PORT   = 7890;
const PUBLIC = path.join(__dirname, 'public');
const CFG    = path.join(__dirname, 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const SERVER_START = Date.now();

function detectModel() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
  ];
  for (const p of candidates) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.model)        return s.model;
      if (s.defaultModel) return s.defaultModel;
    } catch (_) {}
  }
  return process.env.ANTHROPIC_MODEL || process.env.EGC_MODEL || null;
}

const DETECTED_MODEL = detectModel();

function detectOperator() {
  try { return execSync('git config user.name', { encoding: 'utf8', timeout: 500 }).trim(); } catch (_) {}
  return process.env.USER || process.env.USERNAME || null;
}
const OPERATOR = detectOperator();

// What each provider can actually expose — honest contract
const CAPABILITIES = {
  claude:    { tokenUsage:true,  model:true,  cost:true,  session:true,  workspace:true  },
  gemini:    { tokenUsage:true,  model:true,  cost:false, session:true,  workspace:false },
  cursor:    { tokenUsage:false, model:false, cost:false, session:true,  workspace:true  },
  codex:     { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  vscode:    { tokenUsage:false, model:false, cost:false, session:false, workspace:true  },
  kiro:      { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  trae:      { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  opencode:  { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  codebuddy: { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  aider:     { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
};

// Pricing per 1M tokens — updated from Anthropic pricing page
const CLAUDE_PRICING = {
  input:      3.00,
  output:    15.00,
  cacheRead:  0.30,
  cacheWrite: 3.75,
};

// Runtime telemetry accumulated from real events
const providerState = {};

function getProvider(ide) {
  if (!providerState[ide]) {
    providerState[ide] = {
      ide,
      lastSeen:  null,
      running:   false,
      toolCalls: 0,
      sessions:  0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  return providerState[ide];
}

function accumulateEvent(ev) {
  const p = getProvider(ev.ide);
  p.lastSeen = Date.now();
  p.running  = true;

  if (ev.event === 'pre_tool')    p.toolCalls++;
  if (ev.event === 'session_end' && ev.usage) {
    p.sessions++;
    p.tokens.input      += (ev.usage.input_tokens                  || 0);
    p.tokens.output     += (ev.usage.output_tokens                 || 0);
    p.tokens.cacheRead  += (ev.usage.cache_read_input_tokens       || 0);
    p.tokens.cacheWrite += (ev.usage.cache_creation_input_tokens   || 0);
  }
}

// Mark providers offline after 90 s without events
setInterval(() => {
  const now = Date.now();
  for (const p of Object.values(providerState)) {
    if (p.running && p.lastSeen && now - p.lastSeen > 90_000) {
      p.running = false;
    }
  }
}, 15_000);

// ── WebSocket clients ───────────────────────────────────────
const clients = new Set();

// ── HTTP server ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const reqOrigin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin) ? reqOrigin : 'http://localhost:7890');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /event ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        accumulateEvent(ev);
        const msg = JSON.stringify(ev);
        for (const ws of clients) { if (ws.readyState === 1) ws.send(msg); }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // ── GET /capabilities ────────────────────────────────────
  if (req.method === 'GET' && req.url === '/capabilities') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CAPABILITIES));
    return;
  }

  // ── GET /telemetry ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/telemetry') {
    const result = {};
    for (const [ide, p] of Object.entries(providerState)) {
      const cap = CAPABILITIES[ide] || {};
      let cost = null;
      if (ide === 'claude' && cap.cost && p.tokens.input > 0) {
        cost =
          p.tokens.input      * CLAUDE_PRICING.input      / 1e6 +
          p.tokens.output     * CLAUDE_PRICING.output     / 1e6 +
          p.tokens.cacheRead  * CLAUDE_PRICING.cacheRead  / 1e6 +
          p.tokens.cacheWrite * CLAUDE_PRICING.cacheWrite / 1e6;
      }
      result[ide] = {
        running:      p.running,
        toolCalls:    p.toolCalls,
        sessions:     p.sessions,
        tokens:       cap.tokenUsage ? p.tokens : null,
        cost:         (cap.cost && cost !== null) ? cost : null,
        capabilities: cap,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ── GET /stats ───────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/stats') {
    const cwd       = process.cwd();
    const cwdName   = path.basename(cwd);
    const project   = cwdName === 'dashboard' ? path.basename(path.dirname(cwd)) : cwdName;
    const workspace = cwdName === 'dashboard' ? path.dirname(cwd) : cwd;

    const stats = {
      project,
      workspace,
      model:       DETECTED_MODEL || 'Unknown',
      provider:    'Anthropic',
      serverStart: SERVER_START,
      operator:    OPERATOR,
      decisions: 0, lessons: 0, patterns: 0,
      longTermPct: null, workingPct: null,
    };

    try {
      const dir = path.join(os.homedir(), '.egc', 'state');
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).slice(0, 6);
        let d = 0, l = 0, p = 0;
        for (const f of files) {
          const c = fs.readFileSync(path.join(dir, f), 'utf8');
          d += (c.match(/^- What:/gm)   || []).length;
          l += (c.match(/lesson/gi)      || []).length;
          p += (c.match(/pattern/gi)     || []).length;
        }
        stats.decisions = d;
        stats.lessons   = Math.min(l, 99);
        stats.patterns  = Math.min(p, 30);
      }
    } catch (_) {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // ── GET /ping ────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ts: Date.now() }));
    return;
  }

  // ── GET /egc-logo.png ────────────────────────────────────
  if (req.method === 'GET' && req.url === '/egc-logo.png') {
    const logo = path.join(__dirname, '..', 'assets', 'images', 'egc-logo.png');
    if (fs.existsSync(logo)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(logo));
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // ── GET /config.json ─────────────────────────────────────
  if (req.method === 'GET' && req.url === '/config.json') {
    if (fs.existsSync(CFG)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(CFG));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"rules":[]}');
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const file    = path.join(PUBLIC, urlPath.split('?')[0]);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket ────────────────────────────────────────────────
try {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
} catch (_) {
  console.error('ws module not found. Run: npm install inside dashboard/');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`EGC Dashboard running at http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Is the dashboard already running?`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
