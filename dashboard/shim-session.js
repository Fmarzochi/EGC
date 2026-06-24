#!/usr/bin/env node
'use strict';

const http = require('http');

const IDE   = process.argv[2] || 'trae';
const EVENT = process.argv[3] || 'session_start';

function post(ev) {
  const body = JSON.stringify(ev);
  const req = http.request(
    { hostname:'127.0.0.1', port:7890, path:'/event', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      timeout:300 },
    ()=>{}
  );
  req.on('error', ()=>{});
  req.on('timeout', ()=>req.destroy());
  req.end(body);
}

post({ ide:IDE, event:EVENT, agent:'main', status:'running', detail:'' });
