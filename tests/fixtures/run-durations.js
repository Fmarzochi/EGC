'use strict';

/**
 * Per-file timing for tests/run-all.js (opt-in with --durations <file>).
 * The numbers tell a maintainer how long each test file takes, which file
 * bounds the best possible wall time, and what a pool of N workers would
 * need for the same suite. Nothing here schedules or runs anything.
 */

const DEFAULT_WORKERS = 8;

// Longest-processing-time-first list scheduling: the same order a worker pool
// would use, so the estimate is the wall time that pool could reach.
function estimateWallMs(durations, workers) {
  const loads = new Array(workers).fill(0);
  const ordered = [...durations].sort((a, b) => b.ms - a.ms);
  for (const { ms } of ordered) {
    let lightest = 0;
    for (let i = 1; i < loads.length; i++) {
      if (loads[i] < loads[lightest]) lightest = i;
    }
    loads[lightest] += ms;
  }
  return Math.max(0, ...loads);
}

function summarizeDurations(durations, workers = DEFAULT_WORKERS) {
  const jobs = Number.isInteger(workers) && workers > 0 ? workers : DEFAULT_WORKERS;
  const totalMs = durations.reduce((sum, entry) => sum + entry.ms, 0);
  const longest = durations.reduce(
    (best, entry) => (best === null || entry.ms > best.ms ? entry : best),
    null
  );
  return {
    files: durations.length,
    totalMs,
    longest,
    workers: jobs,
    estimatedWallMs: estimateWallMs(durations, jobs)
  };
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDurationReport(summary) {
  if (summary.files === 0) return 'Durations: no test file was timed.';
  return [
    `Durations: ${summary.files} files, ${formatSeconds(summary.totalMs)} in total`,
    `  Longest file:      ${summary.longest.file} (${formatSeconds(summary.longest.ms)})`,
    `  ${summary.workers} workers would need: ${formatSeconds(summary.estimatedWallMs)} (estimate, longest first)`
  ].join('\n');
}

function parseDurationsFlag(argv) {
  const index = argv.findIndex(arg => arg === '--durations' || arg.startsWith('--durations='));
  if (index === -1) return null;
  const arg = argv[index];
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--durations needs a file path, e.g. --durations durations.json');
  }
  return value;
}

module.exports = {
  DEFAULT_WORKERS,
  estimateWallMs,
  summarizeDurations,
  formatDurationReport,
  parseDurationsFlag
};
