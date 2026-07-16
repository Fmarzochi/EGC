#!/usr/bin/env node
'use strict';

const _nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (_nodeMajor < 20) {
  process.stderr.write(
    '\n' +
    '  Error: EGC requires Node.js 20 or later (found: ' + process.version + ').\n' +
    (_nodeMajor === 18
      ? '  Node 18 reached end-of-life in March 2025 and is no longer supported.\n'
      : '') +
    '  Update Node.js: https://nodejs.org/en/download\n' +
    '\n'
  );
  process.exit(1);
}

if (process.platform === 'win32') process.exit(0);

const fs = require('node:fs');
const path = require('node:path');

if (process.env.npm_config_global !== 'true') process.exit(0);

const prefix = process.env.npm_config_prefix;
if (!prefix) process.exit(0);

const candidates = [
  path.join(prefix, 'lib', 'node_modules'),
  path.join(prefix, 'lib'),
  prefix,
];

const checkDir = candidates.find(d => fs.existsSync(d)) || prefix;

try {
  fs.accessSync(checkDir, fs.constants.W_OK);
} catch (e) {
  if (e.code === 'EACCES') {
    process.stderr.write(
      '\n' +
      '  Permission error: ' + checkDir + ' is not writable.\n' +
      '\n' +
      '  Your Node.js is installed system-wide. npm cannot install\n' +
      '  global packages without sudo. Fix it with nvm or fnm:\n' +
      '\n' +
      '    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n' +
      '    # restart terminal, then:\n' +
      '    nvm install --lts && nvm use --lts\n' +
      '\n' +
      '  or with fnm (add eval "$(fnm env --use-on-cd)" to your shell profile first):\n' +
      '    brew install fnm && fnm install --lts && fnm use lts-latest\n' +
      '\n' +
      '  See: https://github.com/Fmarzochi/EGC/blob/main/docs/TROUBLESHOOTING.md\n' +
      '\n'
    );
    process.exit(1);
  }
}
