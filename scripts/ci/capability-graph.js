#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '../..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const COMMANDS_DIR = path.join(ROOT, 'commands');
const SKILLS_DIR = path.join(ROOT, 'skills');
const HOOKS_JSON = path.join(ROOT, 'hooks', 'hooks.json');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_PATH_RE = /\bskills\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)\b/gi;
const BACKTICK_TOKEN_RE = /`([a-z0-9][a-z0-9_-]+)`/gi;
const HOOK_SCRIPT_RE = /scripts\/hooks\/([a-z0-9][a-z0-9-]*\.js)/;
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStop',
  'Notification',
  'UserPromptSubmit'
];

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) { // NOSONAR: unreadable file yields null in this safe-read helper
    return null;
  }
}

function parseFrontmatter(content) {
  if (!content) return { data: {}, body: '' };
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: content };
  try {
    const data = yaml.load(match[1]) || {};
    const body = content.slice(match[0].length);
    return { data: typeof data === 'object' ? data : {}, body };
  } catch (_err) { // NOSONAR: invalid frontmatter falls back to raw body content
    return { data: {}, body: content };
  }
}

function normalizeTools(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function listAgentFiles() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name)
    .sort();
}

function listCommandFiles() {
  if (!fs.existsSync(COMMANDS_DIR)) return [];
  return fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name)
    .sort();
}

function processSkillChildren(ns, nsPath, entries) {
  let children;
  try {
    children = fs.readdirSync(nsPath, { withFileTypes: true });
  } catch (_err) { // NOSONAR: unreadable namespace dir is skipped
    return;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const childPath = path.join(nsPath, child.name);
    if (fs.existsSync(path.join(childPath, 'SKILL.md'))) {
      entries.push({ namespace: ns.name, id: child.name, dir: childPath });
    }
  }
}

function listSkillEntries() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const entries = [];
  const namespaces = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    const nsPath = path.join(SKILLS_DIR, ns.name);
    if (fs.existsSync(path.join(nsPath, 'SKILL.md'))) {
      entries.push({ namespace: null, id: ns.name, dir: nsPath });
      continue;
    }
    processSkillChildren(ns, nsPath, entries);
  }
  entries.sort((a, b) => {
    const ka = `${a.namespace || ''}/${a.id}`;
    const kb = `${b.namespace || ''}/${b.id}`;
    return ka.localeCompare(kb);
  });
  return entries;
}

function collectReferences(body, knownNames) {
  const found = new Set();
  if (!body || !knownNames || knownNames.size === 0) return [];

  let m;
  SKILL_PATH_RE.lastIndex = 0;
  while ((m = SKILL_PATH_RE.exec(body)) !== null) {
    const candidate = m[2];
    if (knownNames.has(candidate)) found.add(candidate);
  }

  BACKTICK_TOKEN_RE.lastIndex = 0;
  while ((m = BACKTICK_TOKEN_RE.exec(body)) !== null) {
    const candidate = m[1];
    if (knownNames.has(candidate)) found.add(candidate);
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function collectPlainReferences(body, knownNames) {
  const found = new Set();
  if (!body || !knownNames || knownNames.size === 0) return [];
  let m;
  BACKTICK_TOKEN_RE.lastIndex = 0;
  while ((m = BACKTICK_TOKEN_RE.exec(body)) !== null) {
    const candidate = m[1];
    if (knownNames.has(candidate)) found.add(candidate);
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function buildAgents(skillNames) {
  const files = listAgentFiles();
  const agents = [];
  for (const file of files) {
    const filePath = path.join(AGENTS_DIR, file);
    const content = readFileSafe(filePath);
    const { data, body } = parseFrontmatter(content);
    const id = (typeof data.name === 'string' && data.name.trim())
      ? data.name.trim()
      : file.replace(/\.md$/, '');
    const tools = normalizeTools(data.tools);
    const model = typeof data.model === 'string' ? data.model : null;
    const skillReferences = collectReferences(body, skillNames);
    agents.push({
      id,
      path: path.relative(ROOT, filePath).split(path.sep).join('/'),
      model,
      tools,
      skillReferences
    });
  }
  return agents;
}

function buildSkills(agentNames) {
  const entries = listSkillEntries();
  const skills = [];
  for (const entry of entries) {
    const filePath = path.join(entry.dir, 'SKILL.md');
    const content = readFileSafe(filePath);
    const { data, body } = parseFrontmatter(content);
    const id = (typeof data.name === 'string' && data.name.trim())
      ? data.name.trim()
      : entry.id;
    const tools = normalizeTools(data.tools);
    const origin = typeof data.origin === 'string' ? data.origin : null;
    const agentReferences = collectPlainReferences(body, agentNames);
    skills.push({
      id,
      namespace: entry.namespace,
      path: path.relative(ROOT, filePath).split(path.sep).join('/'),
      origin,
      tools,
      agentReferences
    });
  }
  return skills;
}

function buildCommands() {
  const files = listCommandFiles();
  const commands = [];
  for (const file of files) {
    const filePath = path.join(COMMANDS_DIR, file);
    const content = readFileSafe(filePath);
    const { data } = parseFrontmatter(content);
    const id = (typeof data.name === 'string' && data.name.trim())
      ? data.name.trim()
      : file.replace(/\.md$/, '');
    const entry = {
      id,
      path: path.relative(ROOT, filePath).split(path.sep).join('/')
    };
    if (data['argument-hint'] !== null && data['argument-hint'] !== undefined) {
      entry['argument-hint'] = data['argument-hint'];
    }
    if (typeof data.model === 'string') {
      entry.model = data.model;
    }
    commands.push(entry);
  }
  return commands;
}

function buildHookEntry(event, matcher, blockId, h, i) {
  if (!h || typeof h !== 'object') return null;
  const command = typeof h.command === 'string' ? h.command : '';
  const handlerId = typeof h.id === 'string' ? h.id : null;
  const id = handlerId || blockId || `${event.toLowerCase()}:${matcher || 'any'}:${i}`;
  const scriptMatch = command.match(HOOK_SCRIPT_RE);
  const scriptPath = scriptMatch ? `scripts/hooks/${scriptMatch[1]}` : null;
  return { id, event, matcher, command, scriptPath };
}

function buildHooks() {
  const raw = readFileSafe(HOOKS_JSON);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) { // NOSONAR: invalid settings JSON yields no hook entries
    return [];
  }
  const root = parsed?.hooks ?? {};
  const results = [];
  for (const event of HOOK_EVENTS) {
    const arr = root[event];
    if (!Array.isArray(arr)) continue;
    for (const block of arr) {
      if (!block || typeof block !== 'object') continue;
      const matcher = typeof block.matcher === 'string' ? block.matcher : null;
      const blockId = typeof block.id === 'string' ? block.id : null;
      const handlers = Array.isArray(block.hooks) ? block.hooks : [];
      for (let i = 0; i < handlers.length; i++) {
        const entry = buildHookEntry(event, matcher, blockId, handlers[i], i);
        if (entry) results.push(entry);
      }
    }
  }
  return results;
}

function buildGraph() {
  const skillEntries = listSkillEntries();
  const skillNames = new Set(skillEntries.map(e => e.id));

  const agentFiles = listAgentFiles();
  const agentNames = new Set(agentFiles.map(f => f.replace(/\.md$/, '')));

  const agents = buildAgents(skillNames);
  const skills = buildSkills(agentNames);
  const commands = buildCommands();
  const hooks = buildHooks();

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      agents: agents.length,
      skills: skills.length,
      commands: commands.length,
      hooks: hooks.length
    },
    agents,
    skills,
    commands,
    hooks
  };
}

function main() {
  const countsOnly = process.argv.includes('--counts');
  const graph = buildGraph();
  if (countsOnly) {
    process.stdout.write(JSON.stringify(graph.counts) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildGraph,
  buildAgents,
  buildSkills,
  buildCommands,
  buildHooks
};
