'use strict';

// Session-transcript directories of the supported harnesses, in the same
// spirit as the install manifests: data about where each integrated tool
// keeps its logs, kept out of the scanning logic. Extend this list as more
// harnesses expose comparable transcript formats.

const os = require('node:os');
const path = require('node:path');

function transcriptRoots() {
  if (process.env.EGC_DISCOVER_DIR) return [process.env.EGC_DISCOVER_DIR];
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'projects'),
  ];
}

module.exports = { transcriptRoots };
