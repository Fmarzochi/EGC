'use strict';

/**
 * Decides which test files could run side by side. A static scan proposes
 * (shared state a file cannot hide: a fixed port, a fixed temp name, a
 * process.chdir) and the checked-in manifest decides: a maintainer pins a file
 * to serial, or frees one the scan holds back, with one line and a reason.
 * Nothing here runs a test or changes tests/run-all.js.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'serial-manifest.json');
const MODES = ['serial', 'parallel'];

const HAZARDS = [
  {
    name: 'chdir',
    describe: 'changes the working directory of its process',
    findIn: line => /\bprocess\.chdir\s*\(/.test(line)
  },
  {
    name: 'fixed-port',
    describe: 'listens on a fixed port',
    findIn: line => /\.listen\s*\(\s*[1-9]\d*\b/.test(line) || /\bport\s*[:=]\s*[1-9]\d{3,4}\b/i.test(line)
  },
  {
    name: 'fixed-temp-name',
    describe: 'writes under a temp name that does not change from run to run',
    findIn: line => !/mkdtemp/.test(line) && /\btmpdir\(\)\s*,\s*(['"`])[^'"`$]+\1\s*[,)]/.test(line)
  }
];

function scanSource(source) {
  const found = new Set();
  for (const line of source.split('\n')) {
    for (const hazard of HAZARDS) {
      if (hazard.findIn(line)) found.add(hazard.name);
    }
  }
  return HAZARDS.map(hazard => hazard.name).filter(name => found.has(name));
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('serial manifest: "files" must be an array');
  const byFile = new Map();
  for (const entry of entries) {
    const file = entry && typeof entry.file === 'string' ? entry.file.trim() : '';
    if (!file || file.includes('\\') || path.isAbsolute(file)) {
      throw new Error(`serial manifest: "file" must be a relative path with forward slashes (${JSON.stringify(entry && entry.file)})`);
    }
    if (!MODES.includes(entry.mode)) {
      throw new Error(`serial manifest: ${file} needs "mode" to be one of ${MODES.join(', ')}`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`serial manifest: ${file} needs a "reason"`);
    }
    if (byFile.has(file)) throw new Error(`serial manifest: ${file} is listed twice`);
    byFile.set(file, { mode: entry.mode, reason: entry.reason.trim() });
  }
  return byFile;
}

function loadManifest(manifestPath = MANIFEST_PATH) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return normalizeEntries(parsed.files);
}

function classifyFile(file, source, manifest) {
  const pinned = manifest.get(file);
  if (pinned) {
    return { file, serial: pinned.mode === 'serial', decidedBy: 'manifest', reasons: [pinned.reason], hazards: scanSource(source) };
  }
  const hazards = scanSource(source);
  return { file, serial: hazards.length > 0, decidedBy: hazards.length > 0 ? 'scan' : 'none', reasons: hazards, hazards };
}

function classifyTestFiles(files, readSource, manifest) {
  const known = new Set(files);
  for (const file of manifest.keys()) {
    if (!known.has(file)) throw new Error(`serial manifest: ${file} is not a test file`);
  }
  return files.map(file => classifyFile(file, readSource(file), manifest));
}

function walkTestFiles(dir, base, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTestFiles(fullPath, base, acc);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      acc.push(path.relative(base, fullPath).split(path.sep).join('/'));
    }
  }
  return acc;
}

function discoverTestFiles(testsDir) {
  return walkTestFiles(testsDir, testsDir, []).sort();
}

function formatClassification(results) {
  const serial = results.filter(result => result.serial);
  const lines = [
    `Test files: ${results.length}, independent: ${results.length - serial.length}, serial: ${serial.length}`
  ];
  for (const result of serial) {
    lines.push(`  serial  ${result.file}  [${result.decidedBy}] ${result.reasons.join(', ')}`);
  }
  const freed = results.filter(result => !result.serial && result.decidedBy === 'manifest' && result.hazards.length > 0);
  for (const result of freed) {
    lines.push(`  freed   ${result.file}  [manifest] ${result.reasons.join(', ')} (scan held it for ${result.hazards.join(', ')})`);
  }
  return lines.join('\n');
}

function main() {
  const testsDir = path.join(__dirname, '..');
  const files = discoverTestFiles(testsDir);
  const results = classifyTestFiles(files, file => fs.readFileSync(path.join(testsDir, file), 'utf8'), loadManifest());
  console.log(formatClassification(results));
}

if (require.main === module) main();

module.exports = {
  HAZARDS,
  MANIFEST_PATH,
  scanSource,
  normalizeEntries,
  loadManifest,
  classifyFile,
  classifyTestFiles,
  discoverTestFiles,
  formatClassification
};
