#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { buildDoctorReport } = require('./lib/install-lifecycle');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
const { getEGCDir, getKnownHarnessDirs } = require('./lib/utils');
const { parseTargetArgs } = require('./lib/cli-target-args');

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
    console.log('No EGC install-state files found for the current home/project context.');
    console.log('This is expected after a bare `egc install`; the core runtime is installed without a managed target profile.');
    console.log('Run `egc install --target <target> --profile full` when you want to install managed content.');
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
  // The CLI store belongs in the shared ~/.egc; anywhere else means path
  // resolution picked a harness directory and history is being split.
  const cliStoreMisplaced = hasHarnessDb && !samePath(dbPath, canonicalDbPath);
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

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const report = buildDoctorReport({
      repoRoot: options.repoRoot || path.join(__dirname, '..'),
      homeDir,
      projectRoot: process.cwd(),
      targets: options.targets,
    });
    const hasIssues = report.summary.errorCount > 0 || report.summary.warningCount > 0;
    const stateDb = checkStateDb(homeDir);

    if (options.json) {
      const out = stateDb ? { ...report, stateDb } : report;
      console.log(JSON.stringify(out, null, 2));
    } else {
      printHuman(report);
      if (stateDb) {
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
          console.log('    node scripts/maintenance/merge-fragmented-state-dbs.js');
        }
        if (stateDb.fragments.length > 0) {
          const plural = stateDb.fragments.length === 1 ? 'copy' : 'copies';
          console.log(`  WARNING: found ${stateDb.fragments.length} stray state.db ${plural} left behind by older versions:`);
          for (const fragment of stateDb.fragments) {
            console.log(`    ${fragment.path} (${fragment.sizeBytes} bytes, last write ${fragment.modifiedAt})`);
          }
          console.log('  Nothing is lost, but new sessions no longer write there. Consolidate');
          console.log('  them into the main store (dry-run by default) with:');
          console.log('    node scripts/maintenance/merge-fragmented-state-dbs.js');
        }
        if (stateDb.hasHarnessDb && !stateDb.hasMemoryDb) {
          console.log('  Note: the MCP memory store does not exist yet at');
          console.log(`    ${stateDb.memoryDbPath}`);
          console.log('  It is created automatically the first time a session saves state.');
        }
        if (!stateDb.hasHarnessDb && stateDb.hasMemoryDb) {
          console.log('  Note: the CLI event store does not exist yet at');
          console.log(`    ${stateDb.dbPath}`);
          console.log('  Run: egc init  to create it');
        }
      }
    }

    process.exitCode = hasIssues ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
