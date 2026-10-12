'use strict';

const os = require('node:os');
const path = require('node:path');

function resolveHomeOverride(input, variable, defaultSegments) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env[variable];
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) return path.join(home, configured.slice(1));
    return path.resolve(configured);
  }
  return path.join(home, ...defaultSegments);
}

module.exports = { resolveHomeOverride };
