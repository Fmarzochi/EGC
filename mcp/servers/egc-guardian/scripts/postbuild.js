#!/usr/bin/env node
'use strict';

// Replaces `chmod +x build/index.js`, which is not a command on Windows at
// all: outside Git Bash the build step simply failed there. fs.chmodSync is
// skipped on Windows and does the right thing everywhere else, so the same
// build script now works on every platform without a shell.

// ESM, because this package declares "type": "module".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(scriptDir, '..', 'build', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`postbuild: ${entry} was not produced by the compile step`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fs.chmodSync(entry, 0o755);
}
