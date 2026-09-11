#!/usr/bin/env node
'use strict';

// egc export [--project <path>] [--scope project|global] [--json]
//
// Prints the memory document for one scope, decrypted, as plain text (the
// AMI Markdown document) or as JSON. Reference implementation of section 8.1
// of docs/spec/agent-memory-interchange.md: the output never carries storage
// artifacts (encryption header, integrity sidecar). Read-only by contract:
// it never writes the state files, the key, or the sidecars.
//
// Exit codes: 0 printed, 1 bad usage or unreadable file, 2 no memory for the
// scope, 3 encrypted memory whose key is missing or unreadable.

const fs = require('node:fs');
const path = require('node:path');

const branchState = require('./lib/branch-state');
const stateCrypto = require('./lib/state-crypto');
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

Exit codes: 0 printed, 1 usage or read error, 2 no memory for the scope,
3 encrypted memory whose key is missing.`;

// One entry per accepted flag: how to recognise it and what it sets.
// `next` consumes the following argument as the flag's value.
const OPTIONS = [
  { matches: arg => arg === '--help' || arg === '-h', apply: opts => { opts.help = true; } },
  { matches: arg => arg === '--json', apply: opts => { opts.json = true; } },
  { matches: arg => arg === '--project' || arg === '-p', apply: (opts, next) => { opts.project = next('--project needs a path'); } },
  { matches: arg => arg.startsWith('--project='), apply: (opts, next, arg) => { opts.project = arg.slice('--project='.length); } },
  { matches: arg => arg === '--scope', apply: (opts, next) => { opts.scope = next('--scope needs project or global'); } },
  { matches: arg => arg.startsWith('--scope='), apply: (opts, next, arg) => { opts.scope = arg.slice('--scope='.length); } },
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

function resolveDocument(opts) {
  if (opts.scope === 'global') {
    const file = globalState.globalStateFilePath();
    return { file, exists: fs.existsSync(file), label: 'global memory' };
  }
  const projectPath = path.resolve(opts.project || process.cwd());
  const stateDir = branchState.getStateDir();
  const branch = branchState.detectBranch(projectPath);
  const resolved = branchState.resolveStateRead(stateDir, projectPath, branch);
  return {
    file: resolved.filePath,
    exists: resolved.source !== 'none',
    label: `memory for ${projectPath}`,
  };
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
  if (!target.exists) {
    console.error(`egc export: no ${target.label}`);
    process.exit(2);
  }

  let content;
  try {
    content = stateCrypto.readStateFileDecrypted(target.file);
  } catch (err) {
    console.error(`egc export: cannot read ${target.file}: ${err.message}`);
    process.exit(1);
  }
  if (content === null) {
    console.error(`egc export: ${target.file} is encrypted and the key is missing or unreadable`);
    process.exit(3);
  }

  // fs.writeSync keeps the whole document in the pipe before exit; see the
  // same note in crush-run.js about asynchronous stdout on POSIX.
  if (opts.json) {
    fs.writeSync(1, JSON.stringify(toJson(content, opts.scope), null, 2) + '\n');
  } else {
    fs.writeSync(1, content.endsWith('\n') ? content : `${content}\n`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseArgs, parseHeader, toJson };
