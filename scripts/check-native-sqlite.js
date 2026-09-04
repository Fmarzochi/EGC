#!/usr/bin/env node
'use strict';

// Tells the installers whether the native sqlite3 binary loads on this
// machine. EGC keeps working without it (the CLI and the MCP servers fall
// back to the portable sql.js engine, with full-text search degraded to
// substring matching), so the answer is a note, not an error: exit 0 when
// the binary loads, 1 with the reason on stderr when it does not.

function main() {
  try {
    require('sqlite3');
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0];
    console.error(reason);
    process.exit(1);
  }
}

main();
