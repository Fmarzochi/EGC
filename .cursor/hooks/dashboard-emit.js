#!/usr/bin/env node
'use strict';

const { readStdin } = require('./adapter');
const http = require('http');

// Resolve port inline — this hook may be installed outside the repo tree,
// so a relative require to dashboard/port.js is not safe.
const _egcRaw = process.env.EGC_PORT;
const _egcParsed = (_egcRaw && /^\d+$/.test(_egcRaw)) ? Number(_egcRaw) : NaN;
const PORT = (!Number.isNaN(_egcParsed) && _egcParsed >= 1 && _egcParsed <= 65535) ? _egcParsed : 7890;

readStdin().then(raw => {
  try {
    const input = JSON.parse(raw || '{}');
    const event = process.env.EGC_HOOK_EVENT || 'pre_tool';
    const tool  = input.tool || input.tool_name || '';
    const file  = input.path || input.file || input.file_path || input.command || '';
    const agent = 'main';

    const ev = JSON.stringify({ ide:'cursor', event, tool, agent, detail:file, status: event==='pre_tool'?'running':'success' });
    const req = http.request(
      { hostname:'127.0.0.1', port:PORT, path:'/event', method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(ev)},
        timeout:300 },
      ()=>{}
    );
    req.on('error', ()=>{});
    req.on('timeout', ()=>req.destroy());
    req.end(ev);
  } catch(_) {}
  process.stdout.write(raw || '');
}).catch(()=>{});
