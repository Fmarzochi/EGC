'use strict';

const path = require('node:path');

// The CLI event store has one home, the egc/ store under the shared .egc
// directory, whatever tool the process runs inside. It used to follow
// getEGCDir(), which routes to the active harness directory under a harness
// variable (GEMINI_PROJECT_DIR, CLAUDE_PROJECT_DIR, ...) and to the first
// installed harness on a HOME that has no .egc yet; egc doctor, the merge
// script and the memory server all treat the shared location as canonical,
// so a store born under a tool was reported as a stray copy the moment the
// doctor ran from a plain terminal. EGC_DIR stays the explicit override;
// sessions, learned skills and install state keep following getEGCDir().
function canonicalStoreUnder(homeDir) {
  return path.join(homeDir, '.egc', 'egc', 'state.db');
}

function resolveStateStorePath(options = {}) {
  if (options.dbPath) {
    return options.dbPath === ':memory:' ? options.dbPath : path.resolve(options.dbPath);
  }
  if (options.homeDir) {
    return canonicalStoreUnder(path.resolve(options.homeDir));
  }
  if (process.env.EGC_DIR) {
    return path.join(process.env.EGC_DIR, 'egc', 'state.db');
  }
  const { getHomeDir } = require('../utils');
  return canonicalStoreUnder(getHomeDir());
}

module.exports = { resolveStateStorePath };
