'use strict';

const { createOpenCodeForkHomeAdapter } = require('./opencode-fork-home');
const { resolveMimoConfigDir } = require('../mimo-paths');

const baseAdapter = createOpenCodeForkHomeAdapter({
  id: 'mimo-home',
  target: 'mimo',
  resolveRoot: resolveMimoConfigDir,
});

module.exports = Object.freeze({ ...baseAdapter, resolveMimoConfigDir });
