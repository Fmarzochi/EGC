#!/usr/bin/env node
/**
 * PostToolUse Hook: Accumulate edited JS/TS file paths for batch processing
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Records each edited JS/TS path to a session-scoped temp file (one path per
 * line). stop-format-typecheck.js reads this list at Stop time and runs format
 * + typecheck once across all edited files, eliminating per-edit latency.
 *
 * appendFileSync is used so concurrent hook processes write atomically
 * without overwriting each other. Deduplication is deferred to the Stop hook.
 */

'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { appendLineNoFollow } = require('../lib/no-follow-accumulator');

const MAX_STDIN = 1024 * 1024;

function getAccumFile() {
  const raw =
    process.env.EGC_SESSION_ID ||
    process.env.ECC_SESSION_ID ||
    crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
  // Strip path separators and traversal sequences so the value is safe to embed
  // directly in a filename regardless of what EGC_SESSION_ID contains.
  const sessionId = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), `egc-edited-${sessionId}.txt`);
}

/**
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {string} The original input (pass-through)
 */
const JS_TS_EXT = /\.(ts|tsx|js|jsx)$/;

// The accumulator's name is predictable (derived from EGC_SESSION_ID or a
// hash of cwd) and lives in the world-writable system temp dir, so another
// local process could plant a symlink at that path ahead of the first
// write, or simply pre-create it as an ordinary file (no O_CREAT race to
// win for that), redirecting or exposing every append. appendLineNoFollow
// refuses both: a symlinked final component, and (via its uid check) a
// file this process does not own. A path containing a newline is dropped
// rather than written: stop-format-typecheck.js parses the accumulator one
// path per line, so embedding one would let a single malformed path
// masquerade as two, injecting an arbitrary extra entry that the Stop hook
// would later run the formatter's --write against.
function appendPath(filePath) {
  if (!filePath || !JS_TS_EXT.test(filePath) || /[\r\n]/.test(filePath)) return;
  appendLineNoFollow(getAccumFile(), filePath + '\n');
}

/**
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {string} The original input (pass-through)
 */
function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    // Edit / Write: single file_path
    appendPath(input.tool_input?.file_path);
    // MultiEdit: array of edits, each with its own file_path
    const edits = input.tool_input?.edits;
    if (Array.isArray(edits)) {
      for (const edit of edits) appendPath(edit?.file_path);
    }
  } catch {
    // Invalid input: pass through
  }
  return rawInput;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    process.stdout.write(run(data));
    process.exit(0);
  });
}

module.exports = { run };
