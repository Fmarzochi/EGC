#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { PORT } = require('./port');
const { postEvent } = require('./telemetry-client');
const WATCH_PATHS = [
  path.join(os.homedir(), '.codebuddy', 'logs'),
  path.join(os.homedir(), '.config', 'codebuddy', 'logs'),
];

const LOG_EXTENSIONS     = new Set(['.log', '.jsonl', '.json', '.txt']);
const IGNORED_EXTENSIONS = new Set(['.tmp', '.swp', '.lock', '.bak', '.orig']);
const DEBOUNCE_MS = 200;

function post(ev) {
  postEvent(ev, { port: PORT });
}

function watchLogDir(dir) {
  if (!fs.existsSync(dir)) return false;

  const debounceMap = new Map(); // { filename -> { timer, fired } }

  fs.watch(dir, { persistent:false }, (evt, filename) => {
    if (!filename) return;

    const ext = path.extname(filename).toLowerCase();
    if (IGNORED_EXTENSIONS.has(ext)) return;
    if (!LOG_EXTENSIONS.has(ext)) return;

    const state = debounceMap.get(filename) || { timer: null, fired: false };

    if (state.timer) clearTimeout(state.timer);

    if (!state.fired) {
      state.fired = true;
      try {
        post({ ide:'codebuddy', event:'pre_tool', tool:'CodeBuddy', agent:'main', detail:filename, status:'running' });
      } catch(_) {}
    }

    state.timer = setTimeout(() => {
      debounceMap.delete(filename);
      try {
        post({ ide:'codebuddy', event:'post_tool', tool:'CodeBuddy', agent:'main', status:'success' });
      } catch(_) {}
    }, DEBOUNCE_MS);

    debounceMap.set(filename, state);
  });

  console.log(`Watching CodeBuddy logs: ${dir}`);
  return true;
}

let started = false;
function init() {
  for (const dir of WATCH_PATHS) {
    if (watchLogDir(dir)) { started = true; break; }
  }
  if (!started) console.log('CodeBuddy not found. Adapter will retry.');
}
init();
setInterval(()=>{ if (!started) init(); }, 15000);
