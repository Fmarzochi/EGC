'use strict';

const { resolveHomeOverride } = require('./home-override');

function resolvePiAgentDir(input = {}) {
  return resolveHomeOverride(input, 'PI_CODING_AGENT_DIR', ['.pi', 'agent']);
}

module.exports = { resolvePiAgentDir };
