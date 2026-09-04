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

// Wrappers that end up running the interpreter, mirrored from the
// validator's wrapper table: the options of each that take a value, the
// leading positional operands some take (timeout's duration, flock's file),
// and the options that change the working directory the script is resolved
// against.
function spec(valueFlags, extra = {}) {
  return { valueFlags: new Set(valueFlags), positionals: 0, chdirFlags: new Set(), chrootFlags: new Set(), ...extra };

}

const WRAPPER_SPECS = {
  sudo: spec(['-u', '--user', '-g', '--group', '-p', '--prompt', '-h', '--host', '-C', '--close-from', '-r', '--role', '-t', '--type', '-D', '--chdir', '-R', '--chroot', '-U', '-T'], { chdirFlags: new Set(['-D', '--chdir']), chrootFlags: new Set(['-R', '--chroot']) }),


  doas: spec(['-u', '-C']),
  env: spec(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], { chdirFlags: new Set(['-C', '--chdir']) }),
  nohup: spec([]),
  time: spec(['-o', '--output', '-f', '--format']),
  command: spec([]),
  exec: spec(['-a']),
  builtin: spec([]),
  nice: spec(['-n', '--adjustment']),
  ionice: spec(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid']),
  timeout: spec(['-s', '--signal', '-k', '--kill-after'], { positionals: 1 }),
  stdbuf: spec(['-i', '--input', '-o', '--output', '-e', '--error']),
  xargs: spec(['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '-i', '--replace', '-L', '-l', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']),
  flock: spec(['-w', '--timeout', '-E', '--conflict-exit-code'], { positionals: 1 }),
  watch: spec(['-n', '--interval']),
  strace: spec(['-e', '-o', '--output', '-s', '-p', '-P', '-b', '-U']),
  parallel: spec(['-j', '--jobs', '-N', '--delay', '--retries', '--timeout', '--joblog', '--results', '-S', '--sshlogin']),
  'systemd-run': spec(['-p', '--property', '-u', '--unit', '-E', '--setenv', '-d', '--description', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--timer-property', '--working-directory', '--uid', '--gid', '--nice', '-M', '--machine', '-H', '--host', '--slice', '--service-type'], { chdirFlags: new Set(['--working-directory']) }),
};

// Skips a wrapper's options and leading positionals; a chdir option's value
// becomes the directory later operands are resolved against.
// One wrapper option as typed: --name=value, -Xvalue (the short option with
// its value attached) or the value in the next word.
function wrapperOption(word, wrapper, nextWord) {
  const attached = !word.startsWith('--') && word.length > 2 && wrapper.valueFlags.has(word.slice(0, 2));
  if (attached) return { name: word.slice(0, 2), value: word.slice(2), takesNext: false };
  const equal = word.indexOf('=');
  if (equal !== -1) return { name: word.slice(0, equal), value: word.slice(equal + 1), takesNext: false };

  const takesNext = wrapper.valueFlags.has(word);
  return { name: word, value: takesNext ? nextWord : undefined, takesNext };
}

function skipWrapperOptions(words, start, wrapper, state) {
  let index = start;
  while (index < words.length) {
    const word = words[index].value;
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    const option = wrapperOption(word, wrapper, words[index + 1]?.value);
    if (wrapper.chdirFlags.has(option.name) && option.value !== undefined) state.cwd = option.value;
    if (wrapper.chrootFlags.has(option.name) && option.value !== undefined) state.chroot = option.value;

    index += option.takesNext ? 2 : 1;

  }
  return index + wrapper.positionals;
}

// The operands of the interpreter in a segment, after env assignments and
// the wrappers above, with the directory they are resolved against. A
// variable-expanded interpreter cannot be resolved, so its operands are
// inspected as if it were a shell. After `--` every word is an operand.
function interpreterOperands(words) {
  const state = { cwd: null, chroot: null };

  let index = 0;
  while (index < words.length) {
    const word = words[index].value;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index += 1;
      continue;
    }
    const wrapper = WRAPPER_SPECS[word.split(/[\\/]/).pop()];
    if (!wrapper) break;
    index = skipWrapperOptions(words, index + 1, wrapper, state);
  }
  const head = words[index];
  if (!head) return { operands: [], cwd: state.cwd, chroot: state.chroot };

  const name = head.value.split(/[\\/]/).pop().toLowerCase();
  if (!head.value.startsWith('$') && !SHELL_INTERPRETERS.has(name)) return { operands: [], cwd: state.cwd, chroot: state.chroot };

  const operands = [];
  let literal = false;
  for (const word of words.slice(index + 1)) {
    if (!literal && word.value === '--') {
      literal = true;
    } else if (literal || !word.value.startsWith('-')) {
      operands.push(word);
    }
  }
  return { operands, cwd: state.cwd, chroot: state.chroot };
}


// Existing files among the operands, resolved against the cwd; a file that
// exists but cannot be read within the budget is reported so the caller
// fails closed instead of skipping it.
function scriptOperandsOf(segment, cwd) {
  const files = [];
  const found = interpreterOperands(shellWords(segment));
  const here = cwd || process.cwd();
  // Inside a chroot the script's absolute path is relative to the new root,
  // and relative paths start at that root unless a chdir option says where.
  const root = found.chroot ? path.resolve(here, found.chroot) : null;
  let base = found.cwd ? path.resolve(here, found.cwd) : here;
  if (root) base = found.cwd ? path.join(root, found.cwd) : root;
  const outcome = (blocked) => ({ files, blocked, base });
  for (const operand of found.operands) {
    // The shell expands an unquoted wildcard to whatever matches at run time;
    // the literal name is not the file that runs.
    if (operand.globbed) return outcome(`wildcard operand ${operand.value} cannot be inspected before the shell expands it`);
    if (operand.unsure) return outcome(`operand ${operand.value} uses byte escapes that cannot be resolved faithfully`);
    const candidate = root && path.isAbsolute(operand.value) ? path.join(root, operand.value) : path.resolve(base, operand.value);

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
      // A script the wrapper moved into a directory runs its own children there.
      const inner = scriptSegmentsOf(nested, operands.base, depth + 1, seen);

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
function joinContinuations(text) {
  let out = '';
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!single && ch === '\\' && text[i + 1] === '\n') {
      i += 1;
    } else if (!single && ch === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') {
      i += 2;
    } else if (!single && ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1];
      i += 1;
    } else {
      if (ch === '"' && !single) double = !double;
      if (ch === "'" && !double) single = !single;
      out += ch;
    }
  }
  return out;
}


function extractSegments(rawCommand, depth = 0) {
  const command = joinContinuations(String(rawCommand));

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
