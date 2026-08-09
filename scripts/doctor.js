#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const operations = require('./lib/operations');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
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

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const report = operations.execute('doctor.report', {
      repoRoot: options.repoRoot || path.join(__dirname, '..'),
      homeDir,
      projectRoot: process.cwd(),
      targets: options.targets
    });
    const hasIssues = report.summary.errorCount > 0 || report.summary.warningCount > 0;
    const stateDb = report.stateDb;

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
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
