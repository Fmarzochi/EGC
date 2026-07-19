#!/usr/bin/env node
'use strict';

// egc gain: the full Token Crusher savings panel. Reads the local JSONL
// ledger only and prints to the terminal, so the report itself costs zero
// tokens. `egc saved` stays as the short summary; gain is the detailed view.

const { readAll, aggregate, metricsFilePath } = require('./lib/crusher/metrics');

const BAR_WIDTH = 24;

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function bar(fraction, width = BAR_WIDTH) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function main() {
  const json = process.argv.includes('--json');
  const entries = readAll();
  const totals = aggregate(entries);

  if (json) {
    console.log(JSON.stringify({ ...totals, entries: entries.length }, null, 2));
    return;
  }

  if (totals.runs === 0) {
    console.log('EGC Token Gain: no crushed runs recorded yet.');
    console.log('Route commands through "egc run <cmd>" to start saving.');
    return;
  }

  const pct = totals.bytesIn > 0 ? (1 - totals.bytesOut / totals.bytesIn) : 0;
  const avg = Math.round(totals.tokensSaved / totals.runs);
  const biggest = entries.reduce(
    (top, e) => ((e.tokensSaved || 0) > (top.tokensSaved || 0) ? e : top),
    entries[0]
  );

  console.log('EGC Token Gain (local ledger, zero token cost)');
  console.log('═'.repeat(52));
  console.log('');
  console.log(`  Crushed runs:     ${totals.runs}`);
  console.log(`  Output size:      ${formatBytes(totals.bytesIn)} -> ${formatBytes(totals.bytesOut)}`);
  console.log(`  Tokens saved:     ~${formatTokens(totals.tokensSaved)}`);
  console.log(`  Avg per run:      ~${formatTokens(avg)} tokens`);
  if (biggest && biggest.command) {
    console.log(`  Biggest crush:    ~${formatTokens(biggest.tokensSaved || 0)} tokens (${biggest.command})`);
  }
  console.log(`  Efficiency:       ${bar(pct)} ${(pct * 100).toFixed(1)}%`);
  console.log('');

  const kinds = Object.entries(totals.byKind).sort((a, b) => b[1].tokensSaved - a[1].tokensSaved);
  if (kinds.length > 0) {
    console.log('  By command kind');
    console.log('  ' + '─'.repeat(50));
    const top = kinds[0][1].tokensSaved || 1;
    for (const [kind, k] of kinds) {
      console.log(
        `  ${kind.padEnd(14)} ${String(k.runs).padStart(4)} runs  ` +
        `~${formatTokens(k.tokensSaved).padStart(7)}  ${bar(k.tokensSaved / top, 10)}`
      );
    }
    console.log('');
  }

  console.log(`  Ledger: ${metricsFilePath()}`);
}

main();
