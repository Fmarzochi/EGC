'use strict';

/**
 * Accumulates raw request-body Buffer chunks and decodes them as UTF-8 only
 * once, at the end.
 *
 * Concatenating with `body += chunk` implicitly calls `chunk.toString('utf8')`
 * on each chunk in isolation. When a multi-byte character (accented paths,
 * CJK usernames, emoji) is split across two chunks, each half decodes on its
 * own and turns into replacement-character garbage. Buffering the raw bytes
 * and decoding once, after every chunk has arrived, avoids that. See
 * Fmarzochi/EGC#916.
 */
function createBodyCollector() {
  const chunks = [];
  let size = 0;

  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      return size;
    },
    size() {
      return size;
    },
    toString() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

module.exports = { createBodyCollector };
