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
// issue or comment, named the branch or authored the commit; any of them
// inside a run: step is a shell injection whatever the triggering event.
// A field is matched anywhere inside an expression (`|| ''`, `format()`,
// a ternary), not only as the whole expression.
const UNTRUSTED_EVENT_PATHS = [
  ['github', 'event', 'pull_request', 'title'],
  ['github', 'event', 'pull_request', 'body'],
  ['github', 'event', 'pull_request', 'head', 'ref'],
  ['github', 'event', 'pull_request', 'head', 'label'],
  ['github', 'event', 'pull_request', 'user', 'login'],
  ['github', 'event', 'pull_request', 'user', 'email'],
  ['github', 'event', 'issue', 'title'],
  ['github', 'event', 'issue', 'body'],
  ['github', 'event', 'comment', 'body'],
  ['github', 'event', 'review', 'body'],
  ['github', 'event', 'review_comment', 'body'],
  ['github', 'event', 'discussion', 'title'],
  ['github', 'event', 'discussion', 'body'],
  ['github', 'event', 'commits', '*', 'message'],
  ['github', 'event', 'commits', '*', 'author', 'name'],
  ['github', 'event', 'commits', '*', 'author', 'email'],
  ['github', 'event', 'commits', '*', 'committer', 'name'],
  ['github', 'event', 'commits', '*', 'committer', 'email'],
  ['github', 'event', 'head_commit', 'message'],
  ['github', 'event', 'head_commit', 'author', 'name'],
  ['github', 'event', 'head_commit', 'author', 'email'],
  ['github', 'event', 'head_commit', 'committer', 'name'],
  ['github', 'event', 'head_commit', 'committer', 'email'],
  ['github', 'head_ref'],
];

// The context paths referenced in an expression, each as its segments, read
// from dotted (`a.b`), bracketed (`a['b']`, `a["b"]`) and indexed (`a[0]`)
// spellings alike, so the spelling cannot hide the field.
function contextPathsIn(expression) {
  const paths = [];
  const reader = /\bgithub((?:\.[A-Za-z_][\w-]*|\[\s*(?:'[^']*'|"[^"]*"|\d+|\*)\s*\])+)/g;
  for (const match of expression.matchAll(reader)) {
    const segments = ['github'];
    const tail = match[1];
    const segment = /\.([A-Za-z_][\w-]*)|\[\s*(?:'([^']*)'|"([^"]*)"|(\d+|\*))\s*\]/g;
    for (const piece of tail.matchAll(segment)) segments.push(piece[1] ?? piece[2] ?? piece[3] ?? piece[4]);
    paths.push(segments);
  }
  return paths;
}

function isUntrustedPath(segments) {
  return UNTRUSTED_EVENT_PATHS.some(known => known.length === segments.length && known.every((part, index) => part === '*' ? /^\d+$|^\*$/.test(segments[index]) : part === segments[index]));
}

// The end of the expression opened at `from`: the first `}}` outside a
// quoted string, so a brace pair inside a string literal is not a closer.
function expressionEnd(text, from) {
  let quote = null;
  for (let i = from + 3; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = text[i + 1] === quote ? (i += 1, quote) : null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '}' && text[i + 1] === '}') {
      return i + 2;
    }
  }
  return -1;
}


// The untrusted fields found inside the `${{ ... }}` expressions of `text`,
// each with its offset in the text. Expressions are found by a plain scan
// (no nested braces in the expression syntax), so a malformed one cannot
// make the scan backtrack.
function untrustedFieldsIn(text) {
  const found = [];
  let from = text.indexOf('${{');
  while (from !== -1) {
    const end = expressionEnd(text, from);
    if (end === -1) break;
    const expression = text.slice(from, end);
    for (const segments of contextPathsIn(expression)) {
      if (isUntrustedPath(segments)) found.push({ index: from, expression: expression.length > 120 ? `${expression.slice(0, 117)}...` : expression, field: segments.join('.') });
    }
    from = text.indexOf('${{', end);
  }
  return found;
}

// The run: blocks of a workflow, with the line each one starts on: the
// scalar after the `run` key (spaces before the colon allowed, as YAML
// does) and, for a block scalar (| or >), every following line indented
// deeper than the key itself. The key's column, not the dash's, bounds the
// block, so a sibling key (env:, shell:) after a block-scalar run: is not
// swallowed into it.
function extractRunBlocks(source) {
  const blocks = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*(?:-\s+)?)run\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyColumn = match[1].length;
    const text = [match[2]];
    if (/^[|>]/.test(match[2].trim())) {
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > keyColumn)) {
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
    for (const found of untrustedFieldsIn(block.text)) {
      violations.push({
        filePath,
        event: 'run',
        description: `run: must not splice untrusted event text (${found.field}) into the shell; pass it through an env: variable and quote it`,
        expression: found.expression,
        line: block.startLine + getLineNumber(block.text, found.index) - 1,
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
  untrustedFieldsIn,

  findViolations,
  validateWorkflowSecurity,
};
