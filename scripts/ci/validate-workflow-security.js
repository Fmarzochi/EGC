#!/usr/bin/env node
/**
 * Reject unsafe GitHub Actions patterns that execute or checkout untrusted PR code
 * from privileged events such as workflow_run or pull_request_target, and
 * any `run:` step that splices attacker-controlled event text (a pull
 * request title or body, an issue or comment body, a branch name) into the
 * shell: the runner expands the expression before the shell reads it, so
 * the text is code.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WORKFLOWS_DIR = path.join(__dirname, '../../.github/workflows');

const RULES = [
  {
    event: 'workflow_run',
    eventPattern: /\bworkflow_run\s*:/m,
    description: 'workflow_run must not checkout an untrusted workflow_run head ref/repository',
    expressionPatterns: [
      /\$\{\{\s*github\.event\.workflow_run\.(?:head_branch|head_sha|head_repository(?:\.[A-Za-z0-9_.]+)?)\s*\}\}/g,
      /\$\{\{\s*github\.event\.workflow_run\.pull_requests\[\d+\]\.head\.(?:ref|sha|repo\.full_name)\s*\}\}/g,
    ],
  },
  {
    event: 'pull_request_target',
    eventPattern: /\bpull_request_target\s*:/m,
    description: 'pull_request_target must not checkout an untrusted pull_request head ref/repository',
    expressionPatterns: [
      /\$\{\{\s*github\.event\.pull_request\.head\.(?:ref|sha|repo\.full_name)\s*\}\}/g,
    ],
  },
];

// Event fields whose text is written by whoever opened the pull request,
// issue or comment, or named the branch; any of them inside a run: step is
// a shell injection whatever the triggering event.
const UNTRUSTED_TEXT_EXPRESSION = /\$\{\{\s*github\.(?:event\.(?:pull_request\.(?:title|body|head\.(?:ref|label)|user\.(?:login|email))|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|commits\[\d+\]\.(?:message|author\.(?:name|email))|head_commit\.(?:message|author\.(?:name|email)))|head_ref)\s*\}\}/g;

// The run: blocks of a workflow, with the line each one starts on: the
// scalar after `run:` and, for a block scalar (| or >), every following
// line indented deeper than the key.
function extractRunBlocks(source) {
  const blocks = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const text = [match[2]];
    if (/^[|>]/.test(match[2].trim())) {
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent)) {
        text.push(lines[j]);
        j += 1;
      }
    }
    blocks.push({ startLine: i + 1, text: text.join('\n') });
  }
  return blocks;
}

function findRunInjections(filePath, source) {
  const violations = [];
  for (const block of extractRunBlocks(source)) {
    for (const match of block.text.matchAll(UNTRUSTED_TEXT_EXPRESSION)) {
      violations.push({
        filePath,
        event: 'run',
        description: 'run: must not splice untrusted event text into the shell; pass it through an env: variable and quote it',
        expression: match[0],
        line: block.startLine + getLineNumber(block.text, match.index) - 1,
      });
    }
  }
  return violations;
}

function getWorkflowFiles(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) {
    return [];
  }

  return fs.readdirSync(workflowsDir)
    .filter(file => /\.(?:yml|yaml)$/i.test(file))
    .map(file => path.join(workflowsDir, file))
    .sort();
}

function getLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function extractCheckoutSteps(source) {
  const blocks = [];
  const lines = source.split(/\r?\n/);
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stepStart = line.match(/^(\s*)-\s+/);

    if (stepStart) {
      if (current) {
        blocks.push(current);
      }

      current = {
        indent: stepStart[1].length,
        startLine: i + 1,
        lines: [line],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks
    .map(block => ({
      startLine: block.startLine,
      text: block.lines.join('\n'),
    }))
    .filter(block => /uses:\s*actions\/checkout@/m.test(block.text));
}

function findViolations(filePath, source) {
  const violations = [];
  const checkoutSteps = extractCheckoutSteps(source);

  for (const rule of RULES) {
    if (!rule.eventPattern.test(source)) {
      continue;
    }

    for (const step of checkoutSteps) {
      // Scan each pattern, then sort by match position so the report keeps
      // the same document order the former single alternation produced.
      const matches = rule.expressionPatterns.flatMap(pattern => [...step.text.matchAll(pattern)]);
      matches.sort((a, b) => a.index - b.index);
      for (const match of matches) {
        violations.push({
          filePath,
          event: rule.event,
          description: rule.description,
          expression: match[0],
          line: step.startLine + getLineNumber(step.text, match.index) - 1,
        });
      }
    }
  }

  violations.push(...findRunInjections(filePath, source));
  return violations;
}

function validateWorkflowSecurity(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  const files = getWorkflowFiles(workflowsDir);
  const violations = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    violations.push(...findViolations(filePath, source));
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `ERROR: ${path.basename(violation.filePath)}:${violation.line} - ${violation.description}`,
      );
      console.error(`  Unsafe expression: ${violation.expression}`);
    }
    return 1;
  }

  console.log(`Validated workflow security for ${files.length} workflow files`);
  return 0;
}

if (require.main === module) {
  // EGC_WORKFLOWS_DIR is canonical; ECC_WORKFLOWS_DIR is the legacy bridge.
  const workflowsDir = process.env.EGC_WORKFLOWS_DIR || process.env.ECC_WORKFLOWS_DIR || DEFAULT_WORKFLOWS_DIR;
  process.exit(validateWorkflowSecurity(workflowsDir));
}

module.exports = {
  DEFAULT_WORKFLOWS_DIR,
  extractCheckoutSteps,
  extractRunBlocks,
  findRunInjections,
  findViolations,
  validateWorkflowSecurity,
};
