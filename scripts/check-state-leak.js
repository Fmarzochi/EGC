#!/usr/bin/env node
'use strict';

// Guards the commit-privacy rule for EGC memory propagation files
// (AGENTS.md, GEMINI.md, .cursor/rules/egc-context.mdc, .trae/rules/egc-context.md):
// the managed "## EGC Project Memory" structure may be committed, populated
// memory content may not.
//
// Modes:
//   --staged        check staged blobs (pre-commit hook)
//   --tree          check tracked markdown files on disk (CI guard)
//   --clean <file>  rewrite files in place with the memory section zeroed

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const SECTION_HEADING = '## EGC Project Memory';
const POPULATED_SIGNATURES = [
  /^<!-- egc:state-updated:\S+ -->$/m,
  /^\*\*Context:\*\*/m,
  /^\*\*Active decisions:\*\*/m,
  /^\*\*Next session:\*\*/m,
];

// S4036: prefer fixed git locations over a PATH lookup; the bare name is the
// last resort for layouts like nix or Windows portable installs.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
].find(p => fs.existsSync(p)) || 'git';

function git(args, options) {
  return execFileSync(GIT_BIN, args, { encoding: 'utf8', ...options });
}

// Every propagation target of egc-memory (propagate.ts) is scanned, not just
// markdown: several targets (.rules, .clinerules, .cursorrules, llms.txt)
// have no .md extension and would otherwise slip past the guard.
const NON_MARKDOWN_TARGETS = [
  '.rules',
  '.clinerules',
  '.cursorrules',
  'CONVENTIONS.md',
  'llms.txt',
];

function isGuardedPath(p) {
  if (p.endsWith('.md') || p.endsWith('.mdc') || p.endsWith('.markdown')) return true;
  const base = p.split('/').pop();
  return NON_MARKDOWN_TARGETS.includes(base);
}

function findLeak(content) {
  if (!content.includes(SECTION_HEADING)) return null;
  const matched = POPULATED_SIGNATURES.filter(re => re.test(content));
  return matched.length > 0 ? matched.map(re => re.source) : null;
}

function cleanContent(content) {
  const lines = content.split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    if (/^<!-- egc:state-updated:\S+ -->$/.test(line)) continue;
    if (/^\*\*(Context|Active decisions|Next session):\*\*/.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      if (line.startsWith('- ') || line.trim() === '' ) {
        if (line.trim() === '') dropping = false;
        continue;
      }
      dropping = false;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function checkStaged() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n').filter(Boolean).filter(isGuardedPath);
  const leaks = [];
  for (const file of staged) {
    let content;
    try {
      content = git(['show', `:0:${file}`]);
    } catch {
      continue;
    }
    if (findLeak(content)) leaks.push(file);
  }
  return leaks;
}

function checkTree() {
  const tracked = git(['ls-files']).split('\n').filter(Boolean).filter(isGuardedPath);
  const leaks = [];
  for (const file of tracked) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (findLeak(content)) leaks.push(file);
  }
  return leaks;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode === '--clean') {
    const files = args.slice(1);
    if (files.length === 0) {
      console.error('usage: check-state-leak.js --clean <file...>');
      process.exit(2);
    }
    for (const file of files) {
      fs.writeFileSync(file, cleanContent(fs.readFileSync(file, 'utf8')));
      console.log(`cleaned: ${file}`);
    }
    return;
  }

  // Git clean-filter mode: stdin in, zeroed content out. Wired by
  // memory-filters.js as filter.egc-memory.clean so populated memory is
  // stripped from the staged blob even when local hooks are bypassed.
  if (mode === '--filter-clean') {
    const stdin = fs.readFileSync(0, 'utf8');
    process.stdout.write(cleanContent(stdin));
    return;
  }

  const leaks = mode === '--staged' ? checkStaged() : checkTree();
  if (leaks.length === 0) {
    console.log('state-leak check: clean');
    return;
  }

  console.error('BLOCKED: populated EGC memory must never be committed. Leaking files:');
  for (const file of leaks) console.error(`  - ${file}`);
  console.error('\nZero the memory section before committing:');
  console.error(`  node scripts/check-state-leak.js --clean ${leaks.join(' ')}`);
  console.error('Local sessions repopulate these files automatically; only the empty structure ships.');
  process.exit(1);
}

main();
