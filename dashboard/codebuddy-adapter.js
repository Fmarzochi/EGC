#!/usr/bin/env node
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 7890;
const WATCH_PATHS = [
  path.join(os.homedir(), '.codebuddy', 'logs'),
  path.join(os.homedir(), '.config', 'codebuddy', 'logs'),
];

const LOG_EXTENSIONS     = new Set(['.log', '.jsonl', '.json', '.txt']);
const IGNORED_EXTENSIONS = new Set(['.tmp', '.swp', '.lock', '.bak', '.orig']);
const DEBOUNCE_MS = 200;

function post(ev) {
  const body = JSON.stringify(ev);
  const req = http.request(
    { hostname:'127.0.0.1', port:PORT, path:'/event', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      timeout:300 },
    ()=>{}
  );
  req.on('error', ()=>{});
  req.on('timeout', ()=>req.destroy());
  req.end(body);
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
