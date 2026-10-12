'use strict';

const os = require('node:os');
const path = require('node:path');

function resolvePiAgentDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) return path.join(home, configured.slice(1));
    return path.resolve(configured);
  }
  return path.join(home, '.pi', 'agent');
}

module.exports = { resolvePiAgentDir };
