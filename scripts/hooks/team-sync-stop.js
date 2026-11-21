#!/usr/bin/env node
'use strict';

// The Team Brain push at the end of a response, for the hosts whose stop
// hook EGC wires for nothing else (GitHub Copilot first): the sync runs when
// the team asks for it and a state document changed since the last run, the
// way Claude Code's Stop hook pushes. The payload carries nothing the push
// needs, the outcome goes to the EGC log, and the answer is always empty, so
// the host never receives a decision or a message from here.

const fs = require('node:fs');

async function main() {
  try {
    fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR: a missing payload changes nothing
    // keep going
  }
  try {
    const { autosync } = require('../lib/team-autosync');
    await autosync({ reason: 'session-end', onlyIfStateChanged: true });
  } catch (_) { // NOSONAR: a push that could not run is a log line, never a broken turn
    // keep the empty answer
  }
  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
  process.exit(0);
});
