'use strict';

// Shared stdout writer for bash hooks whose contract allows returning either
// a pass-through string or a structured decision object.
function writeHookResult(result) {
  process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
}

module.exports = { writeHookResult };
