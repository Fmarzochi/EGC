'use strict';

// Shared frontmatter-block delimiter detection for scripts/ci/validate-agents.js,
// scripts/ci/validate-skill-frontmatter.js, and scripts/ci/validate-commands.js.
// All three used to reimplement the same "find the --- ... --- block" regex
// independently (EGC-539 audit, Finding 5) -- this only locates the block; each
// caller still parses its own contents (key:value pairs vs. syntax-only checks)
// because their needs diverge past this point.

const BOM = String.fromCharCode(0xFEFF);

function extractFrontmatterBlock(content) {
  const cleanContent = content.startsWith(BOM) ? content.slice(BOM.length) : content;

  if (!/^---\r?\n/.test(cleanContent)) {
    return { error: 'missing' };
  }

  const match = cleanContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { error: 'unterminated' };
  }

  return { raw: match[1] };
}

module.exports = { extractFrontmatterBlock };
