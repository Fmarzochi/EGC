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
 *   5. Run `egc doctor` as the final check
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
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');

const { version: PKG_VERSION } = require('../package.json');
const { registerMcpServers: runMcpRegistration } = require('./lib/mcp-register');
const { createSpinner } = require('./lib/spinner');
const { summarizeDoctorReport, summarizeRepairResult } = require('./lib/doctor-summary');

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
function fail(label, reason = '') { console.log(`  ${c.red}${c.bold}✗${c.reset}  ${label}${reason ? '  ' + c.dim + reason + c.reset : ''}`); }
function detail(msg) { console.log(`       ${c.dim}${msg}${c.reset}`); }
function action(msg) { console.log(`     ${msg}`); }
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
    console.error('If you installed via git clone, run: sh scripts/install.sh');
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

// The two status lines used to be fixed strings printed after the doctor.
// Each one now reflects a real check: the CLI state store the bootstrap
// just initialized, and the Token Crusher shim that `egc install` puts on
// PATH (init itself never installs it, so it can only report what it finds).
function resolveStateDbPath() {
  try {
    const { getEGCDir } = require('./lib/utils');
    return path.join(getEGCDir(), 'egc', 'state.db');
  } catch {
    return null;
  }
}

function readShimStatus() {
  try {
    return require('./lib/crusher/shim-install').status();
  } catch {
    return null;
  }
}

function reportRuntimeStatus() {
  if (flags.dryRun) {
    logDry('would report memory and token crusher status');
    return;
  }

  const stateDbPath = resolveStateDbPath();
  if (stateDbPath && fs.existsSync(stateDbPath)) {
    ok('memory', 'state store ready; loads on your first session');
  } else {
    warn('memory', 'state store not found; details: egc doctor');
  }

  const shim = readShimStatus();
  if (!shim) {
    skip('token crusher', 'status unavailable');
  } else if (shim.dirExists && shim.shimmed.length > 0) {
    ok('token crusher', shim.activeInCurrentShell ? 'shim installed and on PATH' : 'shim installed, active in every new shell');
  } else {
    skip('token crusher', 'shim not installed; egc install adds it');
  }
}

// Doctor and repair print their whole report when their stdio is inherited,
// so init runs them in JSON mode with the output captured: the spinner can
// animate meanwhile and the summary below is rendered from the same data
// the tests and tools read. stderr is kept for the failure line.
function runJsonScript(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ status: 1, report: null, stderr: error.message }));
    child.on('close', status => resolve({ status, report: parseJsonOutput(stdout), stderr: stderr.trim() }));
  });
}

function parseJsonOutput(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function printDoctorSummary(summary) {
  const label = 'install check';
  if (summary.status === 'ok' || summary.status === 'empty') {
    ok(label, summary.headline);
  } else if (summary.status === 'warning') {
    warn(label, summary.headline);
  } else {
    fail(label, summary.headline);
  }
  if (summary.hint) action(summary.hint);
  for (const line of summary.details) detail(`${line.adapterId}  ${line.text}`);
  for (const command of summary.commands) action(`${summary.bare ? '' : 'Run: '}${command}`);
  for (const note of summary.notes) action(note);
}

function reportDoctorFailure(run) {
  fail('install check', 'the doctor result could not be read');
  for (const line of (run.stderr || '').split('\n').filter(Boolean)) detail(line);
  action('Details: egc doctor');
  return { status: 'error', checked: 0, ok: 0, warnings: 0, errors: 1, headline: '', details: [], commands: [], notes: [] };
}

async function runDoctor() {
  const doctorScript = path.join(ROOT_DIR, 'scripts', 'doctor.js');
  const repairScript = path.join(ROOT_DIR, 'scripts', 'repair.js');
  if (flags.dryRun) {
    logDry('would run: egc doctor');
    return null;
  }

  const spinner = createSpinner();
  spinner.start('checking the install (egc doctor)...');
  const first = await runJsonScript(doctorScript, ['--json']);
  spinner.stop();
  if (!first.report) return reportDoctorFailure(first);

  let summary = summarizeDoctorReport(first.report, { repoRoot: ROOT_DIR });
  if (summary.status !== 'error') {
    printDoctorSummary(summary);
    return summary;
  }

  // Errors are repaired in place before anyone is asked to type a command;
  // only what survives the repair is reported with its command.
  warn('install check', `${summary.headline}; repairing...`);
  reconcileResolutionDrift();

  spinner.start(`repairing ${summary.errors} target${summary.errors === 1 ? '' : 's'}...`);
  const repair = await runJsonScript(repairScript, ['--json']);
  spinner.stop();
  if (!repair.report) {
    const reason = (repair.stderr || '').split('\n').findLast(Boolean);
    warn('repair', reason ? `did not finish: ${reason}` : 'did not finish');
  } else {
    const repairSummary = summarizeRepairResult(repair.report);
    if (repairSummary.failed) warn('repair', repairSummary.text);
    else ok('repair', repairSummary.text);
  }

  spinner.start('checking again (egc doctor)...');
  const second = await runJsonScript(doctorScript, ['--json']);
  spinner.stop();
  if (!second.report) return reportDoctorFailure(second);
  summary = summarizeDoctorReport(second.report, { repoRoot: ROOT_DIR, afterRepair: true });
  printDoctorSummary(summary);
  return summary;
}

// Same launch decision as install.sh and install-apply.js: a person at a
// terminal gets the dashboard, a CI job or a piped run gets the headless
// line. The launcher's own messages are folded into one check line so the
// completion line below stays the last thing on screen.
async function launchDashboardLine() {
  if (flags.dryRun) return;
  let dashboard;
  try {
    dashboard = require('./lib/dashboard-launch');
  } catch {
    return;
  }
  if (!dashboard.shouldAutoLaunch()) {
    log("  Dashboard not started (headless environment). Run 'egc dashboard' to start it.");
    return;
  }

  const spinner = createSpinner();
  const notes = [];
  spinner.start('starting the dashboard...');
  const ready = await dashboard.launchDashboard({
    log: message => {
      notes.push(message);
      if (message.startsWith('First launch may install')) {
        spinner.update('starting the dashboard (installing its dependencies, up to a minute)...');
      }
    },
  });
  spinner.stop();

  if (ready) {
    ok('dashboard', `available at ${dashboard.DASHBOARD_URL} (opened in your browser; close with \`egc dashboard stop\`)`);
    return;
  }
  if (notes.length === 0) {
    skip('dashboard', 'not available in this install');
    return;
  }
  warn('dashboard', 'did not start');
  for (const note of notes) detail(note);
}

function printClosingLine(summary) {
  console.log('');
  if (!summary || summary.status === 'ok' || summary.status === 'empty') {
    console.log(`  ${c.green}${c.bold}Installation complete.${c.reset} ${c.dim}Re-check anytime with \`egc doctor\`.${c.reset}`);
    return;
  }
  if (summary.status === 'warning') {
    const count = summary.warnings + summary.notes.length;
    console.log(`  ${c.green}${c.bold}Installation complete${c.reset} ${c.yellow}with ${count} warning${count === 1 ? '' : 's'}.${c.reset} ${c.dim}Details anytime with \`egc doctor\`.${c.reset}`);
    return;
  }
  const count = summary.errors;
  console.log(`  ${c.red}${c.bold}Installation finished with ${count} error${count === 1 ? '' : 's'}.${c.reset} ${c.dim}Run the commands above, then \`egc doctor\`.${c.reset}`);
}

const AUTHOR_NAME = 'Felipe Marzochi';
const AUTHOR_URL = 'https://github.com/Fmarzochi';
const authorText = `Powered by ${AUTHOR_NAME}`;
const authorDisplay = isTTY
  ? `\x1b]8;;${AUTHOR_URL}\x1b\\${authorText}\x1b]8;;\x1b\\`
  : authorText;

const banner = [
  '',
  `  ${c.cyan}${c.bold}╭──────────────────────────────────────────╮${c.reset}`,
  `  ${c.cyan}${c.bold}│${c.reset}  ${c.bold}EGC${c.reset} ${c.dim}·${c.reset} Extended Global Context${' '.repeat(11)}${c.cyan}${c.bold}│${c.reset}`,
  `  ${c.cyan}${c.bold}│${c.reset}  ${c.dim}v${PKG_VERSION}${' '.repeat(39 - PKG_VERSION.length)}${c.reset}${c.cyan}${c.bold}│${c.reset}`,
  `  ${c.cyan}${c.bold}│${c.reset}  ${c.dim}${authorDisplay}${' '.repeat(40 - authorText.length)}${c.reset}${c.cyan}${c.bold}│${c.reset}`,
  `  ${c.cyan}${c.bold}╰──────────────────────────────────────────╯${c.reset}`,
  '',
];
console.log(banner.join('\n'));
if (flags.dryRun) console.log(`  ${c.yellow}dry-run mode -- no files will be written${c.reset}\n`);
if (flags.mcpOnly) console.log(`  ${c.dim}mcp-only mode -- cognitive bootstrap will be skipped${c.reset}\n`);

async function main() {
  checkNode();
  checkMcpBuilds();
  runBootstrap();
  registerMcpServers();
  runStateDbBootstrap();
  configureCommitPrivacyFilter();
  reportRuntimeStatus();
  const summary = await runDoctor();
  await launchDashboardLine();
  printClosingLine(summary);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
