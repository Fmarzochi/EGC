#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { doctor: doctorOp } = require('./lib/operations/index');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
const { getEGCDir, getKnownHarnessDirs } = require('./lib/utils');
const { parseTargetArgs } = require('./lib/cli-target-args');

// Printed as an absolute path: the hint is read from wherever the person ran
// egc doctor (a project folder, a global npm install on Windows), and a
// repo-relative command only works from the package root (#1292).
const CONSOLIDATE_SCRIPT = path.join(__dirname, 'maintenance', 'merge-fragmented-state-dbs.js');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/doctor.js [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--repo-root <path>] [--json]

Diagnose drift and missing managed files for EGC install-state in the current context.

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

function printHuman(report) {
  if (report.results.length === 0) {
    console.log('Core runtime: OK. No managed target profile installed (that is what a bare `egc install` does).');
    console.log('Managed content (skills, rules, hooks) is optional; add it anytime with:');
    console.log('  egc install --target <target> --profile full');
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

  console.log(`\nSummary: checked=${report.summary.checkedCount}, ok=${report.summary.okCount}, warnings=${report.summary.warningCount}, errors=${report.summary.errorCount}`);
}

// Windows filesystems are case-insensitive and drive letters arrive in
// either case depending on the shell (C:\Users vs c:\users under Git
// Bash), so path identity folds case there; POSIX stays case-sensitive.
function samePath(a, b) {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (process.platform === 'win32') return resolvedA.toLowerCase() === resolvedB.toLowerCase();
  return resolvedA === resolvedB;
}

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
  const rootDir = getEGCDir();
  const dbPath = path.join(rootDir, 'egc', 'state.db');
  const canonicalDbPath = path.join(homeDir, '.egc', 'egc', 'state.db');
  // The memory server always keeps its store under ~/.egc/memory, no matter
  // what getEGCDir() resolves to (mcp/servers/egc-memory/src/index.ts).
  // Probing it under rootDir made this check blind whenever the CLI
  // resolved to a harness directory.
  const memoryDbPath = path.join(homeDir, '.egc', 'memory', 'state.db');

  const hasHarnessDb = fs.existsSync(dbPath);
  const hasMemoryDb = fs.existsSync(memoryDbPath);
  const fragments = findStateDbFragments(dbPath, canonicalDbPath, homeDir);
  // The CLI store belongs in the shared ~/.egc; landing in a KNOWN harness
  // directory means resolution picked a harness and history is being split.
  // An explicit custom EGC_DIR anywhere else is a deliberate override, not
  // a misplacement, and gets no scary guidance.
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
  return { missing, dbPath, memoryDbPath, hasHarnessDb, hasMemoryDb, cliStoreMisplaced, fragments };
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
    console.log(`    node "${CONSOLIDATE_SCRIPT}"`);
  }
  if (stateDb.fragments.length > 0) {
    const plural = stateDb.fragments.length === 1 ? 'copy' : 'copies';
    console.log(`  WARNING: found ${stateDb.fragments.length} stray state.db ${plural} left behind by older versions:`);
    for (const fragment of stateDb.fragments) {
      console.log(`    ${fragment.path} (${fragment.sizeBytes} bytes, last write ${fragment.modifiedAt})`);
    }
    console.log('  Nothing is lost, but new sessions no longer write there. Consolidate');
    console.log('  them into the main store (dry-run by default) with:');
    console.log(`    node "${CONSOLIDATE_SCRIPT}"`);
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

function main() {
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
    // Warnings are informative: drift and version skew are worth reporting but
    // do not mean the install is broken, and a warnings-only run is a healthy
    // run. Exit 1 is reserved for real failures so scripts and CI can trust it.
    const hasFailures = report.summary.errorCount > 0;
    const stateDb = checkStateDb(homeDir);

    if (options.json) {
      const out = stateDb ? { ...report, stateDb } : report;
      console.log(JSON.stringify(out, null, 2));
    } else {
      printHuman(report);
      if (stateDb) printStateStoreReport(stateDb);
    }

    process.exitCode = hasFailures ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
