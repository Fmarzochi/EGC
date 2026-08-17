#!/usr/bin/env node
'use strict';

// Manual Scrubber CLI (the secondary, on-demand mode). The write hook cleans
// files as they are written; this cleans files that already exist, a whole
// tree, or piped text. Deterministic Layer A only: invisible Unicode, space
// look-alikes, and long dashes. Refuses binary input.
//
// Usage:
//   node scrubber-cli.js inspect <file|->            report suspicious characters (JSON)
//   node scrubber-cli.js clean   <file> [-o OUT]     write OUT (default: *.cleaned.EXT)
//   node scrubber-cli.js clean   <file> --in-place   overwrite the file
//   node scrubber-cli.js clean   -                   clean stdin to stdout
// Flags: --aggressive (normalize cross-script look-alikes), --no-dashes,
//        --json (clean prints the stats report to stderr).

const fs = require('node:fs');
const path = require('node:path');
const { inspect, clean } = require('../lib/scrubber/engine');
const { looksBinary } = require('../lib/scrubber/binary-guard');

function readInput(source) {
  if (source === '-' || source === undefined) {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(source, 'utf8');
}

function cleanedPath(file) {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.cleaned${ext}`;
}

function parseFlags(args) {
  const outIndex = args.indexOf('-o');
  return {
    aggressive: args.includes('--aggressive'),
    normalizeDashes: !args.includes('--no-dashes'),
    inPlace: args.includes('--in-place'),
    json: args.includes('--json'),
    out: outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : null,
  };
}

function runInspect(source) {
  const text = readInput(source);
  const binary = looksBinary(text);
  if (binary) {
    process.stderr.write(`refusing to inspect ${source || 'stdin'} as text: it looks like ${binary}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(inspect(text), null, 2)}\n`);
  return 0;
}

function runClean(source, flags) {
  const text = readInput(source);
  const binary = looksBinary(text);
  if (binary) {
    process.stderr.write(`refusing to clean ${source || 'stdin'} as text: it looks like ${binary}\n`);
    return 2;
  }
  const result = clean(text, { aggressive: flags.aggressive, normalizeDashes: flags.normalizeDashes });

  if (source === '-' || source === undefined) {
    process.stdout.write(result.cleaned);
    if (result.cleaned && !result.cleaned.endsWith('\n')) process.stdout.write('\n');
  } else {
    const dest = flags.inPlace ? source : flags.out || cleanedPath(source);
    fs.writeFileSync(dest, result.cleaned);
    process.stderr.write(`wrote ${dest}\n`);
  }

  if (flags.json) process.stderr.write(`${JSON.stringify(result.stats, null, 2)}\n`);
  return 0;
}

function main(argv) {
  const [command, source, ...rest] = argv.slice(2);
  const flags = parseFlags([source, ...rest].filter(a => a !== undefined));

  if (command === 'inspect') return runInspect(source);
  if (command === 'clean') return runClean(source, flags);

  process.stderr.write('usage: scrubber-cli.js <inspect|clean> <file|-> [-o OUT] [--in-place] [--aggressive] [--no-dashes] [--json]\n');
  return 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    process.stderr.write(`scrubber-cli error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, cleanedPath };
