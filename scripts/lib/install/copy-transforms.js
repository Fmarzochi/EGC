'use strict';

const fs = require('node:fs');

// A copy transform rewrites the bytes of one planned file on the way to its
// destination. The plan names it (operation.transform); the executor writes
// the result; doctor, repair and retirement compare the destination against
// the same result, so a transformed file never reads as drifted or foreign.

const CLAUDE_AGENT_FRONTMATTER_TRANSFORM = 'claude-agent-frontmatter';

// Model names Claude Code resolves itself. Anything else in an agent's
// frontmatter (the catalog's Gemini ids) would be sent to the API as-is and
// fail when the subagent starts, so it is dropped and the subagent inherits
// the session model.
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const CLAUDE_DROPPED_KEYS = new Set(['stack']);

function splitFrontmatter(text) {
  const lines = text.split('\n');
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
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function rewriteClaudeAgentLine(line) {
  const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
  if (!match) {
    return line;
  }
  const [, key, value] = match;
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
  const parts = splitFrontmatter(text);
  if (!parts) {
    return text;
  }
  const frontmatter = parts.frontmatter
    .map(rewriteClaudeAgentLine)
    .filter(line => line !== null);
  return ['---', ...frontmatter, '---', ...parts.body].join('\n');
}

const TRANSFORMS = Object.freeze({
  [CLAUDE_AGENT_FRONTMATTER_TRANSFORM]: content => Buffer.from(toClaudeAgentFrontmatter(content.toString('utf8')), 'utf8'),
});

function transformContent(content, transform) {
  const apply = TRANSFORMS[transform];
  if (typeof apply !== 'function') {
    throw new Error(`Unknown copy transform: ${transform}`);
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
  plannedFileContent,
  toClaudeAgentFrontmatter,
  transformContent,
};
