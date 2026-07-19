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

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const { version: PKG_VERSION } = require('../package.json');
const { registerMcpServers: runMcpRegistration } = require('./lib/mcp-register');

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

const args = new Set(process.argv.slice(2));
const flags = {
  dryRun: args.has('--dry-run'),
  mcpOnly: args.has('--mcp-only'),
  yes: args.has('--yes') || args.has('-y'),
  help: args.has('--help') || args.has('-h'),
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

function ok(label, detail = '')  { console.log(`  ${c.green}${c.bold}✓${c.reset}  ${c.bold}${label}${c.reset}${detail ? '  ' + c.dim + detail + c.reset : ''}`); }
function skip(label, reason = '') { console.log(`  ${c.dim}-  ${label}${reason ? '  (' + reason + ')' : ''}${c.reset}`); }
function warn(label, reason = '') { console.log(`  ${c.yellow}!${c.reset}  ${label}${reason ? '  ' + c.dim + reason + c.reset : ''}`); }
function log(msg) { console.log(msg); }
function logDry(msg) { if (flags.dryRun) console.log(`  ${c.dim}[dry-run] ${msg}${c.reset}`); }
function logAction(msg) { console.log(`  ${c.dim}${flags.dryRun ? '[dry-run] ' : ''}${msg}${c.reset}`); }

function checkNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
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

  runMcpRegistration(
    HOME,
    { guardianBin: GUARDIAN_BIN, memoryBin: MEMORY_BIN },
    {
      dryRun: flags.dryRun,
      onSkip: (target) => logDry(`would register in ${target.name} (${target.path})`),
      onRegister: (target) => ok(target.name),
      onWarn: (target, err) => warn(target.name, err.message),
    }
  );
}

function configureCommitPrivacyFilter() {
  let configureMemoryFilters;
  try {
    ({ configureMemoryFilters } = require('./lib/memory-filters'));
  } catch {
    skip('commit-privacy filter', 'memory-filters lib not available');
    return;
  }

  const scriptPath = path.join(ROOT_DIR, 'scripts', 'check-state-leak.js');
  logAction('configuring commit-privacy filter (planned changes below)...');
  const plan = configureMemoryFilters({ projectDir: process.cwd(), scriptPath, dryRun: true });
  if (!plan.configured) {
    skip('commit-privacy filter', plan.reason);
    return;
  }
  for (const action of plan.actions) logAction(action);
  if (flags.dryRun) return;

  const result = configureMemoryFilters({ projectDir: process.cwd(), scriptPath, dryRun: false });
  ok('commit-privacy filter', `populated memory is stripped from staged blobs (${result.actions.length} change(s), local repo only)`);
}

function runStateDbBootstrap() {
  const bootstrapScript = path.join(ROOT_DIR, 'scripts', 'bootstrap-state-db.js');
  if (!fs.existsSync(bootstrapScript)) return;
  logAction('initializing state store...');
  if (flags.dryRun) return;
  const result = spawnSync(process.execPath, [bootstrapScript], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  const output = (result.stderr || '').trim();
  if (output) console.log('  ' + output.replaceAll('\n', '\n  '));
}

/**
 * Recorded-content repair restores files but never rewrites the recorded
 * module resolution, so a resolution-drift finding survives `egc repair`
 * forever. Reapply the manifest install for the affected targets instead.
 */
function reconcileResolutionDrift() {
  let plans;
  try {
    const { buildDoctorReport } = require('./lib/install-lifecycle');
    const { planDriftReinstalls } = require('./lib/init-remediation');
    plans = planDriftReinstalls(buildDoctorReport({ repoRoot: ROOT_DIR }));
  } catch (error) {
    warn('drift reconciliation skipped', error.message);
    return;
  }

  const applyScript = path.join(ROOT_DIR, 'scripts', 'install-apply.js');
  for (const plan of plans) {
    log(`\n  reapplying manifest install for ${plan.adapterId} (resolution drift)...`);
    const result = spawnSync(
      process.execPath,
      [applyScript, ...plan.args, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    );
    if (result.status === 0) {
      ok(plan.adapterId, 'reinstalled from current manifests');
    } else {
      const stderrText = (result.stderr || '').trim();
      warn(plan.adapterId, stderrText.split('\n').pop() || 'install-apply failed');
    }
  }
}

function runDoctor() {
  const doctorScript = path.join(ROOT_DIR, 'scripts', 'doctor.js');
  log(`\n${c.dim}  running egc doctor for final validation...${c.reset}`);
  if (flags.dryRun) {
    logDry(`would run: node scripts/doctor.js`);
    return;
  }
  const doctorResult = spawnSync(process.execPath, [doctorScript], { stdio: 'inherit' });
  if (doctorResult.status === 0) {
    return;
  }

  reconcileResolutionDrift();

  const repairScript = path.join(ROOT_DIR, 'scripts', 'repair.js');
  log(`\n  auto-repairing drift detected by doctor...`);
  spawnSync(process.execPath, [repairScript], { stdio: 'inherit' });

  log(`\n${c.dim}  re-running egc doctor to confirm...${c.reset}`);
  const verifyResult = spawnSync(process.execPath, [doctorScript], { stdio: 'inherit' });
  if (verifyResult.status !== 0) {
    warn('doctor still reports issues', 'run `egc doctor` for details');
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
configureCommitPrivacyFilter();
runDoctor();

console.log('');
console.log(`  ${c.green}${c.bold}Installation complete.${c.reset}`);
console.log(`  ${c.green}Memory loaded (project + global)${c.reset} ${c.dim}|${c.reset} ${c.bold}Token Crusher engaged:${c.reset} shell output compressed up to 90%`);
console.log(`  ${c.dim}Route heavy commands through \`egc run <cmd>\`; see savings anytime with \`egc saved\`. Run \`egc doctor\` to verify.${c.reset}`);

if (!flags.dryRun) {
  const { launchDashboard } = require('./lib/dashboard-launch');
  launchDashboard({ rootDir: ROOT_DIR, log: msg => console.log(`\n  ${c.cyan}${msg}${c.reset}`) });
}
