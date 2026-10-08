#!/usr/bin/env node
/*
 * Copyright 2024 The Link Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const USAGE = 'usage: egc context "<query>" [--project <dir>] [--history <file>|-] [--top <n>] [--no-git] [--explain]';

function parse(argv) {
  const opts = { query: null, project: process.cwd(), history: null, top: 10, git: true, explain: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--history') opts.history = argv[++i];
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--no-git') opts.git = false;
    else if (a === '--explain') opts.explain = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.query === null) opts.query = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.query || !opts.query.trim()) throw new Error('missing query');
  if (!Number.isInteger(opts.top) || opts.top < 1 || opts.top > 50) throw new Error('--top must be 1-50');
  return opts;
}

function readHistory(spec) {
  if (!spec) return '';
  if (spec === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(spec, 'utf8');
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
  const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-rank.js');
  if (!fs.existsSync(buildPath)) {
    process.stderr.write('egc context: guardian build not found; run npm run build in mcp/servers/egc-guardian\n');
    return 2;
  }
  const { rankProjectFiles } = await import(pathToFileURL(buildPath).href);
  const result = await rankProjectFiles({
    projectPath: path.resolve(opts.project),
    query: opts.query,
    history: readHistory(opts.history),
    topN: opts.top,
    useGit: opts.git
  });
  process.stdout.write(result.briefing + '\n');
  if (opts.explain) process.stderr.write(result.explain.join('\n') + '\n');
  return 0;
}

main().then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(`egc context: ${err.message}\n`);
    process.exitCode = 1;
  }
);
