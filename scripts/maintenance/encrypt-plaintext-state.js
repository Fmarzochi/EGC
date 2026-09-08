#!/usr/bin/env node
'use strict';

// Encrypts, in place, the state files that are still plain text: files
// older than the encryption at rest of 1.1.6, files the EGC hooks saved
// before 1.1.18, and files an AI tool wrote straight to disk because it had
// no egc-memory server (#1395). Dry run by default: it lists what it would
// encrypt and changes nothing; --apply writes. Each file is rewritten
// through the same path the hooks use (encrypt, temp file, rename, 0600,
// HMAC sidecar) under the per-file merge lock, so a memory server saving
// the same file at the same moment cannot interleave with it, and the
// ciphertext is read back and decrypted before the file counts as done.

const os = require('node:os');
const { findPlaintextStateFiles, readPlainStateFile } = require('../lib/state-plaintext');
const { saveState, withStateFileLockSync } = require('../lib/state-snapshot');
const { readStateFileDecrypted } = require('../lib/state-crypto');

const { env } = process;

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/maintenance/encrypt-plaintext-state.js [--apply] [--json]

Encrypt the plain-text state files under the EGC state directory in place.

Without --apply nothing is written: the files that would be encrypted are
listed with their size and last write. With --apply each one is encrypted
with the EGC encryption key (created if absent), rewritten atomically with
the integrity sidecar, and read back before it counts. A file that changed
between the listing and the write, or that is no longer a plain regular
file, is skipped and reported.

Options:
  --apply   Encrypt the listed files (default is a dry run)
  --json    Print the report as JSON
  --help    Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { apply: false, json: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// One file: re-read through the checked descriptor under the lock (the
// listing is not trusted after the fact), encrypt, then prove the result
// decrypts back to the exact content before reporting it as done. The
// read-back is injectable so the mismatch path can be exercised by a test.
function encryptOne(filePath, readBack = readStateFileDecrypted) {
  return withStateFileLockSync(filePath, () => {
    const content = readPlainStateFile(filePath);
    if (content === null) return { path: filePath, status: 'skipped', reason: 'no longer a plain regular file' };
    saveState(filePath, content);
    const roundTrip = readBack(filePath);
    if (roundTrip !== content) {
      return { path: filePath, status: 'failed', reason: 'the encrypted file did not read back as the original content' };
    }
    return { path: filePath, status: 'encrypted' };
  });
}

function encryptAll(files) {
  const results = [];
  for (const file of files) {
    try {
      results.push(encryptOne(file.path));
    } catch (error) {
      results.push({ path: file.path, status: 'failed', reason: error.message });
    }
  }
  return results;
}

function printReport(report) {
  const { scan, apply, results } = report;
  if (scan.count === 0) {
    console.log(`No plain-text state file under ${scan.stateDir} (${scan.checked} checked). Nothing to do.`);
    return;
  }
  const noun = scan.count === 1 ? 'file' : 'files';
  console.log(`${apply ? 'Encrypting' : 'Would encrypt'} ${scan.count} plain-text state ${noun} under ${scan.stateDir} (${scan.checked} checked):`);
  for (const file of scan.files) {
    const outcome = results.find(result => result.path === file.path);
    const suffix = outcome && outcome.status !== 'encrypted' ? ` -> ${outcome.status}: ${outcome.reason}` : '';
    console.log(`  ${file.path} (${file.sizeBytes} bytes, last write ${file.modifiedAt})${suffix}`);
  }
  if (!apply) {
    console.log('\nDry run: nothing was written. Run the same command with --apply at the end to encrypt them.');
    return;
  }
  const counts = { encrypted: 0, skipped: 0, failed: 0 };
  for (const result of results) counts[result.status] += 1;
  console.log(`\nEncrypted ${counts.encrypted}, skipped ${counts.skipped}, failed ${counts.failed}.`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    showHelp(1);
  }
  if (options.help) showHelp(0);

  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  const scan = findPlaintextStateFiles(homeDir);
  const results = options.apply ? encryptAll(scan.files) : [];
  const report = { apply: options.apply, scan, results };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exitCode = results.some(result => result.status === 'failed') ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = { encryptOne, encryptAll, parseArgs };
