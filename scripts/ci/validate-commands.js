#!/usr/bin/env node
/**
 * Validate command markdown files are non-empty, readable,
 * and have valid cross-references to other commands, agents, and skills.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const COMMANDS_DIR = path.join(ROOT_DIR, 'commands');
const AGENTS_DIR = path.join(ROOT_DIR, 'agents');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');

function validateFrontmatter(file, content) {
  if (!content.startsWith('---\n')) {
    return [];
  }

  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return [`${file} - frontmatter block is missing a closing --- delimiter`];
  }

  const block = content.slice(4, endIndex);
  const errors = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      errors.push(`${file} - invalid frontmatter line: ${rawLine}`);
      continue;
    }

    const value = match[2].trim();
    const isQuoted = (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    );

    if (!isQuoted && value.startsWith('[') && !value.endsWith(']')) {
      errors.push(
        `${file} - frontmatter value for "${match[1]}" starts with "[" but is not a closed YAML sequence; wrap it in quotes`,
      );
    }

    if (!isQuoted && value.startsWith('{') && !value.endsWith('}')) {
      errors.push(
        `${file} - frontmatter value for "${match[1]}" starts with "{" but is not a closed YAML mapping; wrap it in quotes`,
      );
    }
  }

  return errors;
}

const RESERVED_SKILL_ROOTS = new Set(['learned', 'imported']);

function collectValidAgents() {
  const validAgents = new Set();
  if (!fs.existsSync(AGENTS_DIR)) return validAgents;
  for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (f.endsWith('.md')) validAgents.add(f.replace(/\.md$/, ''));
  }
  return validAgents;
}

function collectValidSkills() {
  const validSkills = new Set();
  if (!fs.existsSync(SKILLS_DIR)) return validSkills;
  for (const f of fs.readdirSync(SKILLS_DIR)) {
    const skillPath = path.join(SKILLS_DIR, f);
    try {
      if (fs.statSync(skillPath).isDirectory()) validSkills.add(f);
    } catch {
      // skip unreadable entries
    }
  }
  return validSkills;
}

function checkCommandXrefs(file, contentNoCodeBlocks, validCommands) {
  const errors = [];
  for (const line of contentNoCodeBlocks.split('\n')) {
    if (/creates:|would create:/i.test(line)) continue;
    for (const match of line.matchAll(/`\/([a-z][-a-z0-9]*)`/g)) {
      if (!validCommands.has(match[1])) {
        errors.push(`${file} - references non-existent command /${match[1]}`);
      }
    }
  }
  return errors;
}

function checkAgentPathXrefs(file, contentNoCodeBlocks, validAgents) {
  const errors = [];
  for (const match of contentNoCodeBlocks.matchAll(/agents\/([a-z][-a-z0-9]*)\.md/g)) {
    if (!validAgents.has(match[1])) {
      errors.push(`${file} - references non-existent agent agents/${match[1]}.md`);
    }
  }
  return errors;
}

function checkSkillDirXrefs(file, contentNoCodeBlocks, validSkills) {
  const warns = [];
  for (const match of contentNoCodeBlocks.matchAll(/skills\/([a-z][-a-z0-9]*)\//g)) {
    if (RESERVED_SKILL_ROOTS.has(match[1]) || validSkills.has(match[1])) continue;
    warns.push(`${file} - references skill directory skills/${match[1]}/ (not found locally)`);
  }
  return warns;
}

function checkWorkflowXrefs(file, contentNoCodeBlocks, validAgents) {
  const errors = [];
  for (const match of contentNoCodeBlocks.matchAll(/^([a-z][-a-z0-9]*(?:\s*->\s*[a-z][-a-z0-9]*)+)$/gm)) {
    for (const agent of match[1].split(/\s*->\s*/)) {
      if (!validAgents.has(agent)) {
        errors.push(`${file} - workflow references non-existent agent "${agent}"`);
      }
    }
  }
  return errors;
}

function validateCommandFile(file, validCommands, validAgents, validSkills) {
  const filePath = path.join(COMMANDS_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`ERROR: ${file} - ${err.message}`);
    return { hasErrors: true, warnCount: 0 };
  }

  if (content.trim().length === 0) {
    console.error(`ERROR: ${file} - Empty command file`);
    return { hasErrors: true, warnCount: 0 };
  }

  let hasErrors = false;
  for (const error of validateFrontmatter(file, content)) {
    console.error(`ERROR: ${error}`);
    hasErrors = true;
  }

  // Strip fenced code blocks before checking cross-references.
  // Examples/templates inside ``` blocks are not real references.
  const contentNoCodeBlocks = content.replace(/```[\s\S]*?```/g, '');

  for (const error of checkCommandXrefs(file, contentNoCodeBlocks, validCommands)) {
    console.error(`ERROR: ${error}`);
    hasErrors = true;
  }
  for (const error of checkAgentPathXrefs(file, contentNoCodeBlocks, validAgents)) {
    console.error(`ERROR: ${error}`);
    hasErrors = true;
  }
  const warns = checkSkillDirXrefs(file, contentNoCodeBlocks, validSkills);
  for (const warn of warns) {
    console.warn(`WARN: ${warn}`);
  }
  for (const error of checkWorkflowXrefs(file, contentNoCodeBlocks, validAgents)) {
    console.error(`ERROR: ${error}`);
    hasErrors = true;
  }

  return { hasErrors, warnCount: warns.length };
}

function validateCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.log('No commands directory found, skipping validation');
    process.exit(0);
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  const validCommands = new Set(files.map(f => f.replace(/\.md$/, '')));
  const validAgents = collectValidAgents();
  const validSkills = collectValidSkills();

  let hasErrors = false;
  let warnCount = 0;

  for (const file of files) {
    const result = validateCommandFile(file, validCommands, validAgents, validSkills);
    if (result.hasErrors) hasErrors = true;
    warnCount += result.warnCount;
  }

  if (hasErrors) {
    process.exit(1);
  }

  let msg = `Validated ${files.length} command files`;
  if (warnCount > 0) {
    msg += ` (${warnCount} warnings)`;
  }
  console.log(msg);
}

validateCommands();
