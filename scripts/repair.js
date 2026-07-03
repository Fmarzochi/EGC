#!/usr/bin/env node

const os = require('os');
const { repairInstalledStates } = require('./lib/install-lifecycle');
const { SUPPORTED_INSTALL_TARGETS } = require('./lib/install-manifests');
const { reinstallAllPlugins, listInstalledPlugins } = require('./lib/plugin-registry');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/repair.js [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--dry-run] [--json]

Rebuild EGC-managed files recorded in install-state for the current context.
Also reinstalls all plugins from the plugin lock file.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    targets: [],
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--target') {
      parsed.targets.push(args[index + 1] || null);
      index += 1;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
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

function printHuman(result) {
  if (result.results.length === 0) {
    console.log('No EGC install-state files found for the current home/project context.');
    return;
  }

  console.log('Repair summary:\n');
  for (const entry of result.results) {
    console.log(`- ${entry.adapter.id}`);
    console.log(`  Status: ${entry.status.toUpperCase()}`);
    console.log(`  Install-state: ${entry.installStatePath}`);

    if (entry.error) {
      console.log(`  Error: ${entry.error}`);
      continue;
    }

    const paths = result.dryRun ? entry.plannedRepairs : entry.repairedPaths;
    console.log(`  ${result.dryRun ? 'Planned repairs' : 'Repaired paths'}: ${paths.length}`);
  }

  console.log(`\nSummary: checked=${result.summary.checkedCount}, ${result.dryRun ? 'planned' : 'repaired'}=${result.dryRun ? result.summary.plannedRepairCount : result.summary.repairedCount}, errors=${result.summary.errorCount}`);
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const result = repairInstalledStates({
      repoRoot: require('path').join(__dirname, '..'),
      homeDir: process.env.HOME || process.env.USERPROFILE || os.homedir(),
      projectRoot: process.cwd(),
      targets: options.targets,
      dryRun: options.dryRun,
    });
    const hasErrors = result.summary.errorCount > 0;
    let pluginResults = [];

    if (!options.dryRun) {
      const plugins = listInstalledPlugins();
      if (plugins.length > 0) {
        pluginResults = reinstallAllPlugins();
      }
    }

    if (options.json) {
      if (pluginResults.length > 0) {
        result.pluginRepairs = pluginResults;
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
      if (pluginResults.length > 0) {
        console.log('\nPlugin reinstall:\n');
        for (const p of pluginResults) {
          const icon = p.success ? '\u2713' : '\u2717';
          console.log(`  ${icon} ${p.name}${p.success ? '' : ': ' + (p.errors || []).join(', ')}`);
        }
      }
    }

    const pluginErrors = pluginResults.filter(p => !p.success).length;
    process.exitCode = (hasErrors || pluginErrors > 0) ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
