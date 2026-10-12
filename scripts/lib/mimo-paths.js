'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveMimoConfigDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const mimocodeHome = process.env.MIMOCODE_HOME;
  if (mimocodeHome && path.isAbsolute(mimocodeHome)) return path.join(mimocodeHome, 'config');
  const xdg = process.env.XDG_CONFIG_HOME;
  const xdgDir = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'mimocode');
  const dotDir = path.join(home, '.mimocode');
  return !fs.existsSync(xdgDir) && fs.existsSync(dotDir) ? dotDir : xdgDir;
}

module.exports = { resolveMimoConfigDir };
