'use strict';

const os = require('node:os');
const path = require('node:path');

const { createOpenCodeForkHomeAdapter } = require('./opencode-fork-home');

function resolveKiloConfigDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env.XDG_CONFIG_HOME;
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, '.config'), 'kilo');
}

const baseAdapter = createOpenCodeForkHomeAdapter({
  id: 'kilo-home',
  target: 'kilo',
  resolveRoot: resolveKiloConfigDir,
});

module.exports = Object.freeze({ ...baseAdapter, resolveKiloConfigDir });
