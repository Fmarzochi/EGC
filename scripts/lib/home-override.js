'use strict';

const os = require('node:os');
const path = require('node:path');

function resolveHomeOverride(input, variable, defaultSegments) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env[variable];
  if (configured) {
    const homeRelative = configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\'));
    if (configured === '~' || homeRelative) return path.join(home, configured.slice(1));
    return path.resolve(configured);
  }
  return path.join(home, ...defaultSegments);
}

module.exports = { resolveHomeOverride };
