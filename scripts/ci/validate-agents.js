#!/usr/bin/env node
/**
 * Validate agent markdown files have required frontmatter
 */

const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatterBlock } = require('#lib/frontmatter-block');
const { skipIfMissing, finishValidation } = require('#lib/validator-cli');

const AGENTS_DIR = path.join(__dirname, '../../agents');
const REQUIRED_FIELDS = ['model', 'tools'];
const VALID_MODELS = [
  'haiku', 'sonnet', 'opus', 'pro', 'flash', 'lite', 'ultra',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-2.0-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
  'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'
];

function extractFrontmatter(content) {
  const block = extractFrontmatterBlock(content);
  if (block.error) return null;

  const frontmatter = {};
  const lines = block.raw.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

function readAgentContent(file, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`ERROR: ${file} - ${err.message}`);
    return null;
  }
}

function validateAgentFrontmatter(file, frontmatter) {
  let hasErrors = false;
  for (const field of REQUIRED_FIELDS) {
    if (!frontmatter[field] || (typeof frontmatter[field] === 'string' && !frontmatter[field].trim())) {
      console.error(`ERROR: ${file} - Missing required field: ${field}`);
      hasErrors = true;
    }
  }
  if (frontmatter.model && !VALID_MODELS.includes(frontmatter.model)) {
    console.error(`ERROR: ${file} - Invalid model '${frontmatter.model}'. Must be one of: ${VALID_MODELS.join(', ')}`);
    hasErrors = true;
  }
  return hasErrors;
}

function validateAgents() {
  skipIfMissing(AGENTS_DIR, 'No agents directory found, skipping validation');

  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  let hasErrors = false;

  for (const file of files) {
    const content = readAgentContent(file, path.join(AGENTS_DIR, file));
    if (content === null) { hasErrors = true; continue; }

    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) {
      console.error(`ERROR: ${file} - Missing frontmatter`);
      hasErrors = true;
      continue;
    }

    if (validateAgentFrontmatter(file, frontmatter)) hasErrors = true;
  }

  finishValidation(hasErrors, `Validated ${files.length} agent files`);
}

validateAgents();
