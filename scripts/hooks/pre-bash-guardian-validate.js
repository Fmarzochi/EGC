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
 * Without a validator installed the command is allowed, so a machine
 * without the build is never locked out. A validator that is installed but
 * gives no verdict (it stalls, stops, or answers something unreadable)
 * blocks the command, and the message says why and what to do. The
 * validator gets four seconds, or EGC_GUARDIAN_TIMEOUT_MS milliseconds when
 * that is set, so a slow machine raises the budget instead of the gate.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveGuardianCli, callGuardianVerdict } = require('../lib/guardian-bin');
const { splitShellSegments, extractSubstitutionBodies } = require('../lib/shell-split');
const { WRAPPER_SPECS, readWrapperOption } = require('../lib/wrapper-options');

const MAX_STDIN = 1024 * 1024;
const DEFAULT_VALIDATE_TIMEOUT_MS = 4000;

// The budget the validator gets, in milliseconds: EGC_GUARDIAN_TIMEOUT_MS
// when it is a positive whole number, the default otherwise.
function validateTimeoutMs() {
  const budget = Number(process.env.EGC_GUARDIAN_TIMEOUT_MS);
  return Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_VALIDATE_TIMEOUT_MS;
}
const VALIDATE_TIMEOUT_MS = validateTimeoutMs();

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
const LITERAL = '\u0001';
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// Numeric ANSI-C escapes inside $'...': the introducing letter (none for
// octal), the digit class, the longest run and the radix; `\cX` and the
// named escapes follow. An unknown escape keeps its backslash, as Bash does.
const ANSI_NUMERIC = [['x', /[0-9a-fA-F]/, 2, 16], ['u', /[0-9a-fA-F]/, 4, 16], ['U', /[0-9a-fA-F]/, 8, 16], ['', /[0-7]/, 3, 8]];

// A byte escape above 0x7F (\xHH, octal) names a raw byte the shell passes
// through; a string cannot carry it faithfully, so the word is marked as one
// this hook cannot resolve. A code point beyond Unicode is kept as typed.
function ansiNumeric(text, at) {
  const next = text[at + 1];
  for (const [letter, digit, max, radix] of ANSI_NUMERIC) {
    if (letter && next !== letter) continue;
    let end = at + 1 + letter.length;
    const from = end;
    while (end < text.length && end - from < max && digit.test(text[end])) end += 1;
    if (end === from) return null;
    const point = Number.parseInt(text.slice(from, end), radix);
    if (point > 0x10ffff) return { value: text.slice(at, end), end, unsure: true };
    const byteEscape = (letter === 'x' || letter === '') && point > 0x7f;
    return { value: String.fromCodePoint(point), end, unsure: byteEscape };
  }
  return null;
}


function ansiEscape(text, at) {
  const numeric = ansiNumeric(text, at);
  if (numeric) return numeric;
  const next = text[at + 1];
  if (next === 'c' && text[at + 2] !== undefined) return { value: String.fromCodePoint(text[at + 2].toUpperCase().codePointAt(0) ^ 0x40), end: at + 3 };
  return { value: Object.hasOwn(ANSI_ESCAPES, next) ? ANSI_ESCAPES[next] : `\\${next}`, end: at + 2 };
}



function isQuoteOpener(text, at) {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes keep their
// escapes for \ " $ and ` and drop a backslash-newline, $'...' decodes the
// ANSI-C escapes.
// What a backslash inside a decoding quote stands for: nothing for a
// dropped backslash-newline, an ANSI-C escape in $'...', one of \ " $ ` in
// double quotes; null when the backslash is literal there.
function decodedEscape(text, at, ansi) {
  const next = text[at + 1];
  if (next === undefined) return null;
  if (next === '\n') return { value: '', end: at + 2 };
  if (ansi) return ansiEscape(text, at);
  return '"\\$`'.includes(next) ? { value: next, end: at + 2 } : null;
}

function readQuoted(text, start) {
  const ansi = text[start] === '$';
  const quote = ansi ? text[start + 1] : text[start];
  const decodes = quote === '"' || ansi;
  let value = '';
  let i = start + (ansi ? 2 : 1);
  let unsure = false;
  while (i < text.length && text[i] !== quote) {
    const escaped = text[i] === '\\' && decodes ? decodedEscape(text, i, quote === "'") : null;
    value += escaped ? escaped.value : text[i];
    unsure = unsure || Boolean(escaped?.unsure);
    i = escaped ? escaped.end : i + 1;
  }
  return { value, unsure, end: Math.min(i + 1, text.length) };
}



// One shell word as the shell would see it: a backslash-newline is a
// continuation, a backslash outside quotes escapes the next character (on
// Windows it is a path separator instead). `code` masks every literal
// character, so an unquoted wildcard (which the shell would expand) is told
// apart from a quoted one.
function readShellWord(text, start) {
  let value = '';
  let code = '';
  let unsure = false;
  let i = start;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (isQuoteOpener(text, i)) {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      code += LITERAL.repeat(quoted.value.length);
      unsure = unsure || quoted.unsure;
      i = quoted.end;

    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      code += LITERAL;
      i += 2;
    } else if (/\s/.test(ch)) {
      break;
    } else {
      value += ch;
      code += ch;
      i += 1;
    }
  }
  return { value, globbed: /[*?[]/.test(code), unsure, end: i };

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

// Wrappers that end up running the interpreter read their options through
// the same tables and rules as the validator (scripts/lib/wrapper-options.js).
// What only this hook needs is here: the options that move the directory a
// wrapped script is resolved against, and `builtin`, which the validator
// does not unwrap.
const CHDIR_FLAGS = { sudo: new Set(['-D', '--chdir']), env: new Set(['-C', '--chdir']), 'systemd-run': new Set(['--working-directory']) };
const CHROOT_FLAGS = { sudo: new Set(['-R', '--chroot']) };
const HOOK_ONLY_WRAPPERS = new Set(['builtin']);
const NO_OPTION = { width: 1, valueName: null, value: undefined };

function isWrapper(name) {
  return Object.hasOwn(WRAPPER_SPECS, name) || HOOK_ONLY_WRAPPERS.has(name);
}

// A chdir or chroot option moves where the operands are resolved; a
// directory spelled with byte escapes cannot be resolved faithfully.
function noteWrapperMove(name, option, valueWord, state) {
  if (option.value === undefined || option.valueName === null) return;
  if (CHDIR_FLAGS[name]?.has(option.valueName)) state.cwd = option.value;
  else if (CHROOT_FLAGS[name]?.has(option.valueName)) state.chroot = option.value;
  else return;
  state.unsure = state.unsure || Boolean(valueWord?.unsure);
}

// Skips a wrapper's options and leading positionals; a chdir option's value
// becomes the directory later operands are resolved against.
function skipWrapperOptions(words, start, name, state) {
  let index = start;
  while (index < words.length) {
    const word = words[index].value;
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    const option = readWrapperOption(name, word, words[index + 1]?.value) ?? NO_OPTION;
    noteWrapperMove(name, option, option.width === 2 ? words[index + 1] : words[index], state);
    index += option.width;
  }
  return index + (WRAPPER_SPECS[name]?.leadingPositionals ?? 0);
}

// The index of the first word that is neither an environment assignment
// nor a wrapper with its options; a chdir or chroot a wrapper carries is
// noted on `state` for a caller that resolves operands against it.
function skipEnvAndWrappers(words, state) {
  const wrapperState = state === undefined ? { cwd: null, chroot: null, unsure: false } : state;
  let index = 0;
  while (index < words.length) {
    const word = words[index].value;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index += 1;
      continue;
    }
    const name = word.split(/[\\/]/).pop();
    if (!isWrapper(name)) break;
    index = skipWrapperOptions(words, index + 1, name, wrapperState);
  }
  return index;
}

// The operands of the interpreter in a segment, after env assignments and
// the wrappers above, with the directory they are resolved against. A
// variable-expanded interpreter cannot be resolved, so its operands are
// inspected as if it were a shell. After `--` every word is an operand.
function interpreterOperands(words) {
  const state = { cwd: null, chroot: null, unsure: false };
  const found = (operands) => ({ operands, cwd: state.cwd, chroot: state.chroot, unsure: state.unsure });


  const index = skipEnvAndWrappers(words, state);
  const head = words[index];
  if (!head) return found([]);


  const name = head.value.split(/[\\/]/).pop().toLowerCase();
  if (!head.value.startsWith('$') && !SHELL_INTERPRETERS.has(name)) return found([]);


  const operands = [];
  let literal = false;
  for (const word of words.slice(index + 1)) {
    if (!literal && word.value === '--') {
      literal = true;
    } else if (literal || !word.value.startsWith('-')) {
      operands.push(word);
    }
  }
  return found(operands);
}



// Where a script operand is resolved: inside a chroot the absolute path is
// relative to the new root and a relative one starts at that root (or the
// chdir inside it); otherwise at the chdir or the current directory.
function operandBases(found, here) {
  const root = found.chroot ? path.resolve(here, found.chroot) : null;
  if (root) return { root, base: found.cwd ? path.join(root, found.cwd) : root };
  return { root, base: found.cwd ? path.resolve(here, found.cwd) : here };
}

// The file an operand names, or null when the name leaves the chroot.
function operandPath(name, root, base) {
  const candidate = root && path.isAbsolute(name) ? path.join(root, name) : path.resolve(base, name);
  if (!root) return candidate;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(prefix) ? candidate : null;
}

// Existing files among the operands, resolved against the cwd; a file that
// exists but cannot be read within the budget is reported so the caller
// fails closed instead of skipping it.
function scriptOperandsOf(segment, cwd) {
  const files = [];
  const found = interpreterOperands(shellWords(segment));
  const { root, base } = operandBases(found, cwd || process.cwd());
  const outcome = (blocked) => ({ files, blocked, base });
  if (found.unsure) return outcome('a wrapper path uses byte escapes that cannot be resolved faithfully');
  for (const operand of found.operands) {
    // The shell expands an unquoted wildcard to whatever matches at run time;
    // the literal name is not the file that runs.
    if (operand.globbed) return outcome(`wildcard operand ${operand.value} cannot be inspected before the shell expands it`);
    if (operand.unsure) return outcome(`operand ${operand.value} uses byte escapes that cannot be resolved faithfully`);
    const candidate = operandPath(operand.value, root, base);
    if (candidate === null) return outcome(`operand ${operand.value} leaves the chroot`);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCRIPT_BYTES) return outcome(`script ${operand.value} is too large to analyze`);
    files.push(candidate);
  }
  return outcome(null);
}

// The segments of one script file: its real path is remembered so a script
// that runs itself (or is reached twice) is read once; `blocked` names the
// reason when it cannot be inspected, `segments` is null when it was seen.
function nestedSegmentsOf(file, depth, seen) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { blocked: `script ${file} cannot be read` };
  }
  if (seen.has(real)) return { segments: null };
  seen.add(real);
  if (depth >= MAX_SCRIPT_DEPTH) return { blocked: `scripts nest deeper than ${MAX_SCRIPT_DEPTH} levels` };
  let nested;
  try {
    nested = extractSegments(fs.readFileSync(file, 'utf8'));
  } catch {
    return { blocked: `script ${file} cannot be read` };
  }
  if (nested === null) {
    return { blocked: 'a script it runs nests command/process substitutions deeper than this validator can safely unwrap and analyze' };
  }
  return { segments: nested };
}

// Segments of every script the command runs, following scripts that run
// scripts; `blocked` names the reason when one of them cannot be inspected.
function scriptSegmentsOf(segments, cwd, depth = 0, seen = new Set()) {
  const collected = [];
  for (const segment of segments) {
    const operands = scriptOperandsOf(segment, cwd);
    if (operands.blocked) return { segments: collected, blocked: operands.blocked };
    for (const file of operands.files) {
      const nested = nestedSegmentsOf(file, depth, seen);
      if (nested.blocked) return { segments: collected, blocked: nested.blocked };
      if (nested.segments === null) continue;
      collected.push(...nested.segments);
      // A script the wrapper moved into a directory runs its own children there.
      const inner = scriptSegmentsOf(nested.segments, operands.base, depth + 1, seen);
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
// A backslash-newline continues the line where the shell reads it that way:
// outside single quotes; inside them it is two literal characters.
// The length of a backslash-newline pair at `at` (2, or 3 with a carriage
// return), 0 when the backslash starts something else.
function continuationLength(text, at) {
  if (text[at + 1] === '\n') return 2;
  return text[at + 1] === '\r' && text[at + 2] === '\n' ? 3 : 0;
}

function joinContinuations(text) {
  let out = '';
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && !single) {
      // A continuation is dropped; any other escape is kept with its character.
      const skip = continuationLength(text, i);
      if (skip === 0) out += text.slice(i, i + 2);
      i += skip === 0 ? 1 : skip - 1;
      continue;
    }
    if (ch === '"' && !single) double = !double;
    else if (ch === "'" && !double) single = !single;
    out += ch;
  }
  return out;
}



// A heredoc body is stdin data for the command, not words the shell hands it:
// a commit message, a log line or a document that happens to name a protected
// path or a flag is not an argument, and reading it as one blocked the whole
// command, the parts before it included. The exception is an interpreter
// reading its script from the heredoc, where the body is code and keeps the
// analysis it already had.
// A delimiter is any word the shell can quote, not only an identifier:
// EOF-1 and v1.0 are as valid as EOF.
const HEREDOC_OPERATOR_RE = /(^|[^<])<<(?!<)-?\s*(['"]?)[^\s'"<>|&;()]+\2/;

// A segment split at its heredoc: `command` is the line the shell runs and
// `body` is the data it reads on stdin, or null when there is no heredoc.
function splitHeredoc(segment) {
  const newline = segment.indexOf('\n');
  if (newline === -1) return { command: segment, body: null };
  const firstLine = segment.slice(0, newline);
  if (!HEREDOC_OPERATOR_RE.test(firstLine)) return { command: segment, body: null };
  return { command: firstLine, body: segment.slice(newline + 1) };
}

// Whether the command of a line is a shell reading its input as code, after
// the same environment assignments and wrappers the interpreter-operand scan
// peels: `sudo bash <<EOF` reads the body exactly as `bash <<EOF` does.
function readsItsInputAsCode(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  const head = words[index];
  if (!head) return false;
  const isShell = head.value.startsWith('$') || SHELL_INTERPRETERS.has(head.value.split(/[\\/]/).pop().toLowerCase());
  if (!isShell) return false;
  // A file operand names the script the shell will run, and its standard
  // input is then that script's data. Anything else keeps the body as code:
  // -c does not make it data, because the script it carries can read standard
  // input and execute it (`bash -c 'sh' <<EOF`), which is exactly the shape
  // worth hiding a destructive command in.
  const rest = words.slice(index + 1).map(word => word.value);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    // A redirection is not a script operand; a bare one takes the next word.
    if (/^\d*[<>]/.test(value) || value.startsWith('&>')) {
      if (/^\d*[<>]+$/.test(value)) i += 1;
      continue;
    }
    if (value === '--') {
      return rest.slice(i + 1).every(word => /^\d*[<>]/.test(word) || word.startsWith('&>'));
    }
    if (!value.startsWith('-')) return false;
    // -c takes the script it carries as the next word, and -o an option name:
    // neither is the script file that would make the heredoc data.
    if (/^-[a-zA-Z]*c$/.test(value) || value === '--command' || value === '-o' || value === '+o') i += 1;
  }
  return true;
}

// `egc run --shell` joins the words after its options and hands them to a
// shell, so a whole script can arrive as one quoted token. The validator
// judges that token as one command and calls its metacharacters advisory,
// which is exactly where a compound script would hide a refused command.
// The script is read as the command line it is: its segments are extracted
// and validated like the body of a heredoc a shell reads.
// `egc run --shell` joins the words after its one option and hands them to a
// shell, so a whole script can arrive as one quoted token. The validator
// judges that token as one command and calls its metacharacters advisory,
// which is exactly where a compound script would hide a refused command.
// The script is read as the command line it is, heredocs included: its
// segments are extracted and validated like the body of a heredoc a shell
// reads. `egc run` reads a single option, and only as its first argument
// (scripts/crush-run.js), so `--shell` first and then the script, whatever
// it starts with.
function egcShellScriptOf(segment) {
  const words = shellWords(segment);
  const index = skipEnvAndWrappers(words);
  if (words[index]?.value.split(/[\\/]/).pop() !== 'egc') return null;
  if (words[index + 1]?.value !== 'run' || words[index + 2]?.value !== '--shell') return null;
  const script = words.slice(index + 3);
  if (script.length === 0) return null;
  // The rewrite hook hands the whole script as one quoted word, which keeps
  // its line breaks; typed as bare words, the text after --shell is the
  // script, a heredoc fed to it included. Neither loses what the shell reads.
  if (script.length === 1) return script[0].value;
  return segment.slice(words[index + 2].end).replace(/^\s+/, '');
}

// `own` followed by the segments of `script`, read one level deeper; null
// when the depth cap is reached or the deeper analysis cannot continue.
function withNested(own, script, depth) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return null;
  const inner = extractSegments(script, depth + 1);
  if (inner === null) return null;
  return [...own, ...inner];
}

// The segments one pipeline stage contributes: the stage itself and, when
// it hands a script to a shell, the segments of that script.
function segmentsOfStage(raw, depth) {
  // A script handed to `egc run --shell` runs in a shell of its own, so
  // it is read whole and its segments are judged like the body of a
  // heredoc a shell reads.
  const script = egcShellScriptOf(raw);
  if (script !== null) {
    const whole = raw.trim();
    return withNested(whole ? [whole] : [], script, depth);
  }
  const { command: line, body } = splitHeredoc(raw);
  const trimmed = line.trim();
  const own = trimmed ? [trimmed] : [];
  // The body is stdin data, except when a shell is the one reading it:
  // there it is a script, and it is judged like any other script.
  if (body === null || !readsItsInputAsCode(line)) return own;
  return withNested(own, body, depth);
}

function extractSegments(rawCommand, depth = 0) {

  const command = joinContinuations(String(rawCommand));

  const bodies = extractSubstitutionBodies(command);
  // There is at least one more level of substitution here that recursing
  // would need to unwrap, and depth is already at the cap: analysis cannot
  // continue safely. Return null rather than the partial topLevel result so
  // the caller blocks instead of silently accepting an unanalyzed command.
  if (bodies.length > 0 && depth >= MAX_SUBSTITUTION_DEPTH) return null;

  const segments = [];
  for (const raw of splitShellSegments(command, { splitOnPipe: true })) {
    const stage = segmentsOfStage(raw, depth);
    if (stage === null) return null;
    segments.push(...stage);
  }

  for (const body of bodies) {
    const nested = extractSegments(body, depth + 1);
    if (nested === null) return null;
    segments.push(...nested);
  }

  return segments;
}

// A validator that knows the field says so itself; the marker scan only
// serves a verdict from an older build, which has no such field.
function isAdvisory(verdict) {
  if (typeof verdict.advisory === 'boolean') return verdict.advisory;
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

// The hook's answer when an installed validator gave no verdict: the
// command does not run, and the one line says what happened, that nothing
// ran, and what to do. A validator that is not installed at all is the
// other case, handled in run(), so a machine without the build stays
// usable.
// A verdict says whether its segment is allowed; anything else in the list
// is no answer for that segment.
function isVerdict(entry) {
  return entry !== null && typeof entry === 'object' && typeof entry.allowed === 'boolean';
}

function reasonWithoutVerdict(failure) {
  switch (failure.kind) {
    case 'timeout':
      return `the validator did not answer within ${VALIDATE_TIMEOUT_MS / 1000} seconds`;
    case 'unstartable':
      return `the validator could not be started (${failure.detail})`;
    case 'crash':
      return `the validator stopped with ${failure.detail}`;
    case 'unreadable':
      return `the validator answered ${failure.detail}, which this hook could not read`;
    default:
      return 'the validator gave no verdict';
  }
}

function withoutVerdict(failure) {
  return {
    exitCode: 2,
    stderr: `EGC Guardian could not validate this command, so it did not run: ${reasonWithoutVerdict(failure)}. Nothing was executed. Run the command again; on a slow machine, set EGC_GUARDIAN_TIMEOUT_MS to a larger budget in milliseconds (${VALIDATE_TIMEOUT_MS} now). If this keeps happening, run 'egc doctor' to check the Guardian build, and set EGC_DISABLED_HOOKS=pre:bash:guardian-validate to lift this gate while you repair it.`,
  };
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
  const answer = callGuardianVerdict(
    cli,
    ['command-batch'],
    JSON.stringify({ commands: segments, cwd }),
    VALIDATE_TIMEOUT_MS,
  );
  if (!answer.ok) return withoutVerdict(answer);
  const verdicts = answer.value;
  if (!Array.isArray(verdicts)) {
    return withoutVerdict({ kind: 'unreadable', detail: 'something that is not a list of verdicts' });
  }
  // One verdict per segment, in order: a shorter list would leave the
  // segments past its end unjudged, and a longer one belongs to another
  // command.
  if (verdicts.length !== segments.length) {
    return withoutVerdict({ kind: 'unreadable', detail: 'an incomplete list of verdicts' });
  }
  if (!verdicts.every(isVerdict)) {
    return withoutVerdict({ kind: 'unreadable', detail: 'a list with an entry that is not a verdict' });
  }
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
