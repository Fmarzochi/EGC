#!/usr/bin/env node

const os = require('os');
const path = require('path');
const fs = require('fs');
const { buildDoctorReport } = require('./lib/install-lifecycle');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
const { getEGCDir } = require('./lib/utils');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/doctor.js [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--json]

Diagnose drift and missing managed files for EGC install-state in the current context.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    targets: [],
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--target') {
      parsed.targets.push(args[index + 1] || null);
      index += 1;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
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

function checkStateDb() {
  const dbPath = path.join(getEGCDir(), 'egc', 'state.db');
  if (fs.existsSync(dbPath)) return null;
  return { missing: true, dbPath };
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const report = buildDoctorReport({
      repoRoot: path.join(__dirname, '..'),
      homeDir: process.env.HOME || process.env.USERPROFILE || os.homedir(),
      projectRoot: process.cwd(),
      targets: options.targets,
    });
    const hasIssues = report.summary.errorCount > 0 || report.summary.warningCount > 0;
    const stateDb = checkStateDb();

    if (options.json) {
      const out = stateDb ? { ...report, stateDb } : report;
      console.log(JSON.stringify(out, null, 2));
    } else {
      printHuman(report);
      if (stateDb) {
        console.log('\nState store:');
        console.log('  WARNING: state.db not found at ' + stateDb.dbPath);
        console.log('  Run: egc init  to create the state store');
      }
    }

    process.exitCode = hasIssues ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
