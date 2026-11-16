#!/usr/bin/env node
'use strict';

// The OpenCode prompt of every agent is the body of its definition under
// agents/, the frontmatter removed: agents/<name>.md becomes
// .opencode/prompts/agents/<name>.txt, the file opencode.json points at with
// {file:prompts/agents/<name>.txt}. The agent block of opencode.json is
// derived from the same definitions: one subagent per agent, its description,
// model and tools read from the frontmatter, the primary agents the file
// already has kept as they are. This script writes both and
// tests/ci/opencode-agent-prompts.test.js fails when a prompt or a registry
// entry is missing, drifted or without an agent (#2141).
//
// Usage: node scripts/opencode-agent-prompts.js [--check] [--root <dir>]
//   writes the prompts and the registry; --check only reports what differs
//   and exits 1 if anything does.

const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = 'agents';
const PROMPTS_DIR = path.join('.opencode', 'prompts', 'agents');
const CONFIG_FILE = path.join('.opencode', 'opencode.json');
// A BOM before the first dashes and a frontmatter that ends at the end of the
// file are both frontmatter: without this the YAML would become the prompt.
// The BOM is spelt by its code: an escape for it does not survive every editor.
const BOM = String.fromCharCode(0xFEFF);
const FRONTMATTER = new RegExp(`^${BOM}?---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)`);

function agentPromptBody(markdown) {
  const body = markdown.replace(FRONTMATTER, '');
  return `${body.replace(/\r\n/g, '\n').trim()}\n`;
}

function agentNames(root) {
  return fs.readdirSync(path.join(root, AGENTS_DIR))
    .filter(name => name.endsWith('.md'))
    .map(name => name.slice(0, -'.md'.length))
    .sort();
}

function promptPath(root, name) {
  return path.join(root, PROMPTS_DIR, `${name}.txt`);
}

/** The prompt every agent should have, keyed by agent name. */
function expectedPrompts(root) {
  const prompts = {};
  for (const name of agentNames(root)) {
    prompts[name] = agentPromptBody(fs.readFileSync(path.join(root, AGENTS_DIR, `${name}.md`), 'utf8'));
  }
  return prompts;
}

// A checkout that converts line endings (git autocrlf on Windows) hands the
// prompt back with CRLF; the comparison is on the text, not on the endings.
function readPrompt(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** What differs between the prompts on disk and the agent definitions. */
function driftReport(root) {
  const expected = expectedPrompts(root);
  const missing = [];
  const drifted = [];
  for (const [name, prompt] of Object.entries(expected)) {
    const file = promptPath(root, name);
    if (!fs.existsSync(file)) missing.push(name);
    else if (readPrompt(file) !== prompt) drifted.push(name);
  }
  const promptsDir = path.join(root, PROMPTS_DIR);
  const orphans = fs.existsSync(promptsDir)
    ? fs.readdirSync(promptsDir)
      .filter(name => name.endsWith('.txt') && !Object.hasOwn(expected, name.slice(0, -'.txt'.length)))
      .map(name => name.slice(0, -'.txt'.length))
      .sort()
    : [];
  return { missing, drifted, orphans, total: Object.keys(expected).length };
}

function writePrompts(root) {
  const expected = expectedPrompts(root);
  fs.mkdirSync(path.join(root, PROMPTS_DIR), { recursive: true });
  let written = 0;
  for (const [name, prompt] of Object.entries(expected)) {
    const file = promptPath(root, name);
    if (fs.existsSync(file) && readPrompt(file) === prompt) continue;
    fs.writeFileSync(file, prompt);
    written++;
  }
  return { written, total: Object.keys(expected).length };
}

/** The frontmatter fields of an agent definition, one `key: value` per line. */
function agentFrontmatter(markdown) {
  const match = markdown.match(FRONTMATTER);
  const fields = {};
  if (!match) return fields;
  for (const line of match[0].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1 || line.startsWith('---')) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

// The tools field is an inline list, quoted or not: ["Read", "Bash"] or
// [Read, Bash]. Only the names matter here.
function toolNames(value) {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(name => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// OpenCode knows the model aliases of this configuration: flash for the fast
// tier, pro for the rest, the way the hand-written entries used them.
function registryModel(model) {
  return /flash/i.test(model || '') ? 'flash' : 'pro';
}

// Read, Grep and Glob are all reads in OpenCode; the four toggles are spelt
// out so a definition without Write or Edit cannot write through a default.
function registryTools(value) {
  const names = new Set(toolNames(value));
  return {
    read: ['Read', 'Grep', 'Glob'].some(name => names.has(name)),
    bash: names.has('Bash'),
    write: names.has('Write'),
    edit: names.has('Edit'),
  };
}

/** The opencode.json agent entry a definition asks for. */
function registryEntry(name, markdown) {
  const fields = agentFrontmatter(markdown);
  const entry = {
    description: fields.description || '',
    mode: 'subagent',
    model: registryModel(fields.model),
    prompt: `{file:prompts/agents/${name}.txt}`,
  };
  if (fields.tools) entry.tools = registryTools(fields.tools);
  return entry;
}

function configPath(root) {
  return path.join(root, CONFIG_FILE);
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
}

/**
 * The agent block opencode.json should carry: the primary agents it already
 * has, in their place, then one subagent per definition under agents/.
 */
function expectedRegistry(root, config) {
  const agents = {};
  for (const [name, entry] of Object.entries(config.agent || {})) {
    if (entry && entry.mode === 'primary') agents[name] = entry;
  }
  for (const name of agentNames(root)) {
    agents[name] = registryEntry(name, fs.readFileSync(path.join(root, AGENTS_DIR, `${name}.md`), 'utf8'));
  }
  return agents;
}

function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** What differs between the agent block of opencode.json and the definitions. */
function registryDrift(root) {
  const config = readConfig(root);
  const expected = expectedRegistry(root, config);
  const current = config.agent || {};
  const missing = Object.keys(expected).filter(name => !Object.hasOwn(current, name));
  const drifted = Object.keys(expected).filter(name => Object.hasOwn(current, name) && !sameEntry(current[name], expected[name]));
  const orphans = Object.keys(current).filter(name => !Object.hasOwn(expected, name)).sort();
  return { missing, drifted, orphans, total: Object.keys(expected).length };
}

function writeRegistry(root) {
  const config = readConfig(root);
  const expected = expectedRegistry(root, config);
  const total = Object.keys(expected).length;
  if (sameEntry(config.agent, expected)) return { written: false, total };
  fs.writeFileSync(configPath(root), `${JSON.stringify({ ...config, agent: expected }, null, 2)}\n`);
  return { written: true, total };
}

function parseArgs(argv) {
  const options = { check: false, root: path.join(__dirname, '..') };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--root' && argv[index + 1]) options.root = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function reportProblems(label, report) {
  if (report.missing.length) console.log(`${label} missing: ${report.missing.join(', ')}`);
  if (report.drifted.length) console.log(`${label} drifted: ${report.drifted.join(', ')}`);
  if (report.orphans.length) console.log(`${label} without an agent: ${report.orphans.join(', ')}`);
  return report.missing.length + report.drifted.length + report.orphans.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const prompts = driftReport(options.root);
    const registry = registryDrift(options.root);
    const problems = reportProblems('prompt', prompts) + reportProblems('registry entry', registry);
    console.log(problems === 0
      ? `${prompts.total} prompts and ${registry.total} registry entries in step with agents/`
      : `${problems} problem(s); run node scripts/opencode-agent-prompts.js`);
    process.exit(problems === 0 ? 0 : 1);
  }
  const prompts = writePrompts(options.root);
  const registry = writeRegistry(options.root);
  console.log(`${prompts.written} prompt(s) written, ${prompts.total} in step with agents/; registry ${registry.written ? 'rewritten' : 'unchanged'}, ${registry.total} entries`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`opencode-agent-prompts: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  agentPromptBody,
  expectedPrompts,
  driftReport,
  writePrompts,
  agentFrontmatter,
  registryEntry,
  expectedRegistry,
  registryDrift,
  writeRegistry,
  PROMPTS_DIR,
  CONFIG_FILE,
};
