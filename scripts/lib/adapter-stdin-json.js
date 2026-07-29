'use strict';

// Shared truncation-aware stdin JSON reader for host-hook adapters
// (Windsurf, Cursor, and future hosts with the same "one JSON event object
// on stdin" contract). A parse failure caused by hitting the size cap is
// not the same as ordinary malformed input: an attacker can pad a command
// past MAX_STDIN specifically to land here and dodge validation. Callers
// get a `truncated` flag so they can fail closed on that case while still
// failing open on genuinely malformed (non-truncated) input, matching the
// policy every adapter using this module needs.

const MAX_STDIN = 1024 * 1024;

function readAdapterStdinJson(onComplete) {
  let raw = '';
  let truncated = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
    if (raw.length >= MAX_STDIN) {
      truncated = true;
    }
  });
  process.stdin.on('end', () => {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      onComplete({ ok: false, truncated });
      return;
    }
    onComplete({ ok: true, truncated, value });
  });
}

module.exports = { MAX_STDIN, readAdapterStdinJson };
