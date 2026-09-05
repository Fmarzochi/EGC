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

const IDENTIFIER_CHARS = /^[A-Za-z0-9_-]$/;

function isWordChar(ch) {
  return ch !== undefined && IDENTIFIER_CHARS.test(ch);
}

// One bracketed segment starting at the `[` at `from`: a quoted name, an
// index or a `*`, with spaces allowed inside the brackets. Returns the
// segment and the index after the `]`, or null when the text is not one.
function bracketSegment(text, from) {
  let i = from + 1;
  while (text[i] === ' ') i += 1;
  let value;
  const quote = text[i];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, i + 1);
    if (close === -1) return null;
    value = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const start = i;
    while (text[i] === '*' || (text[i] >= '0' && text[i] <= '9')) i += 1;
    if (i === start) return null;
    value = text.slice(start, i);
  }
  while (text[i] === ' ') i += 1;
  return text[i] === ']' ? { value, next: i + 1 } : null;
}

// One dotted segment starting at the `.` at `from`: an identifier or the
// `*` object filter. Returns the segment and the index after it, or null.
function dottedSegment(text, from) {
  let i = from + 1;
  if (text[i] === '*') return { value: '*', next: i + 1 };
  const start = i;
  while (isWordChar(text[i])) i += 1;
  return i === start ? null : { value: text.slice(start, i), next: i };
}

function nextSegment(text, at) {
  if (text[at] === '.') return dottedSegment(text, at);
  return text[at] === '[' ? bracketSegment(text, at) : null;
}

// The context paths referenced in an expression, each as its segments, read
// from dotted (`a.b`), bracketed (`a['b']`, `a["b"]`), indexed (`a[0]`) and
// filtered (`a.*.b`) spellings alike, so the spelling cannot hide the field.
// A plain index walk, so no pattern can make the read backtrack.
function contextPathsIn(expression) {
  const paths = [];
  let from = expression.indexOf('github');
  while (from !== -1) {
    let i = from + 'github'.length;
    const segments = ['github'];
    if (!isWordChar(expression[from - 1])) {
      let segment = nextSegment(expression, i);
      while (segment) {
        segments.push(segment.value);
        i = segment.next;
        segment = nextSegment(expression, i);
      }
      if (segments.length > 1) paths.push(segments);
    }
    from = expression.indexOf('github', i);
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
function isBlank(ch) {
  return ch === ' ' || ch === '\t';
}

// The `run` key on a line, with the column the key starts on (after the
// indentation and an optional list dash) and the scalar after the colon;
// spaces before the colon are allowed, as YAML does. Read by index, so no
// pattern can make the read backtrack.
function runKeyOn(line) {
  let i = 0;
  while (isBlank(line[i])) i += 1;
  if (line[i] === '-') {
    i += 1;
    if (!isBlank(line[i])) return null;
    while (isBlank(line[i])) i += 1;
  }
  const column = i;
  if (!line.startsWith('run', i)) return null;
  i += 'run'.length;
  while (isBlank(line[i])) i += 1;
  if (line[i] !== ':') return null;
  i += 1;
  while (isBlank(line[i])) i += 1;
  return { column, value: line.slice(i) };
}

function extractRunBlocks(source) {
  const blocks = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const key = runKeyOn(lines[i]);
    if (!key) continue;
    const keyColumn = key.column;
    const text = [key.value];
    if (/^[|>]/.test(key.value.trim())) {
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
