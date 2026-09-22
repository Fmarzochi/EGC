#!/usr/bin/env node
'use strict';

// Guards the commit-privacy rule for EGC memory propagation files
// (AGENTS.md, GEMINI.md, .cursor/rules/egc-context.mdc, .trae/rules/egc-context.md):
// the managed "## EGC Project Memory" structure may be committed, populated
// memory content may not.
//
// Modes:
//   --staged          check staged blobs (pre-commit hook)
//   --tree            check tracked markdown files on disk (CI guard)
//   --packaged-tree   check only tracked files the npm package ships (prepack guard)
//   --clean <file>    rewrite files in place with the memory section zeroed

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');


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
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(p => fs.existsSync(p)) || 'git';

function git(args, options) {
  // LC_ALL=C: git ships localized fatal messages via gettext, and the
  // packaged-tree guard matches 'not a git repository' textually to decide
  // between skipping and failing closed -- force the C locale so that
  // decision is deterministic on non-English systems.
  return execFileSync(GIT_BIN, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, ...options });
}

// Every propagation target of egc-memory (propagate.ts) is scanned, not just
// markdown: several targets (.rules, .clinerules, .cursorrules, llms.txt)
// have no .md extension and would otherwise slip past the guard.
const NON_MARKDOWN_TARGETS = new Set([
  '.rules',
  '.clinerules',
  '.cursorrules',
  '.roorules',
  'CONVENTIONS.md',
  'llms.txt',
]);

function isGuardedPath(p) {
  if (p.endsWith('.md') || p.endsWith('.mdc') || p.endsWith('.markdown')) return true;
  const base = p.split('/').pop();
  return NON_MARKDOWN_TARGETS.has(base);
}

const START_MARKER = '<!-- egc:start -->';
const END_MARKER = '<!-- egc:end -->';
const MEMORY_HEADING_RE = /^#{1,2} EGC Project Memory$/m;

function findLeak(content) {
  if (!MEMORY_HEADING_RE.test(content)) return null;
  const matched = POPULATED_SIGNATURES.filter(re => re.test(content));
  return matched.length > 0 ? matched.map(re => re.source) : null;
}

// Zeroes the memory in a propagation file and keeps its structure. The
// context files carry the block with bold labels (`**Context:**`, `**Active
// decisions:**`, `**Next session:**`) followed by the items; llms.txt
// carries it as plain text under `# EGC Project Memory`, a paragraph for the
// context and a `## Next session` list, so those two shapes are zeroed too,
// inside the markers only, since a heading of that name elsewhere in the
// file belongs to whoever wrote it. A file with CRLF line breaks is read
// the same way and keeps them. The markers themselves always stay.
const STATE_STAMP_RE = /^<!-- egc:state-updated:\S+ -->$/;
const LABEL_RE = /^\*\*(Context|Active decisions|Next session):\*\*/;

function opensList(bare, state) {
  return LABEL_RE.test(bare) || (state.inBlock && bare === '## Next session');
}

// A list opened by a label or by the llms.txt heading runs until a blank
// line; the blank line closes it and goes with it.
function dropsListLine(bare, blank, state) {
  if (!state.inList) return false;
  if (blank) {
    state.inList = false;
    return true;
  }
  if (bare.startsWith('- ')) return true;
  state.inList = false;
  return false;
}

// The llms.txt context sits under its heading as a paragraph up to the next
// blank line or the next heading; a heading in that place means there is no
// paragraph, and a heading right after it ends it and stays.
function dropsParagraphLine(bare, blank, state) {
  if (state.paragraph === 'waiting' && !blank) state.paragraph = bare.startsWith('#') ? 'off' : 'dropping';
  if (state.paragraph !== 'dropping') return false;
  if (blank || bare.startsWith('#')) {
    state.paragraph = 'off';
    return false;
  }
  return true;
}

function keepsLine(line, state) {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
  const blank = bare.trim() === '';
  if (bare === START_MARKER) {
    state.inBlock = true;
    return true;
  }
  if (bare === END_MARKER) {
    Object.assign(state, { inBlock: false, inList: false, paragraph: 'off' });
    return true;
  }
  if (STATE_STAMP_RE.test(bare)) return false;
  if (opensList(bare, state)) {
    Object.assign(state, { inList: true, paragraph: 'off' });
    return false;
  }
  if (dropsListLine(bare, blank, state) || dropsParagraphLine(bare, blank, state)) return false;
  if (state.inBlock && bare === '# EGC Project Memory') state.paragraph = 'waiting';
  return true;
}

function cleanContent(content) {
  const state = { inList: false, inBlock: false, paragraph: 'off' };
  const out = content.split('\n').filter(line => keepsLine(line, state));
  return out.join('\n').replace(/(\r?\n){3,}/g, '$1$1');
}

function checkStaged() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMT', '-z'])
    .split('\0').filter(Boolean).filter(isGuardedPath);
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

function scanDiskFiles(files) {
  const leaks = [];
  for (const file of files) {
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

function checkTree() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).filter(isGuardedPath);
  return scanDiskFiles(tracked);
}

// Local sessions legitimately keep propagation files like CLAUDE.md populated
// on disk, and the git clean filter only protects COMMITS -- npm pack reads
// the working tree directly. A populated propagation file inside the
// package.json "files" set (e.g. .trae/rules/egc-context.md) would therefore
// be published verbatim. This mode guards exactly that set, so prepack can
// abort a leaking publish without blocking everyday local work.
function stripTrailingSlashes(entry) {
  let end = entry.length;
  while (end > 0 && entry[end - 1] === '/') end -= 1;
  return entry.slice(0, end);
}

function loadPackagedPrefixes() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return (Array.isArray(pkg.files) ? pkg.files : [])
    .filter(entry => typeof entry === 'string' && !entry.startsWith('!'))
    .map(stripTrailingSlashes);
}

function isPackagedPath(filePath, prefixes) {
  return prefixes.some(prefix => filePath === prefix || filePath.startsWith(`${prefix}/`));
}

function checkPackagedTree() {
  const prefixes = loadPackagedPrefixes();
  let listing;
  try {
    // Tracked AND untracked-but-not-ignored files: npm pack reads the
    // working tree, so a populated propagation file that was never
    // committed still ships. Ignored files stay out; without an .npmignore
    // npm applies the same .gitignore rules when packing.
    listing = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  } catch (error) {
    // Only two failures mean there is genuinely no git state to scan:
    // packing a directory that is not a checkout (vendored copy, exported
    // tarball), or a machine without the git binary. Those skip with a
    // notice -- the real publish flow always runs from the repository.
    // Anything else (corrupt metadata, permissions, lock contention) is a
    // failure INSIDE a checkout: rethrow so prepack fails closed instead of
    // silently shipping a populated memory file.
    const detail = `${error.code || ''} ${error.message || ''} ${error.stderr || ''}`;
    const notARepo = /not a git repository/i.test(detail);
    const gitMissing = error.code === 'ENOENT';
    if (!notARepo && !gitMissing) {
      throw error;
    }
    console.error(`state-leak check: skipped (${notARepo ? 'not a git checkout' : 'git unavailable'}: ${String(error.message).split('\n')[0]})`);
    return [];
  }
  const packagedFiles = listing.split('\0').filter(Boolean)
    .filter(file => isPackagedPath(file, prefixes))
    .filter(isGuardedPath);
  return scanDiskFiles(packagedFiles);
}

// The propagation library sits under lib/ next to this script in the
// repository and beside it in the flattened install layouts; a layout
// without it, or a library that cannot load, means no smudge, never a
// failed checkout.
function loadPropagation() {
  try {
    return require('./lib/propagate-state');
  } catch {
    try {
      return require('./propagate-state');
    } catch {
      return null;
    }
  }
}

function smudgeContent(relativePath, content) {
  try {
    const propagation = loadPropagation();
    if (propagation === null || typeof propagation.smudgeContextContent !== 'function') return content;
    return propagation.smudgeContextContent(process.cwd(), relativePath, content);
  } catch {
    return content;
  }
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
      console.error(`cleaned: ${file}`);
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

  // Git smudge-filter mode: the zeroed blob git is checking out comes in on
  // stdin and goes out with the memory of the local state put back into its
  // markers, so a pull, a branch switch or a stash pop never leaves the
  // working tree without the block. The propagation library renders it;
  // when that library is not next to this script, or anything else stands
  // in the way, the content goes out exactly as it came, because a checkout
  // must never fail on this filter's account. stdout carries the content
  // and nothing else: a line a library would print for a terminal goes to
  // stderr, and a pipe git has already closed ends the run quietly, while
  // any other failure to write is loud, so git holds the checkout instead
  // of keeping a truncated file. Bytes that are not UTF-8 go out untouched,
  // since only text carries the block. A blob that cannot be read from git
  // is loud for the same reason.
  if (mode === '--filter-smudge') {
    console.log = (...lines) => console.error(...lines);
    console.info = console.log;
    process.stdout.on('error', err => process.exit(err.code === 'EPIPE' ? 0 : 1));
    const raw = fs.readFileSync(0);
    const text = raw.toString('utf8');
    const isText = Buffer.from(text, 'utf8').equals(raw);
    process.stdout.write(isText ? Buffer.from(smudgeContent(args[1] ?? '', text), 'utf8') : raw);
    return;
  }

  let leaks;
  if (mode === '--staged') {
    leaks = checkStaged();
  } else if (mode === '--packaged-tree') {
    leaks = checkPackagedTree();
  } else {
    leaks = checkTree();
  }
  if (leaks.length === 0) {
    // Status lines go to stderr: `npm pack --json` runs this script through
    // the prepack hook and parses stdout as JSON, so stdout stays reserved
    // for the --stdin filter output.
    console.error('state-leak check: clean');
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
