'use strict';

// Shared stdin reader for hook scripts and runners.
// Limits input to 1 MiB (1024 * 1024 bytes), tracks truncation across
// both byte-cap and stream error boundaries, and provides consistent
// error handling and empty input handling across all hooks.

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_STDIN = MAX_HOOK_INPUT_BYTES;
const TRUNCATED_INPUT_MESSAGE =
  'Hook input was cut off (over 1 MiB or the stream failed); refusing to act on a partial payload.';

function reportCallbackFailure(error) {
  const detail = error && error.message ? error.message : String(error);
  process.stderr.write(`[hook-stdin] hook callback failed: ${detail}\n`);
  process.exitCode = 1;
}

// A hook that gates or rewrites a payload must not act on a prefix of it: a
// blocker passes exitCode 2 to deny, a hook that only annotates passes 0 to
// step aside without echoing the partial text.
function exitOnTruncatedInput(truncated, exitCode) {
  if (!truncated) return;
  process.stderr.write(`${TRUNCATED_INPUT_MESSAGE}\n`);
  process.exit(exitCode);
}

function readHookStdin(onRead, optionsOrStream = process.stdin) {
  let stream = process.stdin;
  let maxBytes = MAX_HOOK_INPUT_BYTES;

  if (optionsOrStream) {
    if (typeof optionsOrStream.on === 'function') {
      stream = optionsOrStream;
    } else if (typeof optionsOrStream === 'object') {
      if (optionsOrStream.stream && typeof optionsOrStream.stream.on === 'function') {
        stream = optionsOrStream.stream;
      }
      if (typeof optionsOrStream.maxBytes === 'number' && optionsOrStream.maxBytes >= 0) {
        maxBytes = optionsOrStream.maxBytes;
      }
    }
  }

  const chunks = [];
  let kept = 0;
  let truncated = false;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (typeof onRead === 'function') {
      try {
        const res = onRead({ raw: Buffer.concat(chunks).toString('utf8'), truncated });
        if (res && typeof res.catch === 'function') {
          res.catch(reportCallbackFailure);
        }
      } catch (error) {
        reportCallbackFailure(error);
      }
    }
  };

  stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = maxBytes - kept;
    if (bytes.length > room) truncated = true;
    if (room > 0) {
      const part = bytes.subarray(0, room);
      chunks.push(part);
      kept += part.length;
    }
  });

  stream.on('end', finish);
  stream.on('error', () => {
    truncated = true;
    finish();
  });
}

function readHookStdinAsync(optionsOrStream = process.stdin) {
  return new Promise(resolve => {
    readHookStdin(resolve, optionsOrStream);
  });
}

const readHookInput = readHookStdin;

module.exports = {
  MAX_HOOK_INPUT_BYTES,
  MAX_STDIN,
  TRUNCATED_INPUT_MESSAGE,
  exitOnTruncatedInput,
  readHookStdin,
  readHookStdinAsync,
  readHookInput,
};
