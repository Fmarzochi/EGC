#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 7890;

const LOG_PATHS = [
  path.join(os.homedir(), '.vscode', 'logs'),
  path.join(os.homedir(), '.vscode-server', 'data', 'logs'),
];

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

function findCopilotLog(dir) {
  if (!fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir, {withFileTypes:true});
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name);
        const files = fs.readdirSync(sub).filter(f=>f.includes('copilot') || f.includes('github'));
        if (files.length) return path.join(sub, files[0]);
      }
    }
  } catch(_) {}
  return null;
}

let watching = false;
let lastSize = 0;

function watch() {
  for (const logDir of LOG_PATHS) {
    const logFile = findCopilotLog(logDir);
    if (!logFile) continue;
    if (watching) break;
    watching = true;
    lastSize = fs.statSync(logFile).size;

    fs.watch(logFile, { persistent:false }, () => {
      try {
        const stat = fs.statSync(logFile);
        if (stat.size < lastSize) lastSize = 0;
        if (stat.size <= lastSize) return;
        const buf = Buffer.alloc(stat.size - lastSize);
        const fd = fs.openSync(logFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;

        const chunk = buf.toString('utf8');
        if (chunk.includes('request') || chunk.includes('completion') || chunk.includes('edit')) {
          post({ ide:'vscode', event:'pre_tool', tool:'Copilot', agent:'main', detail:chunk.slice(0,60).trim(), status:'running' });
          setTimeout(()=>{ post({ ide:'vscode', event:'post_tool', tool:'Copilot', agent:'main', status:'success' }); }, 400);
        }
      } catch(_) {}
    });

    console.log(`Watching VS Code Copilot log: ${logFile}`);
    break;
  }
}

watch();
setInterval(()=>{ if (!watching) watch(); }, 10000);
console.log('EGC VS Code Copilot adapter running');
