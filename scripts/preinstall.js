#!/usr/bin/env node
'use strict';

if (process.platform === 'win32') process.exit(0);

const fs = require('fs');
const path = require('path');

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
      '  or with fnm:\n' +
      '    brew install fnm && fnm install --lts && fnm use lts-latest\n' +
      '\n' +
      '  See: https://github.com/Fmarzochi/EGC/blob/main/TROUBLESHOOTING.md\n' +
      '\n'
    );
    process.exit(1);
  }
}
