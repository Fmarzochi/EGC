#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { recallAtK, reciprocalRank, percentile, estimateTokens, mean } = require('./metrics.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TASKS = path.join(REPO_ROOT, 'benchmarks', 'egc', 'tasks.json');
const USAGE = 'usage: node scripts/bench/run.js [--tasks <file>] [--project <dir>] [--top <n>] [--runs <n>] [--out <file.json>] [--min-recall <0..1>]';

function parse(argv) {
  const opts = { tasks: DEFAULT_TASKS, project: REPO_ROOT, top: 10, runs: 3, out: null, minRecall: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--tasks') opts.tasks = path.resolve(argv[++i]);
    else if (a === '--project') opts.project = path.resolve(argv[++i]);
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--runs') opts.runs = Number(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--min-recall') opts.minRecall = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.help) return opts;
  if (!Number.isInteger(opts.top) || opts.top < 1) throw new Error('--top must be a positive integer');
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
  if (opts.minRecall !== null && !(opts.minRecall >= 0 && opts.minRecall <= 1)) throw new Error('--min-recall must be between 0 and 1');
  return opts;
}

function loadTasks(file) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) throw new Error(`no tasks in ${file}`);
  for (const t of spec.tasks) {
    if (!t.id || !t.query || !Array.isArray(t.expected) || t.expected.length === 0) {
      throw new Error(`task needs id, query and a non-empty expected list: ${JSON.stringify(t)}`);
    }
  }
  return spec.tasks;
}

function wholeFileChars(projectRoot, rels) {
  let chars = 0;
  for (const rel of rels) {
    try {
      chars += fs.readFileSync(path.join(projectRoot, rel), 'utf8').length;
    } catch {
      // a missing expected file adds nothing to the baseline
    }
  }
  return chars;
}

async function runTask(rank, task, opts) {
  const latencies = [];
  let last = null;
  for (let i = 0; i < opts.runs; i++) {
    const t0 = process.hrtime.bigint();
    last = await rank({ projectPath: opts.project, query: task.query, topN: opts.top, useGit: false });
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const ranked = last.ranked.map(f => f.path.replace(/\\/g, '/'));
  const briefingChars = last.briefing.length;
  const baselineChars = wholeFileChars(opts.project, task.expected);
  return {
    id: task.id,
    query: task.query,
    recallAt5: recallAtK(ranked, task.expected, 5),
    recallAtTop: recallAtK(ranked, task.expected, opts.top),
    reciprocalRank: reciprocalRank(ranked, task.expected),
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    briefingTokens: estimateTokens(briefingChars),
    wholeFileTokens: estimateTokens(baselineChars),
    topPaths: ranked.slice(0, 5)
  };
}

function summarise(rows) {
  return {
    tasks: rows.length,
    meanRecallAt5: mean(rows.map(r => r.recallAt5)),
    meanRecallAtTop: mean(rows.map(r => r.recallAtTop)),
    meanReciprocalRank: mean(rows.map(r => r.reciprocalRank)),
    latencyMsP50: percentile(rows.map(r => r.latencyMsP50), 50),
    latencyMsP95: percentile(rows.map(r => r.latencyMsP95), 95),
    briefingTokensTotal: rows.reduce((a, r) => a + r.briefingTokens, 0),
    wholeFileTokensTotal: rows.reduce((a, r) => a + r.wholeFileTokens, 0)
  };
}

function table(rows, summary, opts) {
  const f = x => x.toFixed(2);
  const lines = [];
  lines.push(`task                 recall@5  recall@${opts.top}  mrr   p50ms   p95ms   briefing  whole-file`);
  for (const r of rows) {
    lines.push(
      `${r.id.padEnd(20)} ${f(r.recallAt5).padStart(8)}  ${f(r.recallAtTop).padStart(10)}  ${f(r.reciprocalRank).padStart(4)}  ` +
      `${f(r.latencyMsP50).padStart(6)}  ${f(r.latencyMsP95).padStart(6)}  ${String(r.briefingTokens).padStart(8)}  ${String(r.wholeFileTokens).padStart(10)}`
    );
  }
  lines.push('');
  lines.push(`mean recall@5 ${f(summary.meanRecallAt5)}, mean recall@${opts.top} ${f(summary.meanRecallAtTop)}, mean MRR ${f(summary.meanReciprocalRank)}`);
  lines.push(`latency p50 ${f(summary.latencyMsP50)} ms, p95 ${f(summary.latencyMsP95)} ms (end to end, index rebuilt per call)`);
  lines.push(`tokens: briefing ${summary.briefingTokensTotal} vs whole expected files ${summary.wholeFileTokensTotal}`);
  lines.push('  (the briefing lists paths only; an agent that opens the top files pays for them too)');
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const buildPath = path.join(REPO_ROOT, 'mcp', 'servers', 'egc-guardian', 'build', 'file-rank.js');
  if (!fs.existsSync(buildPath)) {
    process.stderr.write('egc bench: guardian build not found; run npm run build in mcp/servers/egc-guardian\n');
    return 2;
  }
  const { rankProjectFiles } = await import(pathToFileURL(buildPath).href);
  const tasks = loadTasks(opts.tasks);
  const rows = [];
  for (const task of tasks) rows.push(await runTask(rankProjectFiles, task, opts));
  const summary = summarise(rows);
  process.stdout.write(table(rows, summary, opts) + '\n');
  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: { top: opts.top, runs: opts.runs, project: opts.project }, summary, rows }, null, 2) + '\n');
  }
  if (opts.minRecall !== null && summary.meanRecallAtTop < opts.minRecall) {
    process.stderr.write(`mean recall@${opts.top} ${summary.meanRecallAtTop.toFixed(2)} is below --min-recall ${opts.minRecall}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { parse, loadTasks, summarise };
