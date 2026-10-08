#!/usr/bin/env node
'use strict';

const { normalizeOptions, parseArgs, usage } = require('./lib/loop-status/options');
const { analyzeTranscript, buildStatus } = require('./lib/loop-status/analysis');
const { tryWriteStatusSnapshots, writeStatusSnapshots } = require('./lib/loop-status/snapshots');
const { extractToolResultIds, extractToolUses } = require('./lib/loop-status/transcript');

function formatSignals(signals) {
  if (signals.length === 0) {
    return 'none';
  }
  return signals.map(signal => signal.type).join(', ');
}

function formatText(payload) {
  const skippedLines = payload.errors.map(error => `  - ${error.transcriptPath}: ${error.message}`);

  if (payload.sessions.length === 0) {
    const lines = [
      `EGC loop status (${payload.generatedAt})`,
      skippedLines.length > 0
        ? 'No readable Gemini transcript JSONL files were found.'
        : `No Gemini transcript JSONL files found under ${payload.source.transcriptRoot}.`,
    ];
    if (skippedLines.length > 0) {
      lines.push(
        'Skipped transcript errors:',
        ...skippedLines
      );
    }
    return lines.join('\n');
  }

  const lines = [`EGC loop status (${payload.generatedAt})`];
  for (const session of payload.sessions) {
    lines.push(
      `- ${session.sessionId} [${session.state}] ${session.transcriptPath}`,
      `  last event: ${session.lastEventAt || 'unknown'}; events: ${session.eventCount}`,
      `  signals: ${formatSignals(session.signals)}`,
      `  action: ${session.recommendedAction}`
    );
  }
  if (skippedLines.length > 0) {
    lines.push(
      'Skipped transcript errors:',
      ...skippedLines
    );
  }
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeStatus(payload, options) {
  if (options.json) {
    console.log(options.watch ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
  } else {
    console.log(formatText(payload));
  }
}

function getStatusExitCode(payload) {
  if (payload.sessions.some(session => session.state === 'attention')) {
    return 2;
  }
  if (payload.errors.length > 0) {
    return 1;
  }
  return 0;
}

async function runWatch(options) {
  const normalizedOptions = normalizeOptions(options);
  let iteration = 0;
  let exitCode = 0;

  while (normalizedOptions.watchCount === null || iteration < normalizedOptions.watchCount) {
    if (iteration > 0 && !normalizedOptions.json) {
      console.log('');
    }
    const payload = buildStatus(normalizedOptions);
    tryWriteStatusSnapshots(payload, normalizedOptions);
    writeStatus(payload, normalizedOptions);
    exitCode = Math.max(exitCode, getStatusExitCode(payload));
    iteration += 1;

    if (normalizedOptions.watchCount !== null && iteration >= normalizedOptions.watchCount) {
      break;
    }

    await sleep(normalizedOptions.watchIntervalSeconds * 1000); // NOSONAR: each watch reading waits for the interval before the next one on purpose (S9382)
  }

  return exitCode;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.showHelp) {
    usage();
    return;
  }

  if (options.watch) {
    const exitCode = await runWatch(options);
    if (options.exitCode) {
      process.exitCode = exitCode;
    }
    return;
  }

  const payload = buildStatus(options);
  tryWriteStatusSnapshots(payload, options);
  writeStatus(payload, options);
  if (options.exitCode) {
    process.exitCode = getStatusExitCode(payload);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[loop-status] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  analyzeTranscript,
  buildStatus,
  extractToolResultIds,
  extractToolUses,
  getStatusExitCode,
  parseArgs,
  runWatch,
  tryWriteStatusSnapshots,
  writeStatusSnapshots,
};