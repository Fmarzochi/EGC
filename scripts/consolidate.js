#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_THRESHOLD,
  WORKING_WINDOW_DAYS,
  EPISODIC_WINDOW_DAYS,
  stateFilePath,
  consolidateState,
  backupStateFile,
} = require('./lib/state-consolidate');

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/consolidate.js [--dry-run] [--force] [--json] [--project <path>] [--threshold <lines>]

Compact the project state file (~/.egc/state/<slug>.md) when it grows past a
line threshold (default: ${DEFAULT_THRESHOLD}, override with --threshold or the
EGC_CONSOLIDATE_THRESHOLD environment variable).

Rule-based layering by entry age:
  Working layer   last ${WORKING_WINDOW_DAYS} days, kept verbatim
  Episodic layer  last ${EPISODIC_WINDOW_DAYS} days, summarized per week
  Semantic layer  older entries, condensed to core facts

Entry dates are extracted from the entry text (YYYY-MM-DD or DD/MM/YYYY).
Entries without a recognizable date are treated as semantic layer. The
Context and Next Session sections are never layered, only deduplicated.

The original file is always copied to ~/.egc/state/archive/ before rewrite.

Options:
  --dry-run            Preview the consolidated output without writing
  --force              Consolidate even when below the threshold
  --json               Emit a machine-readable report
  --project <path>     Project root (defaults to the current directory)
  --threshold <lines>  Line count that triggers consolidation
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    dryRun: false,
    force: false,
    json: false,
    project: null,
    threshold: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--project') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --project');
      }
      parsed.project = value;
      index += 1;
    } else if (arg === '--threshold') {
      parsed.threshold = Number.parseInt(args[index + 1], 10);
      if (!Number.isInteger(parsed.threshold) || parsed.threshold < 1) {
        throw new Error(`Invalid threshold: ${args[index + 1]}`);
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function resolveThreshold(options) {
  if (options.threshold) return options.threshold;

  const fromEnv = Number.parseInt(process.env.EGC_CONSOLIDATE_THRESHOLD || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;

  return DEFAULT_THRESHOLD;
}

function printHuman(report) {
  console.log('State consolidation report:\n');
  console.log(`- Project: ${report.project}`);
  console.log(`- State file: ${report.stateFile}`);

  if (report.status === 'missing') {
    console.log('- Status: MISSING (no state file for this project yet)');
    return;
  }

  if (report.status === 'skipped') {
    console.log(`- Status: SKIPPED (${report.linesBefore} lines, threshold ${report.threshold})`);
    console.log('- Nothing to consolidate. Use --force to run anyway.');
    return;
  }

  console.log(`- Status: ${report.dryRun ? 'DRY-RUN' : 'CONSOLIDATED'}`);
  console.log(`- Lines: ${report.linesBefore} before, ${report.linesAfter} after (threshold ${report.threshold})`);
  console.log(`- Working entries kept verbatim: ${report.stats.workingKept}`);
  console.log(`- Episodic weeks summarized: ${report.stats.episodicWeeks}`);
  console.log(`- Semantic facts condensed: ${report.stats.semanticFacts}`);
  console.log(`- Duplicates removed: ${report.stats.duplicatesRemoved}`);

  if (report.backup) {
    console.log(`- Backup: ${report.backup}`);
  }

  if (report.dryRun) {
    console.log('\nPreview of consolidated state:\n');
    console.log(report.output);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const project = path.resolve(options.project || process.cwd());
    const stateFile = stateFilePath(homeDir, project);
    const threshold = resolveThreshold(options);

    const report = {
      project,
      stateFile,
      threshold,
      dryRun: options.dryRun,
      status: 'skipped',
      backup: null,
    };

    if (!fs.existsSync(stateFile)) {
      handleMissingState(report, options);
      return;
    }

    const content = fs.readFileSync(stateFile, 'utf8');
    const result = consolidateState(content, { threshold });

    report.linesBefore = result.linesBefore;
    report.linesAfter = result.linesAfter;
    report.stats = result.stats;

    if (!result.needed && !options.force) {
      handleNotNeeded(report, options);
      return;
    }

    performConsolidation(report, result, stateFile, homeDir, options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function handleMissingState(report, options) {
  report.status = 'missing';
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

function handleNotNeeded(report, options) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

function performConsolidation(report, result, stateFile, homeDir, options) {
  report.status = options.dryRun ? 'dry-run' : 'consolidated';

  if (options.dryRun) {
    report.output = result.output;
  } else {
    report.backup = backupStateFile(homeDir, stateFile);
    fs.writeFileSync(stateFile, result.output, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman({ ...report, output: result.output });
  }
}

main();
