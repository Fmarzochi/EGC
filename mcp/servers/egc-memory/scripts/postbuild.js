#!/usr/bin/env node
'use strict';

// Replaces `chmod +x build/index.js`, which is not a command on Windows at
// all: outside Git Bash the build step simply failed there. fs.chmodSync is
// skipped on Windows and does the right thing everywhere else, so the same
// build script now works on every platform without a shell.

const fs = require('node:fs');
const path = require('node:path');

const entry = path.join(__dirname, '..', 'build', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`postbuild: ${entry} was not produced by the compile step`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  // Add the owner's execute bit to whatever mode the compiler produced,
  // rather than forcing 0o755. The server is always run by the user who
  // installed it, so world-execute buys nothing, and a fixed mode would
  // also widen read access on a file the compiler had written more
  // narrowly.
  const { mode } = fs.statSync(entry);
  fs.chmodSync(entry, mode | 0o100);
}
