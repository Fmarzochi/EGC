#!/usr/bin/env node
'use strict';

// egc import: the way back from egc export (#2138). Reads an AMI document
// (docs/spec/agent-memory-interchange.md), refuses one that does not parse or
// that carries the shape of a credential, merges it into the memory of a
// project or of the global scope (or replaces that memory with --replace) and
// writes it the way the hooks do: encrypted, through a temp file and a
// rename, with the integrity sidecar, under the per-file lock. --dry-run
// prints the change and writes nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const branchState = require('./lib/branch-state');
const globalState = require('./lib/global-state');
const stateCrypto = require('./lib/state-crypto');
const { parseHeader } = require('./export');
const { saveState, withStateFileLockSync } = require('./lib/state-snapshot');
const { findSecretShapes } = require('./lib/secret-shapes');
const { mergeDocuments } = require('./lib/ami-merge');

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const SECTIONS = ['Context', 'Active Decisions', 'Do Not Repeat', 'Preferences', 'Next Session'];

const USAGE = `Usage: egc import <file> [--project <path>] [--scope project|global] [--replace] [--dry-run] [--json]
Reads an exported memory document (the AMI format egc export prints) and
brings it into the memory of a project (default: the current directory) or
of the user-wide global scope. By default the document is merged the way the
spec says (section 5): its entries go first, one copy of each text, capped per
section; the Context is taken from the document when it has one; Next Session
is rewritten when the document carries the section. --replace writes the
document in place of the memory. --dry-run prints what would change and
writes nothing.
Exit codes: 0 written (or dry run), 1 usage error, a document that does not
parse, carries the shape of a credential or cannot be written, 2 a document
with nothing to import.`;

const OPTIONS = [
  { matches: arg => arg === '--help' || arg === '-h', apply: opts => { opts.help = true; } },
  { matches: arg => arg === '--json', apply: opts => { opts.json = true; } },
  { matches: arg => arg === '--replace', apply: opts => { opts.replace = true; } },
  { matches: arg => arg === '--merge', apply: opts => { opts.replace = false; } },
  { matches: arg => arg === '--dry-run', apply: opts => { opts.dryRun = true; } },
  { matches: arg => arg === '--project' || arg === '-p', apply: (opts, next) => { opts.project = next('--project needs a path'); } },
  { matches: arg => arg.startsWith('--project='), apply: (opts, _next, arg) => { opts.project = arg.slice('--project='.length); } },
  { matches: arg => arg === '--scope', apply: (opts, next) => { opts.scope = next('--scope needs project or global'); } },
  { matches: arg => arg.startsWith('--scope='), apply: (opts, _next, arg) => { opts.scope = arg.slice('--scope='.length); } },
];

function parseArgs(argv) {
  const opts = { file: null, project: null, scope: 'project', replace: false, dryRun: false, json: false, help: false };
  let index = 0;
  const next = message => {
    index += 1;
    // An option in the value's place is a missing value, not a path or a scope:
    // --project --dry-run must not run a real import into a folder named --dry-run.
    if (!argv[index] || argv[index].startsWith('-')) throw new Error(message);
    return argv[index];
  };
  while (index < argv.length) {
    const arg = argv[index];
    const option = OPTIONS.find(candidate => candidate.matches(arg));
    if (option) option.apply(opts, next, arg);
    else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else if (opts.file === null) opts.file = arg;
    else throw new Error(`one file at a time: ${arg}`);
    index += 1;
  }
  if (opts.scope !== 'project' && opts.scope !== 'global') {
    throw new Error(`unknown scope: ${opts.scope} (use project or global)`);
  }
  if (!opts.help && !opts.file) throw new Error('the exported document to import is missing');
  return opts;
}

function fail(code, message) {
  console.error(`egc import: ${message}`);
  process.exit(code);
}

function listOf(value) {
  return (Array.isArray(value) ? value : [String(value)]).map(entry => entry.trim()).filter(Boolean);
}

function readDocument(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return fail(1, `cannot read ${file} (${err.code || err.name})`);
  }
  if (!stat.isFile()) fail(1, `${file} is not a regular file`);
  if (stat.size > MAX_DOCUMENT_BYTES) fail(1, `${file} is larger than 1 MB; a memory document is not that big`);
  const raw = fs.readFileSync(file);
  if (stateCrypto.isEncryptedBuffer(raw)) fail(1, `${file} is an encrypted state file, not an exported document; run egc export on the machine that owns it`);
  const text = raw.toString('utf8');
  if (text.includes('\u0000')) fail(1, `${file} is not a text file`);
  return text;
}

function parseDocument(text) {
  const sections = {};
  for (const [heading, entries] of Object.entries(globalState.parseStateDoc(text))) sections[heading] = listOf(entries);
  if (!SECTIONS.some(heading => Object.hasOwn(sections, heading))) {
    fail(1, 'the file has none of the AMI sections (Context, Active Decisions, Do Not Repeat, Preferences, Next Session); see docs/spec/agent-memory-interchange.md');
  }
  return { header: parseHeader(text), sections };
}

// The match names the shape, never the value, so the refusal can be pasted
// anywhere without carrying the secret along. Every value that can be
// rendered is scanned: the entries and the header fields (the author lands in
// the state file too).
function refuseSecrets(imported) {
  for (const [field, value] of Object.entries(imported.header)) {
    const shapes = findSecretShapes(String(value));
    if (shapes.length > 0) {
      fail(1, `the header field "${field}" carries ${shapes[0]}; a memory document must not carry credentials. Remove it and import again; nothing was written`);
    }
  }
  for (const [heading, entries] of Object.entries(imported.sections)) {
    for (const entry of entries) {
      const shapes = findSecretShapes(entry);
      if (shapes.length > 0) {
        fail(1, `the section "${heading}" has an entry with ${shapes[0]}; a memory document must not carry credentials. Remove it and import again; nothing was written`);
      }
    }
  }
}

function resolveTarget(opts) {
  if (opts.scope === 'global') {
    const file = globalState.globalStateFilePath();
    return { file, readFile: fs.existsSync(file) ? file : null, project: 'global', branch: null, label: 'the global memory' };
  }
  const projectPath = path.resolve(opts.project || process.cwd());
  const stateDir = branchState.getStateDir();
  const { branch, detachedCommit } = branchState.resolveHeadState(projectPath);
  const resolved = branchState.resolveStateRead(stateDir, projectPath, branch, detachedCommit);
  return {
    file: branchState.resolveStateWrite(stateDir, projectPath, branch, detachedCommit),
    readFile: resolved.source === 'none' ? null : resolved.filePath,
    project: projectPath,
    branch,
    label: `the memory for ${projectPath}`,
  };
}

// Thrown instead of exiting: the read happens under the state file lock, and
// an exit there would leave the lock behind.
class UnreadableMemory extends Error {}

function currentDocument(target) {
  if (!target.readFile || !fs.existsSync(target.readFile)) return null;
  const content = stateCrypto.readStateFileDecrypted(target.readFile, stateCrypto.defaultKeyPath());
  if (content === null) throw new UnreadableMemory(`${target.label} cannot be decrypted with the key of this machine; nothing was written`);
  return parseDocument(content);
}

// Section 5 of the spec, without retired marks: the document's entries first,
// one copy of each text, capped; the Context from the document when it has
// one; Next Session from the document when it carries the section.
function mergeSections(current, imported) {
  return mergeDocuments({
    current: { header: {}, sections: current },
    imported: { header: {}, sections: imported },
    mode: 'merge',
    now: new Date().toISOString(),
  }).sections;
}

// What the import writes: the mode, the document rendered for the target and
// the change per section. Read and merged in one go, so a caller that holds
// the state file lock covers the read as well as the write.
function planImport(opts, target, imported) {
  const current = currentDocument(target);
  const mode = opts.replace || !current ? 'replace' : 'merge';
  const now = new Date().toISOString();
  const { sections, retired } = mergeDocuments({ current, imported, mode, now });
  const header = {
    author: (current && current.header.author) || imported.header.author || os.userInfo().username,
    retired,
  };
  return { mode, now, content: renderDocument(target, header, sections, now), summary: changeSummary(current ? current.sections : null, sections) };
}

function renderDocument(target, header, sections, now) {
  const lines = ['# Project State', `project: ${target.project}`];
  if (target.branch) lines.push(`branch: ${target.branch}`);
  if (header.author) lines.push(`author: ${header.author}`);
  lines.push(`updated: ${now}`);
  if (header.retired) lines.push(`retired: ${header.retired}`);
  lines.push('');
  const headings = [...SECTIONS, ...Object.keys(sections).filter(h => !SECTIONS.includes(h))];
  for (const heading of headings) {
    lines.push(`## ${heading}`);
    const entries = sections[heading] || [];
    if (heading === 'Context') {
      if (entries.length > 0) lines.push(entries.join(' '));
    } else {
      for (const entry of entries) lines.push(`- ${entry}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function changeSummary(before, after) {
  const summary = {};
  for (const heading of new Set([...SECTIONS, ...Object.keys(after)])) {
    summary[heading] = { before: (before && before[heading] ? before[heading] : []).length, after: (after[heading] || []).length };
  }
  return summary;
}

function summaryVerb(opts, mode) {
  if (opts.dryRun) return `would ${mode}`;
  return mode === 'replace' ? 'replaced' : 'merged into';
}

function printSummary(opts, target, mode, summary) {
  console.log(`egc import: ${summaryVerb(opts, mode)} ${target.label}`);
  console.log(`  file: ${target.file}`);
  for (const [heading, counts] of Object.entries(summary)) {
    console.log(`  ${heading}: ${counts.before} -> ${counts.after}`);
  }
  if (opts.dryRun) console.log('  nothing was written (--dry-run)');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`egc import: ${err.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const imported = parseDocument(readDocument(opts.file));
  refuseSecrets(imported);
  if (Object.values(imported.sections).every(entries => entries.length === 0)) fail(2, `${opts.file} has nothing to import: every section is empty`);

  const target = resolveTarget(opts);
  let plan;
  try {
    // The read, the merge and the write happen under the lock the hooks and
    // the server take, so an update_state in between is never overwritten by
    // a merge of what the memory held before it. A dry run reads without the
    // lock: it writes nothing, and taking the lock would create the state
    // directory of a memory that may not exist yet.
    plan = opts.dryRun
      ? planImport(opts, target, imported)
      : withStateFileLockSync(target.file, () => {
        const planned = planImport(opts, target, imported);
        saveState(target.file, planned.content);
        return planned;
      });
  } catch (err) {
    fail(1, err instanceof UnreadableMemory ? err.message : `${target.label} could not be written: ${err.message}`);
  }
  const { mode, now, summary } = plan;

  if (opts.json) {
    console.log(JSON.stringify({ file: target.file, scope: opts.scope, mode, written: !opts.dryRun, updated: now, sections: summary }, null, 2));
  } else {
    printSummary(opts, target, mode, summary);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseArgs, mergeSections, renderDocument, SECTIONS };
