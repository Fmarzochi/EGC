#!/usr/bin/env node
'use strict';

// Guards against internal/personal tool names leaking into the public repo:
// tracked files, staged commits, and PR titles/bodies. The denylist covers
// codenames and setups that have leaked before (see EGC-539 follow-up) and
// have no legitimate reason to ever appear in this public codebase.
//
// Modes:
//   --staged        check staged blobs (pre-commit hook)
//   --tree          check tracked files on disk (CI guard)
//   --text <string> check an arbitrary string (CI guard for PR title/body)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const DENYLIST = ['multica'];

// The checker's own source and test fixtures legitimately contain the
// denylisted terms; never treat them as a leak.
const SELF_PATHS = new Set([
  'scripts/check-internal-tool-leak.js',
  'tests/check-internal-tool-leak.test.js',
]);

const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
].find(p => fs.existsSync(p)) || 'git';

function git(args, options) {
  return execFileSync(GIT_BIN, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, ...options });
}

function findHits(content) {
  const lower = content.toLowerCase();
  return DENYLIST.filter(term => lower.includes(term));
}

function checkStaged() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n').filter(Boolean).filter(f => !SELF_PATHS.has(f));
  const leaks = [];
  for (const file of staged) {
    let content;
    try {
      content = git(['show', `:0:${file}`]);
    } catch {
      continue;
    }
    const hits = findHits(content);
    if (hits.length > 0) leaks.push({ file, hits });
  }
  return leaks;
}

function checkTree() {
  const tracked = git(['ls-files']).split('\n').filter(Boolean).filter(f => !SELF_PATHS.has(f));
  const leaks = [];
  for (const file of tracked) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const hits = findHits(content);
    if (hits.length > 0) leaks.push({ file, hits });
  }
  return leaks;
}

function report(leaks, context) {
  if (leaks.length === 0) {
    console.log('internal-tool leak check: clean');
    return 0;
  }
  console.error(`BLOCKED: internal/personal tool references must never be public. Found in ${context}:`);
  for (const leak of leaks) {
    console.error(`  - ${leak.file}: ${leak.hits.join(', ')}`);
  }
  console.error('\nRemove the reference and reword generically before committing/merging.');
  return 1;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode === '--text') {
    const text = args.slice(1).join(' ');
    const hits = findHits(text);
    if (hits.length === 0) {
      console.log('internal-tool leak check: clean');
      return;
    }
    console.error(`BLOCKED: internal/personal tool reference found in PR title/body: ${hits.join(', ')}`);
    process.exit(1);
  }

  const leaks = mode === '--staged' ? checkStaged() : checkTree();
  process.exit(report(leaks, mode === '--staged' ? 'staged files' : 'tracked files'));
}

main();
