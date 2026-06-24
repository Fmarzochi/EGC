#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const os   = require('os');

const WATCH_PATHS = [
  path.join(os.homedir(), '.aider.chat.history.md'),
  path.join(os.homedir(), '.aider.input.history'),
  path.join(process.cwd(), '.aider.chat.history.md'),
];

const PORT = 7890;
let lastSizes = {};

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

function watchFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  lastSizes[filePath] = fs.statSync(filePath).size;

  fs.watch(filePath, { persistent:false }, (evt) => {
    if (evt !== 'change') return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= lastSizes[filePath]) return;

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - lastSizes[filePath]);
      fs.readSync(fd, buf, 0, buf.length, lastSizes[filePath]);
      fs.closeSync(fd);
      lastSizes[filePath] = stat.size;

      const chunk = buf.toString('utf8');
      const toolMatch = chunk.match(/\b(read|edit|write|bash|run)\b/i);
      const tool = toolMatch ? toolMatch[1].charAt(0).toUpperCase() + toolMatch[1].slice(1) : 'Aider';

      post({ ide:'aider', event:'pre_tool', tool, agent:'main', detail:chunk.slice(0,80).trim(), status:'running' });
      setTimeout(()=>{ post({ ide:'aider', event:'post_tool', tool, agent:'main', status:'success' }); }, 500);
    } catch(_) {}
  });
}

WATCH_PATHS.forEach(watchFile);

console.log('EGC Aider watcher running. Watching:', WATCH_PATHS.filter(p=>fs.existsSync(p)));

setInterval(()=>{
  WATCH_PATHS.forEach(p=>{ if(fs.existsSync(p) && !lastSizes[p]) watchFile(p); });
}, 5000);
