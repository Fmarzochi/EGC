'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A copy transform rewrites the bytes of one planned file on the way to its
// destination. The plan names it (operation.transform); the executor writes
// the result; doctor, repair and retirement compare the destination against
// the same result, so a transformed file never reads as drifted or foreign.

const CLAUDE_AGENT_FRONTMATTER_TRANSFORM = 'claude-agent-frontmatter';
const OPENCODE_AGENT_FRONTMATTER_TRANSFORM = 'opencode-agent-frontmatter';
const ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM = 'antigravity-rule-frontmatter';
const ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM = 'antigravity-manual-rule-frontmatter';
const ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM = 'antigravity-agent-frontmatter';

// Model names Claude Code resolves itself. Anything else in an agent's
// frontmatter (the catalog's Gemini ids) would be sent to the API as-is and
// fail when the subagent starts, so it is dropped and the subagent inherits
// the session model.
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const CLAUDE_DROPPED_KEYS = new Set(['stack']);

// A source may reach the installer with CRLF line endings (a Windows
// checkout) or a byte order mark; the frontmatter is recognized either way
// and the transformed file is written with LF, like the repository.
function stripByteOrderMark(text) {
  return text.codePointAt(0) === 0xFEFF ? text.slice(1) : text;
}

function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return null;
  }
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    return null;
  }
  return {
    frontmatter: lines.slice(1, end),
    body: lines.slice(end + 1),
  };
}

function parseFlowSequence(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }
  return splitFlowItems(trimmed.slice(1, -1))
    .map(item => stripQuotes(item.trim()))
    .filter(Boolean);
}

function splitFlowItems(inner) {
  const items = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

function stripQuotes(value) {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

// A frontmatter line splits at its first colon; the key is a YAML-style
// identifier and the value is whatever follows, trimmed. Done by hand rather
// than by one regular expression so no pattern has to backtrack over the
// value.
function splitFrontmatterLine(line) {
  const colon = line.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  const key = line.slice(0, colon);
  if (!/^[A-Za-z_][\w-]*$/.test(key)) {
    return null;
  }
  return { key, value: line.slice(colon + 1).trim() };
}

function rewriteClaudeAgentLine(line) {
  const match = splitFrontmatterLine(line);
  if (!match) {
    return line;
  }
  const { key, value } = match;
  if (CLAUDE_DROPPED_KEYS.has(key)) {
    return null;
  }
  if (key === 'tools') {
    const items = parseFlowSequence(value);
    return items ? `tools: ${items.join(', ')}` : line;
  }
  if (key === 'model') {
    return CLAUDE_MODEL_ALIASES.has(value.trim()) ? line : null;
  }
  if (key === 'name') {
    return `name: ${value.trim().toLowerCase()}`;
  }
  return line;
}

function toClaudeAgentFrontmatter(text) {
  const parts = splitFrontmatter(stripByteOrderMark(text));
  if (!parts) {
    return text;
  }
  const frontmatter = parts.frontmatter
    .map(rewriteClaudeAgentLine)
    .filter(line => line !== null);
  return ['---', ...frontmatter, '---', ...parts.body].join('\n');
}

// OpenCode reads ~/.config/opencode/agents/*.md as its own agent definitions
// and validates the frontmatter: tools is an object of tool name to boolean,
// color must be a hex value, a model is a provider/model id. The catalog
// agent's tools list becomes that object, the Gemini model, the stack and
// the named color are dropped, and the agent is declared a subagent so
// OpenCode offers it through @ and the task tool.
const OPENCODE_DROPPED_KEYS = new Set(['model', 'stack', 'color']);

// OpenCode names its tools in lowercase (read, grep, bash, webfetch); the
// catalog writes them the way Claude Code does. An MCP tool keeps its name.
function toOpenCodeToolId(name) {
  return name.trim().toLowerCase();
}

// An item of a block-style YAML list: an indented line whose first
// non-blank character is a dash followed by text. Parsed by hand so no
// pattern backtracks; a bare dash is not an item and ends the list.
function blockListItem(line) {
  if (line.length === 0 || (line[0] !== ' ' && line[0] !== '\t')) {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) {
    return null;
  }
  const item = stripQuotes(trimmed.slice(1).trim());
  return item.length > 0 ? item : null;
}

// Collects the items of a block-style YAML list that follows a key with no
// inline value, returning them with the index of the first line after them.
function collectBlockListItems(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const item = blockListItem(lines[index]);
    if (item === null) break;
    items.push(item);
    index += 1;
  }
  return { items, next: index };
}

function toOpenCodeToolsBlock(items) {
  return ['tools:', ...items.map(item => `  ${toOpenCodeToolId(item)}: true`)];
}

function rewriteOpenCodeAgentFrontmatter(lines) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = splitFrontmatterLine(line);
    index += 1;
    if (!match) {
      output.push(line);
      continue;
    }
    const { key, value } = match;
    if (OPENCODE_DROPPED_KEYS.has(key)) {
      continue;
    }
    if (key !== 'tools') {
      output.push(line);
      continue;
    }
    const flow = parseFlowSequence(value);
    if (flow) {
      output.push(...toOpenCodeToolsBlock(flow));
      continue;
    }
    if (value === '') {
      const block = collectBlockListItems(lines, index);
      output.push(...toOpenCodeToolsBlock(block.items));
      index = block.next;
      continue;
    }
    output.push(line);
  }
  return output;
}

function toOpenCodeAgentFrontmatter(text) {
  const parts = splitFrontmatter(stripByteOrderMark(text));
  if (!parts) {
    return text;
  }
  const frontmatter = rewriteOpenCodeAgentFrontmatter(parts.frontmatter);
  if (!frontmatter.some(line => splitFrontmatterLine(line)?.key === 'mode')) {
    frontmatter.push('mode: subagent');
  }
  return ['---', ...frontmatter, '---', ...parts.body].join('\n');
}

function readRuleGlobs(frontmatter) {
  const index = frontmatter.findIndex(line => splitFrontmatterLine(line)?.key === 'paths');
  if (index < 0) {
    return [];
  }
  const flow = parseFlowSequence(splitFrontmatterLine(frontmatter[index]).value);
  return (flow || collectBlockListItems(frontmatter, index + 1).items).flatMap(expandGlobBraces);
}

function expandGlobBraces(glob) {
  const close = glob.indexOf('}');
  const open = close < 0 ? -1 : glob.lastIndexOf('{', close);
  if (open < 0) {
    return [glob];
  }
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return glob.slice(open + 1, close).split(',').flatMap(option => expandGlobBraces(`${head}${option.trim()}${tail}`));
}

function ruleTrigger(manual, globs) {
  if (manual) {
    return 'manual';
  }
  return globs.length > 0 ? 'glob' : 'always_on';
}

function flattenRuleLinks(line, directory) {
  if (directory === null) {
    return line;
  }
  return line.replaceAll(/\]\(([^()\s:#]+\.md)\)/g, (match, link) => {
    const target = path.posix.normalize(path.posix.join(directory, link));
    if (link.startsWith('/') || target.startsWith('../')) {
      return match;
    }
    return `](${target.replaceAll('/', '-')})`;
  });
}

function toAntigravityRule(text, { manual = false, directory = null } = {}) {
  const source = stripByteOrderMark(text);
  const parts = splitFrontmatter(source) || { frontmatter: [], body: source.split(/\r?\n/) };
  const globs = manual ? [] : readRuleGlobs(parts.frontmatter);
  const heading = parts.body.find(line => line.startsWith('# '));
  const frontmatter = [`trigger: ${ruleTrigger(manual, globs)}`];
  if (heading) {
    frontmatter.push(`description: ${JSON.stringify(heading.slice(2).trim())}`);
  }
  if (globs.length > 0) {
    frontmatter.push(`globs: ${JSON.stringify(globs.join(', '))}`);
  }
  return ['---', ...frontmatter, '---', ...parts.body.map(line => flattenRuleLinks(line, directory))].join('\n');
}

const ANTIGRAVITY_TOOL_NAMES = new Map([
  ['Read', 'view_file'],
  ['Grep', 'grep_search'],
  ['Bash', 'run_command'],
  ['Write', 'write_to_file'],
  ['Edit', 'replace_file_content'],
  ['MultiEdit', 'multi_replace_file_content'],
]);
const ANTIGRAVITY_AGENT_DROPPED_KEYS = new Set(['stack', 'color']);
const ANTIGRAVITY_MODELS = new Set(['inherit', 'flash', 'pro']);

function toAntigravityModel(value) {
  const model = stripQuotes(value.trim()).toLowerCase();
  if (ANTIGRAVITY_MODELS.has(model)) {
    return model;
  }
  if (/(^|-)flash($|-)/.test(model)) {
    return 'flash';
  }
  return /(^|-)pro($|-)/.test(model) ? 'pro' : null;
}

function toAntigravityToolsBlock(items) {
  const tools = [...new Set(items.map(item => ANTIGRAVITY_TOOL_NAMES.get(stripQuotes(item.trim()))).filter(Boolean))];
  return tools.length > 0 ? ['tools:', ...tools.map(tool => `  - ${tool}`)] : [];
}

function readFrontmatterList(value, lines, index) {
  const flow = parseFlowSequence(value);
  if (flow) {
    return { items: flow, next: index };
  }
  if (value === '') {
    return collectBlockListItems(lines, index);
  }
  return { items: value.split(','), next: index };
}

function rewriteAntigravityAgentFrontmatter(lines) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = splitFrontmatterLine(line);
    index += 1;
    if (!match) {
      output.push(line);
      continue;
    }
    const { key, value } = match;
    if (ANTIGRAVITY_AGENT_DROPPED_KEYS.has(key)) {
      index = value === '' ? collectBlockListItems(lines, index).next : index;
      continue;
    }
    if (key === 'model') {
      const model = toAntigravityModel(value);
      if (model) output.push(`model: ${model}`);
      continue;
    }
    if (key === 'tools') {
      const list = readFrontmatterList(value, lines, index);
      output.push(...toAntigravityToolsBlock(list.items));
      index = list.next;
      continue;
    }
    output.push(line);
  }
  return output;
}

function toAntigravityAgentFrontmatter(text) {
  const parts = splitFrontmatter(stripByteOrderMark(text));
  if (!parts) {
    return text;
  }
  return ['---', ...rewriteAntigravityAgentFrontmatter(parts.frontmatter), '---', ...parts.body].join('\n');
}

function ruleDirectory(sourcePath) {
  if (!sourcePath) {
    return null;
  }
  const segments = path.resolve(sourcePath).split(path.sep);
  const rulesIndex = segments.lastIndexOf('rules');
  return rulesIndex < 0 ? null : segments.slice(rulesIndex + 1, -1).join('/');
}

const TRANSFORMS = Object.freeze({
  [CLAUDE_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toClaudeAgentFrontmatter(content.toString('utf8')), 'utf8'),
  [OPENCODE_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toOpenCodeAgentFrontmatter(content.toString('utf8')), 'utf8'),
  [ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM]: (content, sourcePath) => Buffer.from(
    toAntigravityRule(content.toString('utf8'), { directory: ruleDirectory(sourcePath) }),
    'utf8'
  ),
  [ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toAntigravityAgentFrontmatter(content.toString('utf8')), 'utf8'),
  [ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM]: (content, sourcePath) => Buffer.from(
    toAntigravityRule(content.toString('utf8'), { manual: true, directory: ruleDirectory(sourcePath) }),
    'utf8'
  ),
});

function transformContent(content, transform, sourcePath = null) {
  const apply = TRANSFORMS[transform];
  if (typeof apply !== 'function') {
    throw new TypeError(`Unknown copy transform: ${transform}`);
  }
  return apply(content, sourcePath);
}

// The bytes a planned copy leaves at its destination: the source as-is, or
// the source through the operation's transform.
function plannedFileContent(sourcePath, transform) {
  const content = fs.readFileSync(sourcePath);
  return transform ? transformContent(content, transform, sourcePath) : content;
}

module.exports = {
  ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM,
  CLAUDE_AGENT_FRONTMATTER_TRANSFORM,
  OPENCODE_AGENT_FRONTMATTER_TRANSFORM,
  plannedFileContent,
  toAntigravityAgentFrontmatter,
  toAntigravityRule,
  toClaudeAgentFrontmatter,
  toOpenCodeAgentFrontmatter,
  transformContent,
};
