#!/usr/bin/env node
'use strict';

// The OpenCode prompt of every agent is the body of its definition under
// agents/, the frontmatter removed: agents/<name>.md becomes
// .opencode/prompts/agents/<name>.txt, the file opencode.json points at with
// {file:prompts/agents/<name>.txt}. This script writes the whole set and
// tests/ci/opencode-agent-prompts.test.js fails when one is missing or
// drifted from its source (#2141).
//
// Usage: node scripts/opencode-agent-prompts.js [--check] [--root <dir>]
//   writes the prompts; --check only reports what differs and exits 1 if
//   anything does.

const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = 'agents';
const PROMPTS_DIR = path.join('.opencode', 'prompts', 'agents');
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

/** What differs between the prompts on disk and the agent definitions. */
function driftReport(root) {
  const expected = expectedPrompts(root);
  const missing = [];
  const drifted = [];
  for (const [name, prompt] of Object.entries(expected)) {
    const file = promptPath(root, name);
    if (!fs.existsSync(file)) missing.push(name);
    else if (fs.readFileSync(file, 'utf8') !== prompt) drifted.push(name);
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
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === prompt) continue;
    fs.writeFileSync(file, prompt);
    written++;
  }
  return { written, total: Object.keys(expected).length };
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const report = driftReport(options.root);
    const problems = report.missing.length + report.drifted.length + report.orphans.length;
    if (report.missing.length) console.log(`missing: ${report.missing.join(', ')}`);
    if (report.drifted.length) console.log(`drifted: ${report.drifted.join(', ')}`);
    if (report.orphans.length) console.log(`no agent: ${report.orphans.join(', ')}`);
    console.log(problems === 0 ? `${report.total} prompts in step with agents/` : `${problems} problem(s); run node scripts/opencode-agent-prompts.js`);
    process.exit(problems === 0 ? 0 : 1);
  }
  const result = writePrompts(options.root);
  console.log(`${result.written} prompt(s) written, ${result.total} in step with agents/`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`opencode-agent-prompts: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { agentPromptBody, expectedPrompts, driftReport, writePrompts, PROMPTS_DIR };
