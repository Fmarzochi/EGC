#!/usr/bin/env node
/**
 * egc init — first-run bootstrap for an EGC installation.
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
const { spawnSync } = require('child_process');
const os = require('os');

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
egc init — first-run bootstrap

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

function log(msg) { console.log(msg); }
function logDry(msg) { if (flags.dryRun) console.log(`  [dry-run] ${msg}`); }
function logAction(msg) { console.log(`  ${flags.dryRun ? '[dry-run] ' : ''}${msg}`); }

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    console.error(`Error: Node.js >= 18 is required (found: ${process.version})`);
    console.error('Install or upgrade Node.js: https://nodejs.org');
    process.exit(1);
  }
  log(`  ✓ node ${process.version}`);
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
    console.error('If you installed via npm, this is a package bug — please report.');
    console.error('If you installed via git clone, run: sh install.sh');
    process.exit(1);
  }
  log(`  ✓ MCP server builds present`);
}

function runBootstrap() {
  if (flags.mcpOnly) {
    log(`  skipping cognitive bootstrap (--mcp-only)`);
    return;
  }
  const bootstrapScript = path.join(ROOT_DIR, 'scripts', 'bootstrap-cognitive.js');
  logAction(`bootstrapping cognitive protocol...`);
  if (flags.dryRun) return;
  const result = spawnSync(process.execPath, [bootstrapScript], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Bootstrap cognitive failed');
    process.exit(result.status || 1);
  }
}

function registerMcpServers() {
  log(`  registering MCP servers in detected tools...`);
  const HOME = os.homedir();

  const targets = [
    { name: 'Antigravity CLI', path: path.join(HOME, '.gemini', 'antigravity-cli', 'mcp_config.json'), gate: () => fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli')), format: 'json' },
    { name: 'Gemini CLI', path: path.join(HOME, '.gemini', 'config', 'mcp_config.json'), gate: () => fs.existsSync(path.join(HOME, '.gemini', 'config')) && !fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli')), format: 'json' },
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
        log(`  ✓ registered in ${target.name}`);
      } else if (target.format === 'toml') {
        registerToml(target.path);
        log(`  ✓ registered in ${target.name}`);
      }
    } catch (err) {
      log(`  ! skipped ${target.name}: ${err.message}`);
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

function runDoctor() {
  const doctorScript = path.join(ROOT_DIR, 'scripts', 'doctor.js');
  log(`\n  running egc doctor for final validation...`);
  if (flags.dryRun) {
    logDry(`would run: node scripts/doctor.js`);
    return;
  }
  spawnSync(process.execPath, [doctorScript], { stdio: 'inherit' });
}

console.log('EGC init');
if (flags.dryRun) console.log('(dry-run mode — no files will be written)');
if (flags.mcpOnly) console.log('(mcp-only mode — cognitive bootstrap will be skipped)');
console.log('');

checkNode();
checkMcpBuilds();
runBootstrap();
registerMcpServers();
runDoctor();

console.log('');
console.log('Installation complete.');
console.log('Run `egc doctor` anytime to verify the install.');
