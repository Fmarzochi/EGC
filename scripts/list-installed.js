#!/usr/bin/env node

const os = require('os');
const { discoverInstalledStates } = require('./lib/install-lifecycle');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/list-installed.js [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--json]

Inspect EGC install-state files for the current home/project context.
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

function printHuman(records) {
  if (records.length === 0) {
    console.log('No EGC install-state files found for the current home/project context.');
    return;
  }

  for (const record of records) {
    console.log(`\n- ${record.adapter.id} (${record.adapter.target})`);
    console.log(`  Install-state: ${record.installStatePath}`);

    if (!record.exists) {
      console.log('  Status: not installed');
      continue;
    }

    if (record.error) {
      console.log(`  Status: error (${record.error})`);
      continue;
    }

    const state = record.state;
    if (!state) {
      console.log('  Status: missing');
      continue;
    }

    const { request, resolution, source } = state;
    const profile = request.profile || '(custom)';
    const modules = resolution.selectedModules || [];
    const skipped = resolution.skippedModules || [];
    const version = source.repoVersion || '(unknown)';

    console.log(`  Status: installed`);
    console.log(`  Profile: ${profile}`);
    console.log(`  Source version: ${version}`);
    console.log(`  Installed at: ${state.installedAt}`);
    console.log(`  Modules (${modules.length}): ${modules.join(', ')}`);
    if (skipped.length > 0) {
      console.log(`  Skipped (${skipped.length}): ${skipped.join(', ')}`);
    }
  }
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const records = discoverInstalledStates({
      homeDir: process.env.HOME || os.homedir(),
      projectRoot: process.cwd(),
      targets: options.targets,
    });

    if (options.json) {
      const installed = records.filter(r => r.exists);
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), records: installed }, null, 2));
    } else {
      printHuman(records);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
