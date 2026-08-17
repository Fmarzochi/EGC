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
const { cleanContainer, inspectContainer } = require('../lib/scrubber/container-meta');
const { detectImageFormat, cleanImage, inspectImage } = require('../lib/scrubber/image-meta');

// The name used to route container formats (markdown/html/svg). Stdin has no
// name, so it falls back to a content sniff inside container-meta.
function containerName(source) {
  return source && source !== '-' ? source : '';
}

// The CLI cleans a file the operator explicitly names, so the path is
// operator-provided local input, never network-controlled. Reject null bytes
// and resolve to an absolute path before touching the filesystem.
function safePath(p) {
  if (typeof p !== 'string' || p.includes('\0')) {
    throw new Error('invalid file path');
  }
  return path.resolve(p);
}

// Read raw bytes (never decode yet) so the binary guard sees the true magic
// bytes. Reading a binary as UTF-8 first would mangle those bytes and let a
// container slip past the guard.
function readBytes(source) {
  if (source === '-' || source === undefined) {
    return fs.readFileSync(0);
  }
  return fs.readFileSync(safePath(source)); // NOSONAR: operator-provided local file path, the CLI's purpose is to clean a file the user names, never network-controlled input
}

function writeBytes(dest, data) {
  fs.writeFileSync(safePath(dest), data); // NOSONAR: operator-chosen local output path, never network-controlled input
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

// Refuse binary on the raw buffer, then decode to text.
function textFromBytes(bytes, source) {
  const binary = looksBinary(bytes);
  if (binary) {
    process.stderr.write(`refusing to treat ${source || 'stdin'} as text: it looks like ${binary}\n`);
    return null;
  }
  return bytes.toString('utf8');
}

function writeCleaned(source, flags, data, textMode) {
  if (source === '-' || source === undefined) {
    process.stdout.write(data);
    if (textMode && data.length > 0 && !String(data).endsWith('\n')) process.stdout.write('\n');
  } else {
    const dest = flags.inPlace ? source : flags.out || cleanedPath(source);
    writeBytes(dest, data);
    process.stderr.write(`wrote ${dest}\n`);
  }
}

function runInspect(source) {
  const bytes = readBytes(source);
  const format = detectImageFormat(bytes);
  if (format) {
    process.stdout.write(`${JSON.stringify(inspectImage(bytes), null, 2)}\n`);
    return 0;
  }
  const text = textFromBytes(bytes, source);
  if (text === null) return 2;
  const container = inspectContainer(containerName(source), text);
  const report = inspect(text);
  report.container = { kind: container.kind, findings: container.findings };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function runClean(source, flags) {
  const bytes = readBytes(source);
  const format = detectImageFormat(bytes);
  if (format) {
    const img = cleanImage(bytes);
    if (img.supported && img.valid) {
      // A structurally valid PNG/JPEG: strip metadata blocks, write binary out.
      writeCleaned(source, flags, img.cleaned, false);
      if (flags.json) process.stderr.write(`${JSON.stringify({ format: img.format, removed: img.removed }, null, 2)}\n`);
      return 0;
    }
    if (!img.supported) {
      // Recognized but not yet cleaned: never write an unchanged copy that
      // looks scrubbed. Report honestly and touch nothing.
      process.stderr.write(`note: ${format} is a recognized image format the scrubber does not clean yet; nothing written\n`);
      return 3;
    }
    // A supported format whose structure is malformed falls through to the
    // binary guard below, which refuses a bare magic-byte prefix as binary.
  }
  const text = textFromBytes(bytes, source);
  if (text === null) return 2;
  // Strip container metadata first (markdown/html/svg), then the Layer A pass.
  const container = cleanContainer(containerName(source), text);
  const result = clean(container.cleaned, { aggressive: flags.aggressive, normalizeDashes: flags.normalizeDashes });
  writeCleaned(source, flags, result.cleaned, true);
  if (flags.json) {
    process.stderr.write(`${JSON.stringify({ ...result.stats, container: container.removed }, null, 2)}\n`);
  }
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

module.exports = { main, cleanedPath, safePath, textFromBytes };
