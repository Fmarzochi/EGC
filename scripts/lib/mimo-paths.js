'use strict';

const os = require('node:os');
const path = require('node:path');

function resolveMimoConfigDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const mimocodeHome = process.env.MIMOCODE_HOME;
  if (mimocodeHome && path.isAbsolute(mimocodeHome)) return path.join(mimocodeHome, 'config');
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'mimocode');
}

module.exports = { resolveMimoConfigDir };
