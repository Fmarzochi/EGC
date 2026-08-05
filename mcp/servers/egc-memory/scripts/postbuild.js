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
  fs.chmodSync(entry, 0o755);
}
