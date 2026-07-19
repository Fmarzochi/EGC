#!/usr/bin/env node
'use strict';

// egc discover: scans recent AI-session transcripts for shell commands whose
// noisy output never went through the Token Crusher and estimates what those
// runs could have saved. Read-only, local files only, zero token cost.
//
// Sources scanned (newest first, last 7 days, capped for speed):
//   ~/.claude/projects/**/*.jsonl  (session transcripts with tool calls)
// The path names a supported harness's data directory, the same way the
// installer targets each harness's own config paths; more harness transcript
// formats can be added to scanRoots as they expose comparable logs.
// EGC_DISCOVER_DIR overrides the scan root (used by tests).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandKind, estimateTokens, MIN_BYTES_TO_CRUSH } = require('./lib/crusher/engine');

const MAX_FILES = 40;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Conservative share of the output the crusher typically removes per kind.
const CRUSH_RATIO = {
  'git-log': 0.9,
  'git-diff': 0.85,
  'test-runner': 0.8,
  'pm-install': 0.85,
  'gh-json': 0.7,
};

function scanRoots() {
  if (process.env.EGC_DISCOVER_DIR) return [process.env.EGC_DISCOVER_DIR];
  return [path.join(os.homedir(), '.claude', 'projects')];
}

function listTranscripts(root) {
  const out = [];
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (Date.now() - stat.mtimeMs <= MAX_AGE_MS) out.push({ full, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map(f => f.full);
}

function textOfResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('');
  }
  return '';
}

function analyzeFile(file, opportunities) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return;
  }
  const pending = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Bash' && block.input && block.input.command) {
        pending.set(block.id, block.input.command);
      } else if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
        const cmd = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        const alreadyCrushed = /(?:^|\s)egc\s+run\s/.test(cmd);
        if (alreadyCrushed) continue;
        const kind = commandKind(cmd);
        if (kind === 'generic') continue;
        const output = textOfResult(block.content);
        const bytes = Buffer.byteLength(output, 'utf8');
        if (bytes < MIN_BYTES_TO_CRUSH) continue;
        const tokens = estimateTokens(output);
        const missed = Math.round(tokens * (CRUSH_RATIO[kind] || 0.7));
        const agg = opportunities.get(kind) || { runs: 0, tokens: 0, missed: 0 };
        agg.runs += 1;
        agg.tokens += tokens;
        agg.missed += missed;
        opportunities.set(kind, agg);
      }
    }
  }
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function main() {
  const json = process.argv.includes('--json');
  const opportunities = new Map();
  let files = 0;
  for (const root of scanRoots()) {
    for (const file of listTranscripts(root)) {
      files += 1;
      analyzeFile(file, opportunities);
    }
  }

  const kinds = [...opportunities.entries()].sort((a, b) => b[1].missed - a[1].missed);
  const totalMissed = kinds.reduce((s, [, k]) => s + k.missed, 0);
  const totalRuns = kinds.reduce((s, [, k]) => s + k.runs, 0);

  if (json) {
    console.log(JSON.stringify({
      filesScanned: files,
      missedRuns: totalRuns,
      potentialTokens: totalMissed,
      byKind: Object.fromEntries(kinds.map(([k, v]) => [k, v])),
    }, null, 2));
    return;
  }

  console.log('EGC Discover: crushable output that skipped the Token Crusher');
  console.log('═'.repeat(60));
  console.log(`  Transcripts scanned: ${files} (last 7 days)`);
  if (totalRuns === 0) {
    console.log('  Nothing found: every crushable command is already covered.');
    return;
  }
  console.log(`  Missed runs:         ${totalRuns}`);
  console.log(`  Potential savings:   up to ~${formatTokens(totalMissed)} tokens`);
  console.log('');
  for (const [kind, k] of kinds) {
    console.log(
      `  ${kind.padEnd(14)} ${String(k.runs).padStart(4)} runs  ` +
      `~${formatTokens(k.tokens).padStart(7)} read  up to ~${formatTokens(k.missed)} recoverable`
    );
  }
  console.log('');
  console.log('  The silent rewrite hook covers simple commands automatically;');
  console.log('  pipelines and compound commands stay untouched by design.');
}

main();
