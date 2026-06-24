#!/usr/bin/env node
/**
 * egc init: first-run bootstrap for an EGC installation.
 *
 * Runs the same steps as install.sh but in Node so the flow works
 * identically on Windows, macOS, and Linux. Designed to be the entry
 * point invoked by `npx @egchq/egc init`.
 *
 * Steps:
 *   1. Verify Node >= 18
 *   2. Verify MCP server builds exist (built during prepack)
 *   3. Run cognitive bootstrap (writes the memory protocol into each
 *      detected tool's instruction file)
 *   4. Register MCP servers in detected tool configs
 *   5. Run `egc doctor` for final validation
 *
 * Flags:
 *   --dry-run     Show what would happen without writing files
 *   --mcp-only    Skip cognitive bootstrap and skill copies; only
 *                 register MCP servers in detected tools
 *   --yes         Skip interactive prompts (assume yes)
 *   --help        Show usage
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const os = require('os');

const { version: PKG_VERSION } = require('../package.json');

const isTTY = process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
};

const ROOT_DIR = path.resolve(__dirname, '..');
const GUARDIAN_BIN = path.join(ROOT_DIR, 'mcp', 'servers', 'egc-guardian', 'build', 'index.js');
const MEMORY_BIN = path.join(ROOT_DIR, 'mcp', 'servers', 'egc-memory', 'build', 'index.js');

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  mcpOnly: args.includes('--mcp-only'),
  yes: args.includes('--yes') || args.includes('-y'),
  help: args.includes('--help') || args.includes('-h'),
};

function showHelp() {
  console.log(`
egc init: first-run bootstrap

Usage:
  egc init [options]
  npx @egchq/egc init [options]

Options:
  --dry-run     Print the install plan without writing files
  --mcp-only    Register MCP servers only; skip protocol injection
  --yes, -y     Skip interactive prompts (CI-friendly)
  --help, -h    Show this help

Examples:
  npx @egchq/egc init                  # interactive install
  npx @egchq/egc init --dry-run        # preview only
  npx @egchq/egc init --mcp-only --yes # CI-friendly MCP-only setup
`);
  process.exit(0);
}

if (flags.help) showHelp();

function ok(label, detail = '')  { console.log(`  ${c.green}${c.bold}✓${c.reset}  ${c.bold}${label}${c.reset}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`); }
function skip(label, reason = '') { console.log(`  ${c.dim}-  ${label}${reason ? `  (${reason})` : ''}${c.reset}`); }
function warn(label, reason = '') { console.log(`  ${c.yellow}!${c.reset}  ${label}${reason ? `  ${c.dim}${reason}${c.reset}` : ''}`); }
function log(msg) { console.log(msg); }
function logDry(msg) { if (flags.dryRun) console.log(`  ${c.dim}[dry-run] ${msg}${c.reset}`); }
function logAction(msg) { console.log(`  ${c.dim}${flags.dryRun ? '[dry-run] ' : ''}${msg}${c.reset}`); }

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Error: Node.js 20 or later is required (found: ${process.version}).`);
    if (major === 18) {
      console.error('Node 18 reached end-of-life in March 2025 and is no longer supported.');
    }
    console.error('Update Node.js: https://nodejs.org/en/download');
    process.exit(1);
  }
  ok('node', process.version);
}

function checkMcpBuilds() {
  const missing = [];
  if (!fs.existsSync(GUARDIAN_BIN)) missing.push('egc-guardian');
  if (!fs.existsSync(MEMORY_BIN)) missing.push('egc-memory');
  if (missing.length > 0) {
    if (flags.dryRun) {
      logAction(`would build MCP servers: ${missing.join(', ')}`);
      return;
    }
    console.error(`Error: MCP server build missing: ${missing.join(', ')}`);
    console.error('If you installed via npm, this is a package bug: please report.');
    console.error('If you installed via git clone, run: sh install.sh');
    process.exit(1);
  }
  ok('MCP servers', 'built');
}

function runBootstrap() {
  if (flags.mcpOnly) {
    skip('cognitive bootstrap', '--mcp-only');
    return;
  }
  const bootstrapScript = path.join(ROOT_DIR, 'scripts', 'bootstrap-cognitive.js');
  logAction('bootstrapping cognitive protocol...');
  if (flags.dryRun) return;
  const result = spawnSync(process.execPath, [bootstrapScript], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Bootstrap cognitive failed');
    process.exit(result.status || 1);
  }
}

function registerMcpServers() {
  logAction('detecting tools...');
  const HOME = os.homedir();

  const targets = [
    { name: 'Antigravity CLI', path: path.join(HOME, '.gemini', 'antigravity-cli', 'mcp_config.json'), gate: () => fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli')), format: 'json' },
    { name: 'Gemini CLI', path: path.join(HOME, '.gemini', 'config', 'mcp_config.json'), gate: () => fs.existsSync(path.join(HOME, '.gemini', 'config')), format: 'json' },
    { name: 'Claude Code (global)', path: path.join(HOME, '.claude', 'claude_desktop_config.json'), gate: () => fs.existsSync(path.join(HOME, '.claude')), format: 'json' },
    { name: 'Cursor', path: path.join(HOME, '.cursor', 'mcp.json'), gate: () => fs.existsSync(path.join(HOME, '.cursor')), format: 'json' },
    { name: 'Kiro', path: path.join(HOME, '.kiro', 'settings', 'mcp.json'), gate: () => fs.existsSync(path.join(HOME, '.kiro')), format: 'json' },
    { name: 'Codex CLI', path: path.join(HOME, '.codex', 'config.toml'), gate: () => fs.existsSync(path.join(HOME, '.codex', 'config.toml')), format: 'toml' },
    { name: 'OpenCode', path: path.join(HOME, '.config', 'opencode', 'config.json'), gate: () => fs.existsSync(path.join(HOME, '.config', 'opencode', 'config.json')), format: 'json' },
  ];

  for (const target of targets) {
    if (!target.gate()) continue;
    if (flags.dryRun) {
      logDry(`would register in ${target.name} (${target.path})`);
      continue;
    }
    try {
      if (target.format === 'json') {
        registerJson(target.path);
        ok(target.name);
      } else if (target.format === 'toml') {
        registerToml(target.path);
        ok(target.name);
      }
    } catch (err) {
      warn(target.name, err.message);
    }
  }
}

function registerJson(target) {
  let obj = { mcpServers: {} };
  if (fs.existsSync(target)) {
    try { obj = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { return; }
  }
  if (!obj.mcpServers) obj.mcpServers = {};
  let changed = false;
  if (!obj.mcpServers['egc-guardian']) {
    obj.mcpServers['egc-guardian'] = { command: 'node', args: [GUARDIAN_BIN] };
    changed = true;
  }
  if (!obj.mcpServers['egc-memory']) {
    obj.mcpServers['egc-memory'] = { command: 'node', args: [MEMORY_BIN] };
    changed = true;
  }
  if (!changed) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(obj, null, 2) + '\n');
}

function registerToml(target) {
  let content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  let appended = false;
  if (!content.includes('"egc-guardian"') && !content.includes("'egc-guardian'")) {
    content += `\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["${GUARDIAN_BIN}"]\n`;
    appended = true;
  }
  if (!content.includes('"egc-memory"') && !content.includes("'egc-memory'")) {
    content += `\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["${MEMORY_BIN}"]\n`;
    appended = true;
  }
  if (!appended) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function runStateDbBootstrap() {
  const bootstrapScript = path.join(ROOT_DIR, 'scripts', 'bootstrap-state-db.js');
  if (!fs.existsSync(bootstrapScript)) return;
  logAction('initializing state store...');
  if (flags.dryRun) return;
  const result = spawnSync(process.execPath, [bootstrapScript], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  const output = (result.stderr || '').trim();
  if (output) console.log('  ' + output.split('\n').join('\n  '));
}

function runDoctor() {
  const doctorScript = path.join(ROOT_DIR, 'scripts', 'doctor.js');
  log(`\n${c.dim}  running egc doctor for final validation...${c.reset}`);
  if (flags.dryRun) {
    logDry(`would run: node scripts/doctor.js`);
    return;
  }
  const doctorResult = spawnSync(process.execPath, [doctorScript], { stdio: 'inherit' });
  if (doctorResult.status !== 0) {
    const repairScript = path.join(ROOT_DIR, 'scripts', 'repair.js');
    log(`\n  auto-repairing drift detected by doctor...`);
    spawnSync(process.execPath, [repairScript], { stdio: 'inherit' });
  }
}

const banner = [
  '',
  `  ${c.cyan}${c.bold}╭──────────────────────────────────────────╮${c.reset}`,
  `  ${c.cyan}${c.bold}│${c.reset}  ${c.bold}EGC${c.reset} ${c.dim}·${c.reset} AI context manager${' '.repeat(16)}${c.cyan}${c.bold}│${c.reset}`,
  `  ${c.cyan}${c.bold}│${c.reset}  ${c.dim}v${PKG_VERSION}${' '.repeat(39 - PKG_VERSION.length)}${c.reset}${c.cyan}${c.bold}│${c.reset}`,
  `  ${c.cyan}${c.bold}╰──────────────────────────────────────────╯${c.reset}`,
  '',
];
console.log(banner.join('\n'));
if (flags.dryRun) console.log(`  ${c.yellow}dry-run mode -- no files will be written${c.reset}\n`);
if (flags.mcpOnly) console.log(`  ${c.dim}mcp-only mode -- cognitive bootstrap will be skipped${c.reset}\n`);

checkNode();
checkMcpBuilds();
runBootstrap();
registerMcpServers();
runStateDbBootstrap();
runDoctor();

console.log('');
console.log(`  ${c.green}${c.bold}Installation complete.${c.reset}`);
console.log(`  ${c.dim}Run \`egc doctor\` anytime to verify.${c.reset}`);

if (!flags.dryRun) {
  const dashboardScript = path.join(ROOT_DIR, 'scripts', 'dashboard.js');
  if (fs.existsSync(dashboardScript)) {
    const dashPing = new Promise(resolve => {
      const req = http.get('http://localhost:7890/ping', res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    const openBrowser = () => {
      const url = 'http://localhost:7890';
      const cmd = process.platform === 'win32' ? 'start' :
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
      try { require('child_process').spawnSync(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore' }); } catch (_) { /* best-effort */ }
    };
    dashPing.then(already => {
      if (already) {
        console.log(`\n  ${c.cyan}Dashboard already running at http://localhost:7890${c.reset}`);
        openBrowser();
        return;
      }
      const child = spawn(process.execPath, [dashboardScript], {
  detached: true,
  stdio: 'ignore',
  ...(process.platform === 'win32' && { shell: true }),
});
child.unref();
      console.log(`\n  ${c.cyan}EGC Dashboard starting at http://localhost:7890${c.reset}`);
      console.log(`  ${c.dim}Minimize it to keep working. Run \`egc dashboard stop\` to close.${c.reset}`);
      setTimeout(openBrowser, 1500);
    });
  }
}
