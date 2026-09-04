#!/usr/bin/env node
/**
 * Guardian Command Enforcement Hook
 *
 * Validates every Bash command with the egc-guardian validator before it
 * executes. Compound commands are split into segments so destructive
 * commands cannot hide behind chaining or wrappers like sudo.
 *
 * Blocking policy: only hard denials block (destructive commands,
 * protected paths, forbidden git flags). Allowlist misses and shell
 * metacharacter denials are advisory and never block, otherwise any
 * command outside the guardian allowlist would break the session.
 *
 * Fails open: if the guardian CLI is missing or errors, the command is
 * allowed and a warning is emitted.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');
const { splitShellSegments, extractSubstitutionBodies } = require('../lib/shell-split');

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;

// Caps recursion into nested command/process substitutions
// ($(echo $(echo $(...)))) — a real script has no reason to nest these more
// than a couple of levels deep; this is purely a backstop against adversarial
// or pathological input, not a limit anyone should ever hit legitimately.
const MAX_SUBSTITUTION_DEPTH = 5;

// extractSegments returns null (instead of the usual segment array) when a
// command nests substitutions deeper than MAX_SUBSTITUTION_DEPTH allows
// fully unwrapping. Silently returning only the outer, already-parsed
// segments here (as this used to do) fails OPEN: the innermost
// substitution — the one actually worth hiding a destructive command in,
// e.g. `echo $(echo $(...(rm -rf /)...))` nested one level past the cap —
// is never extracted or validated, and stays buried as inert-looking text
// inside an outer segment whose own leading token (like `echo`) reads as
// safe. run() below hard-blocks on a null return instead, so a command too
// deep to fully analyze fails CLOSED rather than being treated as if
// nothing were found.

// A script an interpreter is asked to run (`bash deploy.sh`, `sh x.txt`,
// `source env.sh`, `. env.sh`, `/bin/bash "my dir/x.sh"`, `sudo bash x.sh`)
// is judged like typed commands: its own segments join the same validation,
// recursively for the scripts it runs in turn, so writing a denied command
// to a file first, under any name, does not change the verdict. A script
// that cannot be inspected (unreadable, too large, nested too deep) fails
// closed.
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'ash', 'source', '.']);
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_SCRIPT_DEPTH = 8;

const BACKSLASH_ESCAPES = process.platform !== 'win32';

// The body of a quoted run starting at its opening quote: single quotes are
// literal, double quotes keep their escapes for \ " $ and `.
function readQuoted(text, start) {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (quote === '"' && text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) i += 1;
    value += text[i];
    i += 1;
  }
  return { value, end: Math.min(i + 1, text.length) };
}

// One shell word as the shell would see it: a backslash outside quotes
// escapes the next character (on Windows it is a path separator instead).
// An unquoted wildcard is remembered: the shell would expand it.
function readShellWord(text, start) {
  let value = '';
  let globbed = false;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
    } else if (/\s/.test(ch)) {
      break;
    } else {
      if (ch === '*' || ch === '?' || ch === '[') globbed = true;
      value += ch;
      i += 1;
    }
  }
  return { value, globbed, end: i };
}

function shellWords(segment) {
  const words = [];
  let i = 0;
  while (i < segment.length) {
    if (/\s/.test(segment[i])) {
      i += 1;
      continue;
    }
    const word = readShellWord(segment, i);
    words.push(word);
    i = word.end;
  }
  return words;
}

// Wrappers that end up running the interpreter, with the options of each
// that take a value of their own (so `sudo --user root bash x.sh` still
// reaches bash).
const WRAPPER_OPTIONS = {
  sudo: { '-u': 1, '--user': 1, '-g': 1, '--group': 1, '-C': 1, '-D': 1, '--chdir': 1, '-p': 1, '--prompt': 1, '-r': 1, '-t': 1, '-U': 1, '-T': 1 },
  doas: { '-u': 1, '-C': 1 },
  env: { '-u': 1, '--unset': 1, '-C': 1, '--chdir': 1, '-S': 1, '--split-string': 1 },
  nice: { '-n': 1, '--adjustment': 1 },
  nohup: {},
  time: { '-f': 1, '--format': 1, '-o': 1, '--output': 1 },
  command: {},
  exec: { '-a': 1 },
  builtin: {},
  xargs: { '-n': 1, '--max-args': 1, '-I': 1, '-i': 1, '--replace': 1, '-L': 1, '-l': 1, '--max-lines': 1, '-P': 1, '--max-procs': 1, '-d': 1, '--delimiter': 1, '-s': 1, '--max-chars': 1, '-E': 1, '--eof': 1, '-a': 1, '--arg-file': 1 },
};

function skipWrapperOptions(words, start, table) {
  let index = start;
  while (index < words.length) {
    const word = words[index].value;
    if (word === '--') return index + 1;
    if (!word.startsWith('-') || word === '-') return index;
    index += 1 + (word.includes('=') ? 0 : (table[word] || 0));
  }
  return index;
}

// The operands of the interpreter in a segment, after env assignments and
// the wrappers above. A variable-expanded interpreter cannot be resolved, so
// its operands are inspected as if it were a shell. After `--` every word is
// an operand, whatever it starts with.
function interpreterOperands(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index].value;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index += 1;
      continue;
    }
    const table = WRAPPER_OPTIONS[word];
    if (!table) break;
    index = skipWrapperOptions(words, index + 1, table);
  }
  const head = words[index];
  if (!head) return [];
  const name = head.value.split(/[\\/]/).pop().toLowerCase();
  if (!head.value.startsWith('$') && !SHELL_INTERPRETERS.has(name)) return [];
  const operands = [];
  let literal = false;
  for (const word of words.slice(index + 1)) {
    if (!literal && word.value === '--') {
      literal = true;
    } else if (literal || !word.value.startsWith('-')) {
      operands.push(word);
    }
  }
  return operands;
}

// Existing files among the operands, resolved against the cwd; a file that
// exists but cannot be read within the budget is reported so the caller
// fails closed instead of skipping it.
function scriptOperandsOf(segment, cwd) {
  const files = [];
  for (const operand of interpreterOperands(shellWords(segment))) {
    const candidate = path.resolve(cwd || process.cwd(), operand.value);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      if (operand.globbed) return { files, blocked: `wildcard operand ${operand.value} cannot be inspected before the shell expands it` };
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCRIPT_BYTES) return { files, blocked: `script ${operand.value} is too large to analyze` };
    files.push(candidate);
  }
  return { files, blocked: null };
}

// Segments of every script the command runs, following scripts that run
// scripts; `blocked` names the reason when one of them cannot be inspected.
function scriptSegmentsOf(segments, cwd, depth = 0, seen = new Set()) {
  const collected = [];
  for (const segment of segments) {
    const operands = scriptOperandsOf(segment, cwd);
    if (operands.blocked) return { segments: collected, blocked: operands.blocked };
    for (const file of operands.files) {
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        return { segments: collected, blocked: `script ${file} cannot be read` };
      }
      if (seen.has(real)) continue;
      seen.add(real);
      if (depth >= MAX_SCRIPT_DEPTH) return { segments: collected, blocked: `scripts nest deeper than ${MAX_SCRIPT_DEPTH} levels` };
      let nested;
      try {
        nested = extractSegments(fs.readFileSync(file, 'utf8'));
      } catch {
        return { segments: collected, blocked: `script ${file} cannot be read` };
      }
      if (nested === null) {
        return { segments: collected, blocked: 'a script it runs nests command/process substitutions deeper than this validator can safely unwrap and analyze' };
      }
      collected.push(...nested);
      const inner = scriptSegmentsOf(nested, cwd, depth + 1, seen);
      collected.push(...inner.segments);
      if (inner.blocked) return { segments: collected, blocked: inner.blocked };
    }
  }
  return { segments: collected, blocked: null };
}

const ADVISORY_REASONS = [
  'Shell chaining/metacharacters are forbidden',
  'is not in the allowlist',
];

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

// Segmentation only splits the compound command on top-level, unquoted
// operators (&&, ||, ;, &, |, newline) — it no longer strips leading
// wrappers (sudo, env, xargs, ...) or env-var assignments itself. That
// unwrapping now happens once, centrally, in the guardian's own
// validateCommand (mcp/servers/egc-guardian/src/validator.ts), which both
// this hook and the validate_command MCP tool call through the CLI below —
// duplicating the same peeling logic in two places is exactly how earlier
// fixes here ended up covering only the specific wrapper names each audit
// happened to name (see the project's Guardian bypass post-mortem).
//
// Command/process substitutions ($(...), <(...), >(...), `...`) are also
// extracted and validated as their own additional segments, recursively (up
// to MAX_SUBSTITUTION_DEPTH): `echo $(rm -rf /)` must not slip through as
// one benign-looking `echo` segment just because `$`/backtick are not
// top-level separators.
function extractSegments(command, depth = 0) {
  const bodies = extractSubstitutionBodies(command);

  // There is at least one more level of substitution here that recursing
  // would need to unwrap, and depth is already at the cap: analysis cannot
  // continue safely. Return null rather than the partial topLevel result so
  // the caller blocks instead of silently accepting an unanalyzed command.
  if (bodies.length > 0 && depth >= MAX_SUBSTITUTION_DEPTH) return null;

  const topLevel = splitShellSegments(command, { splitOnPipe: true })
    .map(s => s.trim())
    .filter(Boolean);

  const nested = [];
  for (const body of bodies) {
    const nestedSegments = extractSegments(body, depth + 1);
    if (nestedSegments === null) return null;
    nested.push(...nestedSegments);
  }

  return [...topLevel, ...nested];
}

function isAdvisory(verdict) {
  const reason = String(verdict.reason || '');
  return ADVISORY_REASONS.some(marker => reason.includes(marker));
}

// The first verdict that denies for a hard reason, as the hook's answer.
function firstHardBlock(verdicts, segments) {
  for (let i = 0; i < verdicts.length; i++) {
    const verdict = verdicts[i] || {};
    if (verdict.allowed === false && !isAdvisory(verdict)) {
      return {
        exitCode: 2,
        stderr:
          `EGC Guardian BLOCKED this command: ${verdict.reason || 'denied by policy'} ` +
          `(segment: ${segments[i]}). Adjust the command to comply with the project safety rules.`,
      };
    }
  }
  return null;
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = input?.tool_input?.command;
  if (!command || typeof command !== 'string') return { exitCode: 0 };

  const segments = extractSegments(command);
  if (segments === null) {
    return {
      exitCode: 2,
      stderr:
        'EGC Guardian BLOCKED this command: nested command/process substitutions ' +
        'go deeper than this validator can safely unwrap and analyze. Simplify the ' +
        'command so every substitution can be validated.',
    };
  }
  if (segments.length === 0) return { exitCode: 0 };

  const cli = resolveGuardianCli();
  // resolveGuardianCli() only returns falsy when all 3 of its resolution
  // strategies fail at once (env var, package-relative build, and both
  // trusted MCP config files) — reproduced deterministically in
  // tests/hooks/pre-bash-guardian-validate.test.js by stubbing guardian-bin
  // in require.cache before re-requiring this file, so the falsy-cli branch
  // is genuinely exercised (and its coverage correctly attributed here)
  // without needing a real "nothing resolves" filesystem/HOME setup.
  if (!cli) {
    return { exitCode: 0 };
  }

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const scripts = scriptSegmentsOf(segments, cwd);
  if (scripts.blocked) {
    return {
      exitCode: 2,
      stderr: `EGC Guardian BLOCKED this command: ${scripts.blocked}.`,
    };
  }
  segments.push(...scripts.segments);
  const verdicts = callGuardian(
    cli,
    ['command-batch'],
    JSON.stringify({ commands: segments, cwd }),
    VALIDATE_TIMEOUT_MS,
  );
  if (!Array.isArray(verdicts)) return { exitCode: 0 };
  const hardBlock = firstHardBlock(verdicts, segments);
  if (hardBlock) return hardBlock;

  return { exitCode: 0 };
}

module.exports = { run, extractSegments, isAdvisory };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}
