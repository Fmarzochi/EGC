#!/usr/bin/env node
'use strict';

// egc export [--project <path>] [--scope project|global] [--json]
//
// Prints the memory document for one scope, decrypted, as plain text (the
// AMI Markdown document) or as JSON. Reference implementation of section 8.1
// of docs/spec/agent-memory-interchange.md: the output never carries storage
// artifacts (encryption header, integrity sidecar). Read-only by contract:
// it never writes the state files, the key, or the sidecars, and it never
// changes the mode of the key. The state file is read through a checked
// descriptor (never through a link, a regular file whose parent resolves
// inside the state directory), the same way the doctor reads it.
//
// Exit codes: 0 printed, 1 bad usage, a state file or key that cannot be
// read or trusted, 2 no memory for the scope, 3 encrypted memory whose key
// is missing.

const fs = require('node:fs');
const path = require('node:path');

const branchState = require('./lib/branch-state');
const stateCrypto = require('./lib/state-crypto');
const statePlaintext = require('./lib/state-plaintext');
const globalState = require('./lib/global-state');

const SECTION_KEYS = {
  'Context': 'context',
  'Active Decisions': 'active_decisions',
  'Do Not Repeat': 'do_not_repeat',
  'Preferences': 'preferences',
  'Next Session': 'next_session',
};

const USAGE = `Usage: egc export [--project <path>] [--scope project|global] [--json]

Prints the decrypted memory document for a project (default: current
directory) or for the user-wide global scope. Plain text is the AMI Markdown
document as stored; --json parses it into header fields and the five sections.

Exit codes: 0 printed, 1 usage error or a state file or key that cannot be
read or trusted, 2 no memory for the scope, 3 encrypted memory whose key is
missing.`;

// One entry per accepted flag: how to recognise it and what it sets.
// `next` consumes the following argument as the flag's value.
const OPTIONS = [
  { matches: arg => arg === '--help' || arg === '-h', apply: opts => { opts.help = true; } },
  { matches: arg => arg === '--json', apply: opts => { opts.json = true; } },
  { matches: arg => arg === '--project' || arg === '-p', apply: (opts, next) => { opts.project = next('--project needs a path'); } },
  { matches: arg => arg.startsWith('--project='), apply: (opts, _next, arg) => { opts.project = arg.slice('--project='.length); } },
  { matches: arg => arg === '--scope', apply: (opts, next) => { opts.scope = next('--scope needs project or global'); } },
  { matches: arg => arg.startsWith('--scope='), apply: (opts, _next, arg) => { opts.scope = arg.slice('--scope='.length); } },
];

function parseArgs(argv) {
  const opts = { project: null, scope: 'project', json: false, help: false };
  let index = 0;
  const next = message => {
    index += 1;
    if (!argv[index]) throw new Error(message);
    return argv[index];
  };
  while (index < argv.length) {
    const arg = argv[index];
    const option = OPTIONS.find(candidate => candidate.matches(arg));
    if (!option) throw new Error(`unknown argument: ${arg}`);
    option.apply(opts, next, arg);
    index += 1;
  }
  if (opts.scope !== 'project' && opts.scope !== 'global') {
    throw new Error(`unknown scope: ${opts.scope} (use project or global)`);
  }
  return opts;
}

// Header block: the key: value lines between the H1 title and the first
// blank line or H2. Unknown keys are kept, as the spec asks consumers to do.
function parseHeader(content) {
  const header = {};
  const lines = content.split('\n');
  let index = lines[0]?.startsWith('# ') ? 1 : 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      if (Object.keys(header).length > 0) break;
      continue;
    }
    if (line.startsWith('#')) break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) break;
    header[match[1]] = match[2].trim();
  }
  return header;
}

function toJson(content, scope) {
  const header = parseHeader(content);
  const sections = globalState.parseStateDoc(content);
  const out = {
    format: 'ami',
    spec: '0.1',
    scope,
    project: header.project ?? null,
    branch: header.branch ?? null,
    author: header.author ?? null,
    updated: header.updated ?? null,
    context: '',
    active_decisions: [],
    do_not_repeat: [],
    preferences: [],
    next_session: [],
    other_sections: {},
  };
  for (const [heading, entries] of Object.entries(sections)) {
    const list = (Array.isArray(entries) ? entries : [String(entries)]).filter(Boolean);
    const key = SECTION_KEYS[heading];
    if (key === 'context') {
      out.context = list.join(' ').trim();
    } else if (key) {
      out[key] = list;
    } else {
      out.other_sections[heading] = list;
    }
  }
  return out;
}

function fail(code, message) {
  console.error(`egc export: ${message}`);
  process.exit(code);
}

// Whether anything sits at the path (a link, even a dangling one, counts).
// Only a definite ENOENT is an absence; a path that cannot be inspected is
// an error, never a silent "no memory".
function present(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    return fail(1, `cannot inspect ${filePath}: ${err.message}`);
  }
}

function resolveDocument(opts) {
  if (opts.scope === 'global') {
    const file = globalState.globalStateFilePath();
    return { file, root: statePlaintext.stateRoot(path.dirname(file)), exists: present(file), label: 'global memory' };
  }
  const projectPath = path.resolve(opts.project || process.cwd());
  const stateDir = branchState.getStateDir();
  const branch = branchState.detectBranch(projectPath);
  const resolved = branchState.resolveStateRead(stateDir, projectPath, branch);
  return {
    file: resolved.filePath,
    root: statePlaintext.stateRoot(stateDir),
    exists: resolved.source !== 'none',
    label: `memory for ${projectPath}`,
  };
}

// The bytes of the state file through the checked descriptor: a link, a
// non-regular file, a path outside the state directory or a file that
// changed under the read is refused, never followed or printed.
function readStateBytes(target) {
  let raw;
  try {
    raw = target.root ? statePlaintext.readStateFileBytes(target.file, target.root) : null;
  } catch (err) {
    // A link at the path is refused by the no-follow open (ELOOP), the
    // same refusal as a link seen before the open.
    if (err.code === 'ELOOP') raw = null;
    else fail(1, `cannot read ${target.file}: ${err.message}`);
  }
  if (raw === null) fail(1, `${target.file} is not a regular file inside the state directory, or changed while it was read`);
  return raw;
}

// The key for an encrypted document, loaded without touching its mode. A
// key that is missing is exit 3; one that is present but cannot be read,
// is not private, or is malformed is exit 1 with the reason.
function loadKeyReadOnly() {
  let key;
  try {
    key = stateCrypto.loadKey(undefined, { readOnly: true });
  } catch (err) {
    fail(1, err.message);
  }
  if (key) return key;
  if (!present(stateCrypto.defaultKeyPath())) fail(3, 'the memory is encrypted and the key is missing');
  return fail(1, `the key at ${stateCrypto.defaultKeyPath()} is malformed`);
}

function decryptedContent(target) {
  const raw = readStateBytes(target);
  if (!stateCrypto.isEncryptedBuffer(raw)) return raw;
  const keyMaterial = loadKeyReadOnly();
  const content = stateCrypto.decryptStateBuffer(raw, undefined, { keyMaterial });
  if (content === null) fail(1, `${target.file} cannot be decrypted with the key (truncated or tampered)`);
  return content;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`egc export: ${err.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const target = resolveDocument(opts);
  if (!target.exists) fail(2, `no ${target.label}`);

  const content = decryptedContent(target);

  // fs.writeSync keeps the whole document in the pipe before exit; see the
  // same note in crush-run.js about asynchronous stdout on POSIX. The plain
  // text goes out exactly as stored, not a byte added.
  if (opts.json) {
    fs.writeSync(1, JSON.stringify(toJson(content.toString('utf-8'), opts.scope), null, 2) + '\n');
  } else {
    fs.writeSync(1, content);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseArgs, parseHeader, toJson };
