#!/usr/bin/env node

const {
  collectProjectStates,
  renderOverviewMarkdown,
} = require('./lib/state-overview');

function showHelp(exitCode = 0) {
  console.log(`
Usage: egc overview [--json] [--state-dir <path>]

Aggregated read-only view of every per-project memory state under
~/.egc/state. Projects write their own state; this command only reads.

Options:
  --state-dir <path>  Read states from an alternate root (default: ~/.egc/state)
  --json              Emit the aggregated overview as JSON
  --help, -h          Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { json: false, stateDir: null, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--state-dir') {
      parsed.stateDir = args[index + 1] || null;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const overview = collectProjectStates({ stateDir: options.stateDir });

    if (options.json) {
      console.log(JSON.stringify(overview, null, 2));
    } else {
      process.stdout.write(renderOverviewMarkdown(overview));
    }

    process.exitCode = overview.entries.some(entry => entry.error) ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
