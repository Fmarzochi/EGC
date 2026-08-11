#!/usr/bin/env node
'use strict';

// egc gain: the full Token Crusher savings panel. Reads the local JSONL
// ledger only and prints to the terminal, so the report itself costs zero
// tokens. `egc saved` stays as the short summary; gain is the detailed view.

const { readAll, metricsFilePath } = require('./lib/crusher/metrics');
const { savingsLedger: savingsLedgerOp } = require('./lib/operations/index');


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

function printHistory(entries) {
  if (entries.length === 0) {
    console.log('EGC Token Gain: no crushed runs recorded yet.');
    console.log('Route commands through "egc run <cmd>" to start saving.');
    return;
  }
  console.log('EGC Token Gain: run history (most recent last)');
  console.log('═'.repeat(52));
  const recent = entries.slice(-30);
  if (entries.length > recent.length) {
    console.log(`  ... ${entries.length - recent.length} earlier run(s) omitted`);
  }
  for (const entry of recent) {
    const when = (entry.ts || '').replace('T', ' ').slice(0, 16);
    console.log(
      `  ${when}  ${String(entry.kind || '?').padEnd(12)} ` +
      `~${formatTokens(entry.tokensSaved || 0).padStart(7)} saved  ${entry.cmd || ''}`
    );
  }
}

function printScopedTokens(label, totals, unavailableMessage) {
  const value = totals?.available === false
    ? unavailableMessage
    : `~${formatTokens(totals?.tokensSaved || 0)} tokens`;
  console.log(`  ${label.padEnd(20)} ${value}`);
}

function main() {
  const json = process.argv.includes('--json');

  // --history needs the raw entry list; for all other paths we use a single
  // savingsLedgerOp() snapshot so the entry count and aggregate totals always
  // describe the same read (fixes double-read race reported in review).
  if (process.argv.includes('--history')) {
    const entries = readAll();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    printHistory(entries);
    return;
  }

  const report = savingsLedgerOp();
  const totals = report.sinceInstall;

  if (json) {
    // Preserve the existing top-level lifetime fields while adding the scoped
    // report. Derive entry count from report.runs — both come from the same
    // ledger snapshot, avoiding a double-read race.
    // Machine-readable report printed to the caller's own terminal by design:
    // the ledger is local, zero-cost, and --json exists to expose it whole.
    console.log(JSON.stringify({ ...totals, ...report, entries: report.runs }, null, 2)); // NOSONAR jssecurity:S8689
    return;
  }

  if (totals.runs === 0) {
    console.log('EGC Token Gain: no crushed runs recorded yet.');
    console.log('Route commands through "egc run <cmd>" to start saving.');
    return;
  }

  const pct = totals.bytesIn > 0 ? (1 - totals.bytesOut / totals.bytesIn) : 0;

  console.log('EGC Token Gain (local ledger, zero token cost)');
  console.log('═'.repeat(52));
  console.log('');
  printScopedTokens('Today', report.today);
  printScopedTokens('Current session', report.currentSession, 'unavailable (no EGC_SESSION_ID)');
  printScopedTokens('Current project', report.currentProject, 'unavailable');
  printScopedTokens('Since install', report.sinceInstall);
  printScopedTokens('Last 7 days', report.last7Days);
  printScopedTokens('Last 30 days', report.last30Days);
  console.log('');
  console.log(`  Crushed runs:         ${report.runs}`);
  console.log(`  Average per run:      ~${formatTokens(report.averagePerRun)} tokens`);
  if (report.biggest?.cmd) {
    console.log(`  Biggest crush:        ~${formatTokens(report.biggest.tokensSaved)} tokens (${report.biggest.cmd})`);
  }
  console.log(`  Output size:          ${formatBytes(totals.bytesIn)} -> ${formatBytes(totals.bytesOut)}`);
  console.log(`  Efficiency:           ${bar(pct)} ${(pct * 100).toFixed(1)}%`);
  console.log('');

  const kinds = Object.entries(totals.byKind).sort((a, b) => b[1].tokensSaved - a[1].tokensSaved);
  if (kinds.length > 0) {
    console.log('  By command kind');
    console.log('  ' + '─'.repeat(50));
    const top = kinds[0][1].tokensSaved || 1;
    for (const [kind, kindTotals] of kinds) {
      console.log(
        `  ${kind.padEnd(14)} ${String(kindTotals.runs).padStart(4)} runs  ` +
        `~${formatTokens(kindTotals.tokensSaved).padStart(7)}  ${bar(kindTotals.tokensSaved / top, 10)}`
      );
    }
    console.log('');
  }

  console.log(`  Ledger: ${metricsFilePath()}`);
}

main();
