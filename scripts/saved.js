#!/usr/bin/env node
'use strict';

// egc saved: prints the accumulated Token Crusher savings. Everything here is
// read from the local JSONL ledger and printed to the terminal only, so the
// report itself costs zero tokens.

const { readAll, aggregate, metricsFilePath } = require('./lib/crusher/metrics');

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function main() {
  const json = process.argv.includes('--json');
  const entries = readAll();
  const totals = aggregate(entries);

  if (json) {
    console.log(JSON.stringify(totals, null, 2));
    return;
  }

  if (totals.runs === 0) {
    console.log('Token Crusher: no crushed runs recorded yet.\nRoute commands through "egc run <cmd>" to start saving.');
    return;
  }

  const pct = totals.bytesIn > 0 ? Math.round((1 - totals.bytesOut / totals.bytesIn) * 100) : 0;
  console.log('Token Crusher savings (local ledger, zero token cost)');
  console.log('');
  console.log(`  Crushed runs:   ${totals.runs}`);
  console.log(`  Output size:    ${formatBytes(totals.bytesIn)} -> ${formatBytes(totals.bytesOut)} (${pct}% smaller)`);
  console.log(`  Tokens saved:   ~${totals.tokensSaved}`);
  console.log('');
  for (const [kind, k] of Object.entries(totals.byKind)) {
    console.log(`  ${kind.padEnd(12)} ${String(k.runs).padStart(4)} runs   ~${k.tokensSaved} tokens`);
  }
  console.log('');
  console.log(`  Ledger: ${metricsFilePath()}`);
}

main();
