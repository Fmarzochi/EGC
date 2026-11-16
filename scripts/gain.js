#!/usr/bin/env node
'use strict';

// egc gain: the full Token Crusher savings panel. Reads the local JSONL
// ledger only and prints to the terminal, so the report itself costs zero
// tokens. `egc saved` stays as the short summary; gain is the detailed view.

const { readAll, metricsFilePath, aggregate } = require('./lib/crusher/metrics');
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalTimestamp(ts) {
  const date = new Date(ts);
  if (!ts || Number.isNaN(date.getTime())) {
    return String(ts || '').replace('T', ' ').slice(0, 16);
  }
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${day} ${time} ${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
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
    const when = formatLocalTimestamp(entry.ts);
    console.log(
      `  ${when}  ${String(entry.kind || '?').padEnd(12)} ` +
      `~${formatTokens(entry.tokensSaved || 0).padStart(7)} saved  ${entry.cmd || ''}`
    );
  }
}

// The numbers a person can paste anywhere (#2139): totals, kinds and layers,
// nothing that names the machine, a project or a session. The kinds are the
// crusher's own categories (git-log, npm-install, ...), never a command line.
const SHARE_TOP_KINDS = 5;

function shareReport(entries) {
  const totals = aggregate(entries);
  const efficiency = totals.bytesIn > 0 ? Math.round((1 - totals.bytesOut / totals.bytesIn) * 100) : 0;
  const byKind = Object.fromEntries(
    Object.entries(totals.byKind)
      .sort((a, b) => b[1].tokensSaved - a[1].tokensSaved)
      .map(([kind, value]) => [kind, { runs: value.runs, tokensSaved: value.tokensSaved }])
  );
  const byLayer = Object.fromEntries(
    Object.entries(totals.byLayer || {}).map(([layer, value]) => [layer, { runs: value.runs, tokensSaved: value.tokensSaved }])
  );
  return { runs: totals.runs, bytesIn: totals.bytesIn, bytesOut: totals.bytesOut, tokensSaved: totals.tokensSaved, efficiency, byKind, byLayer };
}

function printShare(report) {
  if (report.runs === 0) {
    console.log('EGC Token Crusher: no crushed runs recorded yet, nothing to share.');
    return;
  }
  const kinds = Object.entries(report.byKind).slice(0, SHARE_TOP_KINDS)
    .map(([kind, value]) => `${kind} ~${formatTokens(value.tokensSaved)}`).join(', ');
  const layers = Object.entries(report.byLayer)
    .map(([layer, value]) => `${layer} ~${formatTokens(value.tokensSaved)}`).join(', ');
  console.log('### EGC Token Crusher savings');
  console.log('');
  console.log('| Metric | Value |');
  console.log('|---|---|');
  console.log(`| Crushed runs | ${report.runs} |`);
  console.log(`| Output before | ${formatBytes(report.bytesIn)} |`);
  console.log(`| Output after | ${formatBytes(report.bytesOut)} |`);
  console.log(`| Tokens saved | ~${formatTokens(report.tokensSaved)} |`);
  console.log(`| Efficiency | ${report.efficiency}% |`);
  console.log('');
  console.log(`By command kind: ${kinds}`);
  console.log(`By layer: ${layers}`);
  console.log('');
  console.log('Measured locally by EGC (egc gain --share); no machine, project or session identifiers.');
}

function printScopedTokens(label, totals, unavailableMessage) {
  const value = totals?.available === false
    ? unavailableMessage
    : `~${formatTokens(totals?.tokensSaved || 0)} tokens`;
  console.log(`  ${label.padEnd(20)} ${value}`);
}

// The two forms that read the raw entry list and print before the ledger
// snapshot: --share and --history. Every other path uses a single
// savingsLedgerOp() snapshot so the entry count and aggregate totals always
// describe the same read (fixes double-read race reported in review).
function printEarlyForm(argv, json) {
  if (argv.includes('--share')) {
    const report = shareReport(readAll());
    if (json) console.log(JSON.stringify(report, null, 2));
    else printShare(report);
    return true;
  }
  if (argv.includes('--history')) {
    const entries = readAll();
    if (json) console.log(JSON.stringify(entries, null, 2));
    else printHistory(entries);
    return true;
  }
  return false;
}

function main() {
  const json = process.argv.includes('--json');
  if (printEarlyForm(process.argv, json)) return;

  const report = savingsLedgerOp();
  const totals = report.sinceInstall;

  if (json) {
    // Preserve the existing top-level lifetime fields while adding the scoped
    // report. Derive entry count from report.runs: both come from the same
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

  // The shim compresses by itself whatever the harness runs; egc run is the
  // prefix typed by a person or written by a hook. The split says how much of
  // the saving arrived without anyone asking for it.
  const layers = Object.entries(totals.byLayer || {}).sort((a, b) => b[1].tokensSaved - a[1].tokensSaved);
  if (layers.length > 0) {
    console.log('  By layer (shim: automatic, run: the egc run prefix)');
    console.log('  ' + '─'.repeat(50));
    const top = layers[0][1].tokensSaved || 1;
    for (const [layer, layerTotals] of layers) {
      console.log(
        `  ${layer.padEnd(14)} ${String(layerTotals.runs).padStart(4)} runs  ` +
        `~${formatTokens(layerTotals.tokensSaved).padStart(7)}  ${bar(layerTotals.tokensSaved / top, 10)}`
      );
    }
    console.log('');
  }

  console.log(`  Ledger: ${metricsFilePath()}`);
}

main();
