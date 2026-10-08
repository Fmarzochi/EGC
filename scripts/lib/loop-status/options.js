'use strict';

/**
 * Option parsing and defaults for scripts/loop-status.js.
 */

const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASH_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_LIMIT = 10;
const DEFAULT_WAKE_GRACE_MULTIPLIER = 2;
const DEFAULT_WATCH_INTERVAL_SECONDS = 5;

function usage() {
  console.log([
    'Usage:',
    '  node scripts/loop-status.js [--json] [--home <dir>] [--limit <n>] [--watch]',
    '  node scripts/loop-status.js --transcript <session.jsonl> [--json] [--watch]',
    '',
    'Options:',
    '  --json                         Emit machine-readable status JSON',
    '  --home <dir>                   Override the home directory to scan',
    '  --transcript <session.jsonl>    Inspect one transcript directly',
    '  --limit <n>                    Maximum recent transcripts to inspect (default: 10)',
    '  --bash-timeout-seconds <n>     Age before a pending Bash call is stale (default: 1800)',
    '  --wake-grace-multiplier <n>    ScheduleWakeup grace multiplier (default: 2)',
    '  --now <time>                   Override current time (ISO, epoch ms, or "now")',
    '  --exit-code                    Exit 2 on attention signals, 1 on scan errors',
    '  --watch                        Refresh status until interrupted',
    '  --watch-count <n>              Stop after n watch refreshes',
    '  --watch-interval-seconds <n>   Seconds between watch refreshes (default: 5)',
    '  --write-dir <dir>              Write index.json and per-session status snapshots',
    '',
    'Examples:',
    '  node scripts/loop-status.js --json',
    '  node scripts/loop-status.js --transcript ~/.gemini/projects/-repo/session.jsonl'
  ].join('\n'));
}

function readValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function readPositiveNumber(value, flagName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flagName} must be a positive number`);
  }
  return number;
}

function readPositiveInteger(value, flagName) {
  const number = readPositiveNumber(value, flagName);
  if (!Number.isInteger(number)) {
    throw new TypeError(`${flagName} must be a positive integer`);
  }
  return number;
}

const PARSE_ARGS_HANDLERS = {
  '--help':                  (opts) => { opts.showHelp = true; return 0; },
  '-h':                      (opts) => { opts.showHelp = true; return 0; },
  '--json':                  (opts) => { opts.json = true; return 0; },
  '--exit-code':             (opts) => { opts.exitCode = true; return 0; },
  '--watch':                 (opts) => { opts.watch = true; return 0; },
  '--home':                  (opts, args, i) => { opts.home = readValue(args, i, '--home'); return 1; },
  '--now':                   (opts, args, i) => { opts.now = readValue(args, i, '--now'); return 1; },
  '--write-dir':             (opts, args, i) => { opts.writeDir = readValue(args, i, '--write-dir'); return 1; },
  '--transcript':            (opts, args, i) => { opts.transcriptPaths.push(readValue(args, i, '--transcript')); return 1; },
  '--limit':                 (opts, args, i) => { opts.limit = readPositiveInteger(readValue(args, i, '--limit'), '--limit'); return 1; },
  '--watch-count':           (opts, args, i) => { opts.watchCount = readPositiveInteger(readValue(args, i, '--watch-count'), '--watch-count'); return 1; },
  '--bash-timeout-seconds':  (opts, args, i) => { opts.bashTimeoutSeconds = readPositiveNumber(readValue(args, i, '--bash-timeout-seconds'), '--bash-timeout-seconds'); return 1; },
  '--wake-grace-multiplier': (opts, args, i) => { opts.wakeGraceMultiplier = readPositiveNumber(readValue(args, i, '--wake-grace-multiplier'), '--wake-grace-multiplier'); return 1; },
  '--watch-interval-seconds':(opts, args, i) => { opts.watchIntervalSeconds = readPositiveNumber(readValue(args, i, '--watch-interval-seconds'), '--watch-interval-seconds'); return 1; },
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    bashTimeoutSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
    exitCode: false,
    home: null,
    json: false,
    limit: DEFAULT_LIMIT,
    now: null,
    showHelp: false,
    transcriptPaths: [],
    watch: false,
    watchCount: null,
    wakeGraceMultiplier: DEFAULT_WAKE_GRACE_MULTIPLIER,
    watchIntervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS,
    writeDir: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const handler = PARSE_ARGS_HANDLERS[arg];
    if (handler) {
      index += handler(options, args, index);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.exitCode && options.watch && options.watchCount === null) {
    throw new Error('--exit-code with --watch requires --watch-count so the process can exit');
  }

  return options;
}

function normalizeOptions(options = {}) {
  return {
    ...options,
    bashTimeoutSeconds: options.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
    exitCode: Boolean(options.exitCode),
    limit: options.limit ?? DEFAULT_LIMIT,
    transcriptPaths: options.transcriptPaths || [],
    watch: Boolean(options.watch),
    watchCount: options.watchCount ?? null,
    wakeGraceMultiplier: options.wakeGraceMultiplier ?? DEFAULT_WAKE_GRACE_MULTIPLIER,
    watchIntervalSeconds: options.watchIntervalSeconds ?? DEFAULT_WATCH_INTERVAL_SECONDS,
    writeDir: options.writeDir || null,
  };
}

function getHomeDir(options = {}) {
  if (options.home) {
    return path.resolve(options.home);
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getNow(options = {}) {
  if (!options.now) {
    return new Date();
  }

  if (options.now === 'now') {
    return new Date();
  }

  const now = /^\d+$/.test(String(options.now))
    ? new Date(Number(options.now))
    : new Date(options.now);
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('--now must be a valid timestamp');
  }
  return now;
}

module.exports = {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  DEFAULT_LIMIT,
  DEFAULT_WAKE_GRACE_MULTIPLIER,
  DEFAULT_WATCH_INTERVAL_SECONDS,
  getHomeDir,
  getNow,
  normalizeOptions,
  parseArgs,
  usage,
};
