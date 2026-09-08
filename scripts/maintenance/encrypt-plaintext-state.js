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

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findPlaintextStateFiles, readPlainStateFile, readEncryptedStateFile } = require('../lib/state-plaintext');
const { saveState, withStateFileLockSync } = require('../lib/state-snapshot');
const { encryptStateBuffer, decryptStateBuffer } = require('../lib/state-crypto');
const { loadOrCreateIntegrityKey, sidecarMatches, hmacPathFor } = require('../lib/state-integrity');

const { env } = process;

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/maintenance/encrypt-plaintext-state.js [--apply] [--json]

Encrypt the plain-text state files under the EGC state directory in place.

Without --apply nothing is written: the files that would be encrypted are
listed with their size and last write. With --apply each one is encrypted
with the EGC encryption key (created if absent), proven to decrypt back in
memory before anything is written, rewritten atomically with the integrity
sidecar, and read back from disk before it counts; if the read-back or the
sidecar fails, the original plain content is put back and the file is
reported as failed. A file that stopped being a plain regular file between
the listing and the write is skipped and reported.

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

function skipped(filePath, reason) {
  return { path: filePath, status: 'skipped', reason };
}

function failed(filePath, reason) {
  return { path: filePath, status: 'failed', reason };
}

// Puts the plain content back after a write that did not verify: a fresh
// exclusive temp file renamed over the path, and the sidecar written for
// the ciphertext removed, so the file is exactly what it was before.
function restorePlain(filePath, content) {
  const tmpPath = path.join(path.dirname(filePath), `.egc-restore-${process.pid}-${crypto.randomUUID()}`);
  try {
    // Private from the first byte: the restored plain file must not be more
    // readable than the ciphertext it replaces.
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* no POSIX bits on this filesystem */ }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed away */ }
  }
  try { fs.unlinkSync(hmacPathFor(filePath)); } catch { /* never written */ }
}

// The integrity key must be usable before anything is written: a missing
// or malformed key would let the ciphertext land and the sidecar fail.
function usableIntegrityKey() {
  const key = loadOrCreateIntegrityKey();
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('the integrity key is missing or malformed; nothing was written');
  }
  return key;
}

// One file: re-read through the checked descriptor under the lock (the
// listing is not trusted after the fact), prove the ciphertext decrypts
// back in memory before anything touches the disk, write, then prove the
// file on disk (read through a checked descriptor, never a link) and its
// sidecar before reporting it as done; any failure after the write puts
// the plain content back. The read-back is injectable so the mismatch and
// error paths can be exercised by a test.
// Whether the parent directory is still a real directory: the lock helper
// creates it when missing, and a skip must never recreate a directory the
// person removed between the listing and the apply pass.
function parentStillDirectory(filePath) {
  try {
    return fs.lstatSync(path.dirname(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function encryptOne(filePath, root, readBack = readEncryptedStateFile) {
  if (!parentStillDirectory(filePath)) return skipped(filePath, 'no longer a plain regular file');
  return withStateFileLockSync(filePath, () => {
    // A read error propagates: a plain file that cannot be read is a
    // failure of this run, never a skip that leaves it plain with exit 0.
    const content = readPlainStateFile(filePath, root);
    if (content === null) return skipped(filePath, 'no longer a plain regular file');
    // The integrity key comes first: the in-memory check below creates the
    // encryption key when it is absent, and a run that stops on the
    // integrity key must leave nothing behind.
    const integrityKey = usableIntegrityKey();
    if (decryptStateBuffer(encryptStateBuffer(content)) !== content) {
      return failed(filePath, 'the content did not survive an encrypt and decrypt round trip in memory; nothing was written');
    }
    saveState(filePath, content);
    let roundTrip;
    try {
      roundTrip = readBack(filePath, root);
    } catch (error) {
      restorePlain(filePath, content);
      return failed(filePath, `the encrypted file could not be read back: ${error.message}; the plain file was put back`);
    }
    if (roundTrip !== content) {
      restorePlain(filePath, content);
      return failed(filePath, 'the encrypted file did not read back as the original content; the plain file was put back');
    }
    if (!sidecarMatches(filePath, content, integrityKey)) {
      restorePlain(filePath, content);
      return failed(filePath, 'the integrity sidecar could not be written; the plain file was put back');
    }
    return { path: filePath, status: 'encrypted' };
  });
}

function encryptAll(files, root) {
  const results = [];
  for (const file of files) {
    try {
      results.push(encryptOne(file.path, root));
    } catch (error) {
      results.push(failed(file.path, error.message));
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
  const results = options.apply ? encryptAll(scan.files, scan.root) : [];
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
