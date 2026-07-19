'use strict';

/**
 * Decode a request body accumulated from raw Buffer chunks.
 *
 * Chunks MUST be concatenated as Buffers and decoded once: converting each
 * chunk to a string in isolation corrupts a multi-byte UTF-8 character that
 * happens to be split across two TCP chunks (it decodes as replacement
 * garbage). See EGC#916.
 */
function decodeRequestBody(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { decodeRequestBody };
