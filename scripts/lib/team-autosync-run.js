#!/usr/bin/env node
'use strict';

// The Team Brain sync as one child process. The hosts whose turn hook cannot
// wait on a promise (Amp's plugin, the adapters that answer on stdout) spawn
// this runner and wait for it inside a budget. Arguments: --reason <name>,
// --budget <ms>, --only-if-changed. Prints one JSON object with the outcome
// of team-autosync's autosync() and always exits 0: a sync that failed is a
// log line, never a broken turn.

const fs = require('node:fs');
const { autosync } = require('./team-autosync');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const budget = Number.parseInt(argValue('--budget', ''), 10);
  let outcome;
  try {
    outcome = await autosync({
      reason: argValue('--reason', 'turn'),
      onlyIfStateChanged: process.argv.includes('--only-if-changed'),
      budgetMs: Number.isInteger(budget) && budget > 0 ? budget : undefined,
    });
  } catch (error) {
    outcome = { ran: false, why: 'error', detail: error?.message || String(error) };
  }
  fs.writeSync(1, JSON.stringify(outcome));
  process.exit(0);
}

main();
