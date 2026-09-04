#!/usr/bin/env node
'use strict';

const { PORT } = require('./port');
const { postEvent } = require('./telemetry-client');

const IDE   = process.argv[2] || 'trae';
const EVENT = process.argv[3] || 'session_start';

function post(ev) {
  // One shot: the process ends as soon as the dashboard answers or fails.
  postEvent(ev, { port: PORT, onDone: () => process.exit(0) });
}

post({ ide:IDE, event:EVENT, agent:'main', status:'running', detail:'' });