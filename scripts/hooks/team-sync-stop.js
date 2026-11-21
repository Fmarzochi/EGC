#!/usr/bin/env node
'use strict';

// The Team Brain push at the end of a response, for the hosts whose stop
// hook EGC wires for nothing else (GitHub Copilot first): the sync runs when
// the team asks for it and a state document changed since the last run (the
// first run pushes whatever is new), the way Claude Code's Stop hook pushes.
// The payload carries nothing the push needs, the outcome goes to the EGC
// log, and the answer is always empty, so the host never receives a decision
// or a message from here. The answer goes out before the sync, as Claude's
// stop hook does, so the end of the response never waits on the remote.

const fs = require('node:fs');

async function main() {
  try {
    fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR: a missing payload changes nothing
    // keep going
  }
  process.stdout.write('{}');
  try {
    const { autosync } = require('../lib/team-autosync');
    await autosync({ reason: 'session-end', onlyIfStateChanged: true });
  } catch (_) { // NOSONAR: a push that could not run is a log line, never a broken turn
    // the answer is already out
  }
}

main().catch(() => process.exit(0));
