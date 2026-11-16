#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { doctor: doctorOp } = require('./lib/operations/index');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
const { getKnownHarnessDirs, samePath } = require('./lib/utils');
const { resolveStateStorePath } = require('./lib/state-store/path');
const { parseTargetArgs } = require('./lib/cli-target-args');
const { consolidateCommand, shellQuote } = require('./lib/doctor-summary');
const { findPlaintextStateFiles, listStateMarkdown, stateRoot } = require('./lib/state-plaintext');
const { defaultKeyPath, homeKeyPath } = require('./lib/state-crypto');
const { getStateDir } = require('./lib/branch-state');
const {
  DEFAULT_PROBE_TIMEOUT_MS,
  buildMcpReport,
  describeRegistration,
  describeServer,
  registrationSeverity,
} = require('./lib/doctor-mcp');
const { buildTeamReport, printTeamReport } = require('./lib/doctor-team');
const { buildHookReport } = require('./lib/doctor-hooks');

// Printed as an absolute path: the hint is read from wherever the person ran
// egc doctor (a project folder, a global npm install on Windows), and a
// repo-relative command only works from the package root (#1292).
const CONSOLIDATE_SCRIPT = path.join(__dirname, 'maintenance', 'merge-fragmented-state-dbs.js');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/doctor.js [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--repo-root <path>] [--json]

Diagnose drift and missing managed files for EGC install-state in the current context,
list every tool whose config carries the EGC MCP servers, and start each registered
server to check that it answers tools/list. Every Guardian hook script an install
recorded is run with a call the Guardian always refuses, in its tool's own event shape,
and a hook whose answer is not the Guardian's own refusal is an error; the Amp and
OpenCode plugins run inside the tool and are not probed (EGC_DOCTOR_PROBE_TIMEOUT_MS
caps the wait per server and per hook, ${DEFAULT_PROBE_TIMEOUT_MS} ms by default).

Without --repo-root, the reference repo is always wherever the running \`egc\`
binary lives (the published npm package for a global install). If the install
was synced from a local dev checkout via \`egc auto-update --repo-root\`
instead of an npm publish, pass that same --repo-root here so doctor compares
against the actual source instead of reporting every file the npm package
doesn't have yet as missing.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  return parseTargetArgs(argv);
}

function statusLabel(status) {
  if (status === 'ok') {
    return 'OK';
  }

  if (status === 'warning') {
    return 'WARNING';
  }

  if (status === 'error') {
    return 'ERROR';
  }

  return status.toUpperCase();
}

function probeTimeoutMs(env) {
  const raw = Number.parseInt(env.EGC_DOCTOR_PROBE_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PROBE_TIMEOUT_MS;
}

function printMcpReport(mcp) {
  console.log('\nMCP registrations:');
  if (mcp.registrations.length === 0) {
    console.log('  none found in this home: no supported tool carries egc-guardian and egc-memory yet (egc init registers them)');
  }
  for (const registration of mcp.registrations) {
    const tag = statusLabel(registrationSeverity(registration));
    console.log(`  - [${tag}] ${registration.name} (${registration.path}): ${describeRegistration(registration)}`);
  }
  if (mcp.servers.length > 0) {
    console.log('MCP servers:');
    for (const server of mcp.servers) {
      const tag = server.status === 'ok' ? 'OK' : 'ERROR';
      console.log(`  - [${tag}] ${server.name} at ${server.bin || server.command || '(no path)'}: ${describeServer(server)} (registered in ${server.registeredIn.join(', ')})`);
    }
  }
  const registered = mcp.registrations.filter(registration => registration.status === 'registered').length;
  const answering = mcp.servers.filter(server => server.status === 'ok').length;
  console.log(`MCP summary: registrations=${mcp.registrations.length}, registered=${registered}, servers=${mcp.servers.length}, answering=${answering}, warnings=${mcp.warningCount}, errors=${mcp.errorCount}`);
}

// Printed only when an install recorded a Guardian hook: a bare install has
// none, and an empty section would read as a problem.
function printHookReport(hooks) {
  if (hooks.probes.length === 0) return;
  console.log('\nGuardian hook scripts (each run with a call the Guardian always refuses; the Amp and OpenCode plugins are not probed):');
  for (const probe of hooks.probes) {
    const tag = probe.status === 'ok' ? 'OK' : 'ERROR';
    console.log(`  - [${tag}] ${probe.target}: ${probe.script} ${probe.detail} (${probe.scriptPath})`);
  }
  console.log(`Hook summary: probed=${hooks.probes.length}, refusing=${hooks.refusing}, errors=${hooks.errorCount}`);
}

function summaryLine(summary) {
  return `\nSummary: checked=${summary.checkedCount}, ok=${summary.okCount}, warnings=${summary.warningCount}, errors=${summary.errorCount}`;
}

function printHuman(report) {
  if (report.manifestError) {
    console.log(`Install manifests refused: ${report.manifestError}`);
  }
  if (report.results.length === 0) {
    console.log('Core runtime: OK. No managed target profile installed (that is what a bare `egc install` does).');
    console.log('Managed content (skills, rules, hooks) is optional; add it anytime with:');
    console.log('  egc install --target <target> --profile full');
    console.log(summaryLine(report.summary));
    return;
  }

  console.log('Doctor report:\n');
  for (const result of report.results) {
    console.log(`- ${result.adapter.id}`);
    console.log(`  Status: ${statusLabel(result.status)}`);
    console.log(`  Install-state: ${result.installStatePath}`);

    if (result.issues.length === 0) {
      console.log('  Issues: none');
      continue;
    }

    for (const issue of result.issues) {
      console.log(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  console.log(summaryLine(report.summary));
}

// Windows filesystems are case-insensitive and drive letters arrive in
// either case depending on the shell (C:\Users vs c:\users under Git
// Bash), so path identity folds case there; POSIX stays case-sensitive.
// Stray copies of the CLI store left in harness directories by the
// pre-#1104 resolution order (the state-fragmentation bug). Reported with
// size and last write so the person can tell live data from stale copies.
// Neither the store in active use nor the canonical ~/.egc location ever
// counts as a stray: when the CLI resolves to a harness directory, the
// canonical store is what everything consolidates INTO, not a fragment.
function findStateDbFragments(activeDbPath, canonicalDbPath, homeDir) {
  const fragments = [];
  const roots = [path.join(homeDir, '.egc'), ...getKnownHarnessDirs(homeDir)];
  for (const root of roots) {
    const candidate = path.join(root, 'egc', 'state.db');
    if (samePath(candidate, activeDbPath) || samePath(candidate, canonicalDbPath)) continue;
    try {
      const stat = fs.statSync(candidate);
      fragments.push({ path: candidate, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // Absent: not a fragment.
    }
  }
  return fragments;
}

function checkStateDb(homeDir) {
  const dbPath = resolveStateStorePath();
  const rootDir = path.dirname(path.dirname(dbPath));
  const canonicalDbPath = path.join(homeDir, '.egc', 'egc', 'state.db');
  // The memory server always keeps its store under ~/.egc/memory, no matter
  // where the CLI store resolves to (mcp/servers/egc-memory/src/index.ts).
  // Probing it under rootDir made this check blind whenever the CLI
  // resolved to a harness directory.
  const memoryDbPath = path.join(homeDir, '.egc', 'memory', 'state.db');

  const hasHarnessDb = fs.existsSync(dbPath);
  const hasMemoryDb = fs.existsSync(memoryDbPath);
  const fragments = findStateDbFragments(dbPath, canonicalDbPath, homeDir);
  // The CLI store belongs in the shared ~/.egc; landing in a KNOWN harness
  // directory (only an EGC_DIR pointing there sends it that way now) means
  // history is being split. An explicit custom EGC_DIR anywhere else is a
  // deliberate override, not a misplacement, and gets no scary guidance.
  const cliStoreMisplaced = hasHarnessDb
    && !samePath(dbPath, canonicalDbPath)
    && getKnownHarnessDirs(homeDir).some((harnessDir) => samePath(rootDir, harnessDir));
  // Fragments never substitute for a live store: the egc init guidance has
  // to survive their presence.
  const missing = !hasHarnessDb && !hasMemoryDb;

  if (hasHarnessDb && hasMemoryDb && !cliStoreMisplaced && fragments.length === 0) {
    // Both stores exist where they belong and no strays: the two-store
    // layout (CLI events + MCP memory, different engines and schemas) is
    // the current design, not a fault - nothing to report.
    return null;
  }
  // One predictable shape for --json consumers no matter which condition
  // fired.
  return { missing, dbPath, canonicalDbPath, memoryDbPath, hasHarnessDb, hasMemoryDb, cliStoreMisplaced, fragments };
}

// The Token Crusher shim in ~/.egc/bin, against what this package writes
// (#2137). It lives in the real home, so a doctor run for another home has
// no shim to judge; a shim another version wrote, or one edited on disk,
// still runs, so it is a warning that names the command to refresh it.
function checkCrusherShim(homeDir) {
  if (!samePath(homeDir, os.homedir())) return null;
  const shim = require('./lib/crusher/shim-install').verify();
  return !shim.installed || shim.state === 'ok' ? null : shim;
}

function printCrusherShimReport(shim) {
  const { describeVerification } = require('./lib/crusher/shim-install');
  console.log(`\n  WARNING: Token Crusher shim in ${shim.dir} is ${shim.state}: ${describeVerification(shim)}.`);
  console.log('    Run egc crusher-shim install to refresh it.');
}

const PLAINTEXT_STATE_SHOWN = 5;
// Absolute for the same reason as CONSOLIDATE_SCRIPT: the hint must run as
// pasted from wherever doctor was invoked.
const ENCRYPT_SCRIPT = path.join(__dirname, 'maintenance', 'encrypt-plaintext-state.js');

// The key that opens the state (#2144): where it is (EGC_ENCRYPTION_KEY_FILE
// or ~/.egc/encryption.key), whether a configured file exists while the
// default one does, and whether other users can read it. Windows has no
// mode bits to judge.
function checkEncryptionKey() {
  const configured = (process.env.EGC_ENCRYPTION_KEY_FILE || '').trim();
  const keyPath = defaultKeyPath();
  // The same resolver the key readers use, so the two never look at different homes.
  const defaultPath = homeKeyPath();
  const problems = [];
  let stat = null;
  try {
    stat = fs.lstatSync(keyPath);
  } catch (error) {
    if (error.code !== 'ENOENT') problems.push(`${keyPath} cannot be inspected (${error.code || error.name})`);
  }
  if (configured && !stat && fs.existsSync(defaultPath)) {
    problems.push(`EGC_ENCRYPTION_KEY_FILE names ${keyPath}, which does not exist, while ${defaultPath} does: move the key there or unset the variable, or the encrypted state will not open`);
  }
  if (stat?.isSymbolicLink()) problems.push(`${keyPath} is a symbolic link; the key must be a regular file`);
  if (stat && !stat.isSymbolicLink() && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    problems.push(`${keyPath} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 on it`);
  }
  return problems.length === 0 ? null : { path: keyPath, configured: configured || null, problems };
}

function printEncryptionKeyReport(report) {
  console.log('\nEncryption key:');
  for (const problem of report.problems) console.log(`  WARNING: ${problem}`);
}

const STATE_MODE_SHOWN = 5;

// State files are written read-only since 1.1.25 (#2143): one still writable
// was written before that, or by a tool that bypassed the memory server, and
// one readable by other users is exposed. POSIX bits only.
function checkStateFileModes(homeDir) {
  if (process.platform === 'win32') return null;
  const stateDir = getStateDir(homeDir);
  const root = stateRoot(stateDir);
  if (!root) return null;
  const files = listStateMarkdown(stateDir, 1);
  const writable = [];
  const exposed = [];
  for (const file of files) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if ((stat.mode & 0o044) !== 0) exposed.push(file);
    if ((stat.mode & 0o222) !== 0) writable.push(file);
  }
  if (writable.length === 0 && exposed.length === 0) return null;
  return { stateDir, checked: files.length, writable, exposed, warningCount: (writable.length > 0 ? 1 : 0) + (exposed.length > 0 ? 1 : 0) };
}

function printStateFileModesReport(report) {
  const shown = files => files.slice(0, STATE_MODE_SHOWN).map(file => `    ${file}`).join('\n')
    + (files.length > STATE_MODE_SHOWN ? `\n    and ${files.length - STATE_MODE_SHOWN} more` : '');
  console.log('\nState file modes:');
  if (report.exposed.length > 0) {
    console.log(`  WARNING: ${report.exposed.length} of ${report.checked} state files under ${report.stateDir} are readable by other users:`);
    console.log(shown(report.exposed));
  }
  if (report.writable.length > 0) {
    console.log(`  WARNING: ${report.writable.length} of ${report.checked} state files under ${report.stateDir} are writable (written before 1.1.25, or by a tool that bypassed the memory server):`);
    console.log(shown(report.writable));
  }
  console.log('  The next save by the memory server makes a file read-only; to do it now:');
  const every = [...new Set([...report.exposed, ...report.writable])];
  console.log(`    chmod 0400 ${every.map(file => shellQuote(file)).join(' ')}`);
}

function checkPlaintextState(homeDir) {
  const report = findPlaintextStateFiles(homeDir);
  if (report.count === 0) return null;
  return { ...report, encryptCommand: `node ${shellQuote(ENCRYPT_SCRIPT)}` };
}

function printPlaintextStateReport(report) {
  const noun = report.checked === 1 ? 'file' : 'files';
  const verb = report.count === 1 ? 'is' : 'are';
  console.log('\nState files:');
  console.log(`  WARNING: ${report.count} of ${report.checked} state ${noun} under ${report.stateDir} ${verb} plain text:`);
  for (const file of report.files.slice(0, PLAINTEXT_STATE_SHOWN)) {
    const lastWrite = file.modifiedAt ? ` (last write ${file.modifiedAt})` : '';
    console.log(`    ${file.path}${lastWrite}`);
  }
  if (report.count > PLAINTEXT_STATE_SHOWN) {
    console.log(`    and ${report.count - PLAINTEXT_STATE_SHOWN} more`);
  }
  console.log('  EGC has encrypted state at rest since 1.1.6. A plain file predates that, was');
  console.log('  saved by the EGC hooks before 1.1.18, or was written straight to disk by an');
  console.log('  AI tool that has no egc-memory server registered. Either way anything on');
  console.log('  this machine can read it. Encrypt them in place (dry run by default) with:');
  console.log(`    ${report.encryptCommand}`);
  console.log('  Review the list, then run the same command with --apply at the end. If a');
  console.log('  tool wrote one by hand, also run `egc init` in that project so the tool');
  console.log('  gets the server.');
}

function printStateStoreReport(stateDb) {
  console.log('\nState store:');
  if (stateDb.missing) {
    console.log('  WARNING: state.db not found at ' + stateDb.dbPath);
    console.log('  Run: egc init  to create the state store');
  }
  if (stateDb.cliStoreMisplaced) {
    console.log('  WARNING: the CLI event store landed in a harness directory:');
    console.log(`    ${stateDb.dbPath}`);
    console.log('  It belongs in the shared ~/.egc store; in a harness directory its');
    console.log('  history is invisible to the rest of EGC. Consolidate it with:');
    console.log(`    ${consolidateCommand(CONSOLIDATE_SCRIPT, [stateDb.dbPath], stateDb.canonicalDbPath)}`);
    console.log('  Review the dry run, then run the same command with --apply at the end.');
  }
  if (stateDb.fragments.length > 0) {
    const plural = stateDb.fragments.length === 1 ? 'copy' : 'copies';
    console.log(`  WARNING: found ${stateDb.fragments.length} stray state.db ${plural} left behind by older versions:`);
    for (const fragment of stateDb.fragments) {
      console.log(`    ${fragment.path} (${fragment.sizeBytes} bytes, last write ${fragment.modifiedAt})`);
    }
    console.log('  Nothing is lost, but new sessions no longer write there. Consolidate');
    console.log('  them into the main store (dry-run by default) with:');
    console.log(`    ${consolidateCommand(CONSOLIDATE_SCRIPT, stateDb.fragments.map(fragment => fragment.path), stateDb.canonicalDbPath)}`);
    console.log('  Review the dry run, then run the same command with --apply at the end.');
  }
  if (stateDb.hasHarnessDb && !stateDb.hasMemoryDb) {
    // "Nothing to do." only when no warning printed above it in this
    // block; a stray-fragment or misplacement warning followed by a
    // blanket reassurance would contradict itself.
    const blockIsClean = !stateDb.cliStoreMisplaced && stateDb.fragments.length === 0;
    console.log('  OK: the MCP memory store appears after your first session saves state.');
    console.log(`    It will live at ${stateDb.memoryDbPath}.${blockIsClean ? ' Nothing to do.' : ''}`);
  }
  if (!stateDb.hasHarnessDb && stateDb.hasMemoryDb) {
    console.log('  Pending: the CLI event store has not been created yet at');
    console.log(`    ${stateDb.dbPath}`);
    console.log('  It is created by `egc init`.');
  }
}

// The checks on the files under ~/.egc: the state stores, plain-text state,
// the key and the state file modes. Each one is null when there is nothing to say.
function checkLocalFiles(homeDir) {
  const encryptionKey = checkEncryptionKey();
  const stateFileModes = checkStateFileModes(homeDir);
  return {
    stateDb: checkStateDb(homeDir),
    plaintextState: checkPlaintextState(homeDir),
    encryptionKey,
    stateFileModes,
    warningCount: (encryptionKey ? encryptionKey.problems.length : 0) + (stateFileModes ? stateFileModes.warningCount : 0),
  };
}

function localFilesJson(files) {
  const out = {};
  if (files.stateDb) out.stateDb = files.stateDb;
  if (files.plaintextState) out.plaintextStateFiles = files.plaintextState;
  if (files.encryptionKey) out.encryptionKey = files.encryptionKey;
  if (files.stateFileModes) out.stateFileModes = files.stateFileModes;
  return out;
}

function printLocalFilesReports(files) {
  if (files.stateDb) printStateStoreReport(files.stateDb);
  if (files.plaintextState) printPlaintextStateReport(files.plaintextState);
  if (files.encryptionKey) printEncryptionKeyReport(files.encryptionKey);
  if (files.stateFileModes) printStateFileModesReport(files.stateFileModes);
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const report = doctorOp({
      repoRoot: options.repoRoot || path.join(__dirname, '..'),
      homeDir,
      projectRoot: process.cwd(),
      targets: options.targets,
    });
    const localFiles = checkLocalFiles(homeDir);
    const mcp = await buildMcpReport(homeDir, { timeoutMs: probeTimeoutMs(process.env) });
    // The Team Brain of this machine: files and one read of the remote, no
    // server. Its warnings join the doctor's total; it raises no error.
    const team = buildTeamReport(homeDir);
    const crusherShim = checkCrusherShim(homeDir);
    const summary = { ...report.summary, warningCount: report.summary.warningCount + team.warningCount + localFiles.warningCount + (crusherShim ? 1 : 0) };
    const hooks = buildHookReport(report.results, { homeDir, timeoutMs: probeTimeoutMs(process.env) });
    // Warnings are informative: drift and version skew are worth reporting but
    // do not mean the install is broken, and a warnings-only run is a healthy
    // run. Exit 1 is reserved for real failures so scripts and CI can trust
    // it: an install issue, a tool that lost its MCP registration, a server
    // that does not answer, a Guardian hook that lets a refused call through.
    const hasFailures = report.summary.errorCount > 0 || mcp.errorCount > 0 || hooks.errorCount > 0;

    if (options.json) {
      const out = { ...report, summary, mcp, team, hooks, ...localFilesJson(localFiles) };
      if (crusherShim) out.crusherShim = crusherShim;
      console.log(JSON.stringify(out, null, 2));
    } else {
      printHuman({ ...report, summary });
      printMcpReport(mcp);
      printTeamReport(team);
      printHookReport(hooks);
      printLocalFilesReports(localFiles);
      if (crusherShim) printCrusherShimReport(crusherShim);
    }

    process.exitCode = hasFailures ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
