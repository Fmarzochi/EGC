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

// Pricing per 1M tokens — loaded from prices.json (configurable)
const PRICES_PATH = path.join(__dirname, 'prices.json');
let MODEL_PRICES = {};
function loadPrices() {
  try {
    MODEL_PRICES = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
  } catch (_) {
    MODEL_PRICES = {
      '_default_claude': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
      '_default_gemini': { input: 0.10, output: 0.40,  cacheRead: 0.025, cacheWrite: 0.00 },
      '_default_codex':  { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 0.00 },
    };
  }
}
loadPrices();
fs.watchFile(PRICES_PATH, () => loadPrices());

const IDE_PRICE_KEY = {
  claude: '_default_claude',
  gemini: '_default_gemini',
  codex:  '_default_codex',
  opencode: '_default_opencode',
};

function calcCost(ide, tokens, model) {
  const pricing = MODEL_PRICES[model] || MODEL_PRICES[IDE_PRICE_KEY[ide]];
  if (!pricing) return null;
  const inp = (tokens.input      || 0) * (pricing.input      || 0) / 1e6;
  const out = (tokens.output     || 0) * (pricing.output     || 0) / 1e6;
  const cr  = (tokens.cacheRead  || 0) * (pricing.cacheRead  || 0) / 1e6;
  const cw  = (tokens.cacheWrite || 0) * (pricing.cacheWrite || 0) / 1e6;
  return inp + out + cr + cw;
}

// Runtime telemetry accumulated from real events
const providerState = {};
// Store recent completed sessions for dashboard analytics
const sessionHistory = [];
const MAX_SESSION_HISTORY = 1000;

function getProvider(ide) {
  if (!providerState[ide]) {
    providerState[ide] = {
      ide,
      lastSeen:  null,
      running:   false,
      toolCalls: 0,
      sessions:  0,
      lastModel: null,          // ← add this line
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  return providerState[ide];
}

function accumulateEvent(ev) {
  

  const p = getProvider(ev.ide);
  p.lastSeen = Date.now();
  p.running  = true;
  if (ev.model) p.lastModel = ev.model;   // ← add this line

if (ev.event === 'pre_tool') p.toolCalls++;

if (ev.event === 'session_end') {
  const usage = ev.usage || {};
  const sessionTokens = {
    input:      usage.input_tokens                || 0,
    output:     usage.output_tokens               || 0,
    cacheRead:  usage.cache_read_input_tokens     || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
  };
  const sessionModel = ev.model || p.lastModel || null;
  const ideCap       = CAPABILITIES[ev.ide] || {};
  const sessionCost  = ideCap.cost === true ? calcCost(ev.ide, sessionTokens, sessionModel) : null;

  sessionHistory.push({
    timestamp:    Date.now(),
    ide:          ev.ide,
    model:        sessionModel,
    input_tokens:  sessionTokens.input,
    output_tokens: sessionTokens.output,
    total_tokens:  sessionTokens.input + sessionTokens.output,
    cost:          sessionCost,
  });

  if (sessionHistory.length > MAX_SESSION_HISTORY) sessionHistory.shift();
}

if (ev.usage) {
  p.sessions++;

  p.tokens.input += (ev.usage.input_tokens || 0);
  p.tokens.output += (ev.usage.output_tokens || 0);
  p.tokens.cacheRead += (ev.usage.cache_read_input_tokens || 0);
  p.tokens.cacheWrite += (ev.usage.cache_creation_input_tokens || 0);
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
      if (cap.tokenUsage && cap.cost && p.tokens.input > 0) {
        cost = calcCost(ide, p.tokens, p.lastModel);
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
  // ── GET /session-history ───────────────────────────────
if (req.method === 'GET' && req.url === '/session-history') {

  
  
 

  res.writeHead(200, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify(sessionHistory));
  return;
}

  // ── GET /prices ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/prices') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MODEL_PRICES));
    return;
  }

  // ── GET /cost-summary [? range=today|week|month|all] ────────────────
  if (req.method === 'GET' && (req.url === '/cost-summary' || req.url.startsWith('/cost-summary?'))) {
    const urlObj = new URL(req.url, 'http://localhost');
    const range  = urlObj.searchParams.get('range') || 'all';
    const now    = Date.now();
    const CUTOFFS = { today: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
    const cutoff  = CUTOFFS[range] ? now - CUTOFFS[range] : 0;
    const filtered = cutoff
      ? sessionHistory.filter(s => s.timestamp >= cutoff)
      : sessionHistory;

    const byIde = {};
    for (const s of filtered) {
      if (!byIde[s.ide]) {
        const cap = CAPABILITIES[s.ide] || {};
        byIde[s.ide] = { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, sessions: 0, costSupported: cap.cost === true };
      }
      byIde[s.ide].totalCost         += s.cost          || 0;
      byIde[s.ide].totalInputTokens  += s.input_tokens  || 0;
      byIde[s.ide].totalOutputTokens += s.output_tokens || 0;
      byIde[s.ide].sessions          += 1;
    }
    const grandTotal = Object.values(byIde).reduce((acc, v) => acc + (v.costSupported ? v.totalCost : 0), 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      grandTotal,
      byIde,
      recentSessions: filtered.slice(-50).reverse(),
    }));
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
          d += (c.match(/^- What:/gm)      || []).length;
          l += (c.match(/^- Lesson:/gm)    || []).length;
          p += (c.match(/^- Pattern:/gm)   || []).length;
        }
        stats.decisions = d;
        stats.lessons   = l;
        stats.patterns  = p;
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
