'use strict';

const fs = require('node:fs');

// A copy transform rewrites the bytes of one planned file on the way to its
// destination. The plan names it (operation.transform); the executor writes
// the result; doctor, repair and retirement compare the destination against
// the same result, so a transformed file never reads as drifted or foreign.

const CLAUDE_AGENT_FRONTMATTER_TRANSFORM = 'claude-agent-frontmatter';
const OPENCODE_AGENT_FRONTMATTER_TRANSFORM = 'opencode-agent-frontmatter';

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
  return trimmed
    .slice(1, -1)
    .split(',')
    .map(item => stripQuotes(item.trim()))
    .filter(Boolean);
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

// Collects the items of a block-style YAML list that follows a key with no
// inline value, returning them with the index of the first line after them.
function collectBlockListItems(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const item = lines[index].match(/^\s+-\s*(.+?)\s*$/);
    if (!item) break;
    items.push(stripQuotes(item[1]));
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

const TRANSFORMS = Object.freeze({
  [CLAUDE_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toClaudeAgentFrontmatter(content.toString('utf8')), 'utf8'),
  [OPENCODE_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toOpenCodeAgentFrontmatter(content.toString('utf8')), 'utf8'),
});

function transformContent(content, transform) {
  const apply = TRANSFORMS[transform];
  if (typeof apply !== 'function') {
    throw new TypeError(`Unknown copy transform: ${transform}`);
  }
  return apply(content);
}

// The bytes a planned copy leaves at its destination: the source as-is, or
// the source through the operation's transform.
function plannedFileContent(sourcePath, transform) {
  const content = fs.readFileSync(sourcePath);
  return transform ? transformContent(content, transform) : content;
}

module.exports = {
  CLAUDE_AGENT_FRONTMATTER_TRANSFORM,
  OPENCODE_AGENT_FRONTMATTER_TRANSFORM,
  plannedFileContent,
  toClaudeAgentFrontmatter,
  toOpenCodeAgentFrontmatter,
  transformContent,
};
