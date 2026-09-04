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
const INTERPRETER_WRAPPERS = new Set(['sudo', 'doas', 'env', 'nice', 'nohup', 'time', 'command', 'exec', 'builtin']);
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_SCRIPT_DEPTH = 8;

function shellWordEnd(text, start) {
  let quote = null;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '\\') {
      i += 1;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      break;
    }
    i += 1;
  }
  return Math.min(i, text.length);
}

// The words of one segment as the shell would see them: quotes removed and
// backslashes resolved, so a path with a space is one operand.
function shellWords(segment) {
  const words = [];
  let i = 0;
  while (i < segment.length) {
    if (/\s/.test(segment[i])) {
      i += 1;
      continue;
    }
    const end = shellWordEnd(segment, i);
    words.push(segment.slice(i, end).replace(/\\(.)/g, '$1').replace(/["']/g, ''));
    i = end;
  }
  return words;
}

// The operands of the interpreter in a segment, after env assignments and
// the usual wrappers (their own options included, plus the user of sudo -u).
// A variable-expanded interpreter cannot be resolved, so its operands are
// inspected as if it were a shell.
function interpreterOperands(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index += 1;
    } else if (INTERPRETER_WRAPPERS.has(word)) {
      index += 1;
      while (index < words.length && words[index].startsWith('-')) {
        index += (word === 'sudo' || word === 'doas') && words[index] === '-u' ? 2 : 1;
      }
    } else {
      break;
    }
  }
  const head = words[index];
  if (!head) return [];
  const name = head.split(/[\\/]/).pop().toLowerCase();
  if (!head.startsWith('$') && !SHELL_INTERPRETERS.has(name)) return [];
  return words.slice(index + 1).filter(word => !word.startsWith('-'));
}

// Existing files among the operands, resolved against the cwd; a file that
// exists but cannot be read within the budget is reported so the caller
// fails closed instead of skipping it.
function scriptOperandsOf(segment, cwd) {
  const files = [];
  for (const operand of interpreterOperands(shellWords(segment))) {
    const candidate = path.resolve(cwd || process.cwd(), operand);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCRIPT_BYTES) return { files, blocked: `script ${operand} is too large to analyze` };
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
