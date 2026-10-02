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
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { resolveGuardianCli, callGuardianVerdict, guardianFailureReason, readHookInput } = require('../lib/guardian-bin');
const { splitShellSegments, extractSubstitutionBodies, constructEnd } = require('../lib/shell-split');
const { WRAPPER_SPECS, SHELL_KEYWORDS, readWrapperOption, runnerCommandStart, commandName } = require('../lib/wrapper-options');
const { stdinReaderOf, producedProgram, isRedirection, takesTarget, isRuntimeOnly, isStdinPath } = require('../lib/stdin-programs');
const { handoffCommandsOf } = require('../lib/handoff-commands');
const { collectBindings, mergeBindings, valuesOf, commandWordChoices, quoteField, singleQuoted } = require('../lib/shell-bindings');
const { startCwd, afterMove, CWD_CHANGERS } = require('../lib/shell-cwd');

// An input cut at the size the hook reads is not the command that runs: what was cut could
// hold the rest of it, so it is refused rather than judged by its start.
const OVER_LIMIT = 'EGC Guardian BLOCKED this command: the hook input is larger than the 1 MiB this validator reads, so the command was not validated. Split it into smaller commands.';
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
// Shell options whose value is the next word, not the script it runs.
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const HOME_PARAMETER_RE = /^\$(?:HOME|\{HOME\})(?=[\\/]|$)/;
const SHELL_VARIABLES = new Set(['$BASH', '${BASH}', '$SHELL', '${SHELL}', '$0', '${0}']);
// The directory of the script being read, as scripts spell it to reach a
// file beside them: `$(dirname "$0")`, `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)`,
// `${BASH_SOURCE%/*}` and their variants, quotes already removed.
const SCRIPT_PATH_WORDS = ['$0', '${0}', '$BASH_SOURCE', '${BASH_SOURCE}', '${BASH_SOURCE[0]}'];
const SCRIPT_DIRNAMES = SCRIPT_PATH_WORDS.flatMap(word => [`$(dirname ${word})`, `$(dirname -- ${word})`, `\`dirname ${word}\``]);
const SCRIPT_DIR_IDIOMS = [
  ...SCRIPT_DIRNAMES,
  ...SCRIPT_DIRNAMES.flatMap(dir => ['', ' >/dev/null', ' >/dev/null 2>&1', ' 2>/dev/null'].flatMap(quiet => ['pwd', 'pwd -P'].flatMap(pwd => ['cd', 'cd --', 'cd -P'].map(cd => `$(${cd} ${dir}${quiet} && ${pwd})`)))),
  '${0%/*}', '${BASH_SOURCE%/*}', '${BASH_SOURCE[0]%/*}',
].sort((a, b) => b.length - a.length);
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
  let expands = false;
  while (i < text.length && text[i] !== quote) {
    const escaped = text[i] === '\\' && decodes ? decodedEscape(text, i, quote === "'") : null;
    // Double quotes keep $ and ` live: the shell still expands them.
    expands = expands || (!escaped && quote === '"' && (text[i] === '$' || text[i] === '`'));
    value += escaped ? escaped.value : text[i];
    unsure = unsure || Boolean(escaped?.unsure);
    i = escaped ? escaped.end : i + 1;
  }
  return { value, unsure, expands, end: Math.min(i + 1, text.length) };
}



// One shell word as the shell would see it: a backslash-newline is a
// continuation, a backslash outside quotes escapes the next character (on
// Windows it is a path separator instead). `code` masks every literal
// character, so an unquoted wildcard (which the shell would expand) is told
// apart from a quoted one.
// `(` and `)` outside quotes are shell operators, not word characters: a
// subshell `(bash x.sh)` opens and closes around the words it runs. They
// belong to a word only as a substitution or pattern opened after one of
// these characters ($(...), <(...), @(...)), as the `()` of a function
// name, or nested inside such a run, where the matching `)` closes them.
const PAREN_RUN_OPENERS = '$<>@!+?*';

// How a `(` or `)` at `i` is read into `word`: null when it ends the word
// (an operator), otherwise the text it adds and where reading goes on.
function parenStep(text, i, word) {
  if (text[i] === ')') {
    if (word.depth === 0) return null;
    word.depth -= 1;
    return { text: ')', end: i + 1 };
  }
  const before = text[i - 1] ?? '';
  if (word.depth === 0 && !PAREN_RUN_OPENERS.includes(before)) {
    if (text[i + 1] !== ')' || word.value === '') return null;
    return { text: '()', end: i + 2 };
  }
  // <(...) and >(...) stand for a path the shell makes when it runs.
  word.expands = word.expands || (word.depth === 0 && '<>'.includes(before));
  word.depth += 1;
  return { text: '(', end: i + 1 };
}

function readShellWord(text, start) {
  const word = { value: '', code: '', unsure: false, expands: false, bare: false, depth: 0 };
  let i = start;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === ')') {
      const step = parenStep(text, i, word);
      if (step === null) break;
      word.value += step.text;
      word.code += step.text;
      i = step.end;
    } else if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (isQuoteOpener(text, i)) {
      const quoted = readQuoted(text, i);
      word.value += quoted.value;
      word.code += LITERAL.repeat(quoted.value.length);
      word.unsure = word.unsure || quoted.unsure;
      word.expands = word.expands || quoted.expands;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      word.value += text[i + 1];
      word.code += LITERAL;
      i += 2;
    } else if (/\s/.test(ch) && word.depth === 0) {
      break;
    } else {
      word.expands = word.expands || ch === '$' || ch === '`';
      word.bare = word.bare || ch === '$' || ch === '`';
      word.value += ch;
      word.code += ch;
      i += 1;
    }
  }
  // `tilde`: an unquoted ~ that the shell turns into a home directory.
  // `bare`: an expansion outside quotes, whose value the shell splits.
  // `redirect`: a redirection the shell performs, not a quoted word that
  // only reads like one. `braced`: an unquoted brace the shell may expand.
  return {
    value: word.value, globbed: /[*?[]/.test(word.code), unsure: word.unsure, expands: word.expands, bare: word.bare, tilde: word.code.startsWith('~'),
    redirect: isRedirection(word.code), braced: /[{}]/.test(word.code), start, end: i,
  };
}

function shellWords(segment) {
  const words = [];
  let i = 0;
  while (i < segment.length) {
    if (/\s/.test(segment[i])) {
      i += 1;
      continue;
    }
    if (segment[i] === '(' || segment[i] === ')') {
      words.push({ value: segment[i], globbed: false, unsure: false, end: i + 1 });
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
// What only this hook needs is here: the options that move the directory or
// the root a wrapped script is resolved against, the wrappers whose view of
// the filesystem it cannot follow, and `builtin`, which the validator does
// not unwrap.
const CHDIR_FLAGS = {
  sudo: new Set(['-D', '--chdir']),
  env: new Set(['-C', '--chdir']),
  'systemd-run': new Set(['--working-directory']),
  unshare: new Set(['-w', '--wd']),
  nsenter: new Set(['-w', '--wd']),
};
const CHROOT_FLAGS = { sudo: new Set(['-R', '--chroot']), unshare: new Set(['-R', '--root']), nsenter: new Set(['-r', '--root']) };
// chroot, sudo -R, unshare -R and nsenter -r start the command at the new
// root's `/` unless a directory is given with them (checked in their
// sources: sudo's exec.c chroots, changes to `/` and only then to -D).
const ROOT_STARTS_AT_TOP = new Set(['chroot', 'sudo', 'unshare', 'nsenter']);
// sudo -i runs the command from the target user's home directory unless -D
// names one (sudoers policy.c).
const SUDO_LOGIN_FLAGS = new Set(['-i', '--login']);
const NSENTER_TARGET_VIEW = new Set(['-m', '--mount', '-a', '--all']);
const NSENTER_OPTIONAL_MOVES = new Set(['-r', '--root', '-w', '--wd']);
const BWRAP_VIEW = 'bwrap runs the script in a filesystem of its own mounts, which cannot be resolved faithfully';
const NSENTER_VIEW = "nsenter runs the script in the target process's mount namespace, root or directory, which cannot be resolved faithfully";
const SUDO_LOGIN_VIEW = "sudo -i runs the script from the target user's home directory, which cannot be resolved faithfully for a relative path";
const HOOK_ONLY_WRAPPERS = new Set(['builtin']);
const NO_OPTION = { width: 1, valueName: null, value: undefined };

function isWrapper(name) {
  return Object.hasOwn(WRAPPER_SPECS, name) || HOOK_ONLY_WRAPPERS.has(name);
}

// The option an option word sets and its value: a long option with an
// optional value (nsenter --wd=dir) carries it after `=`.
function optionMove(option, word) {
  if (option.valueName !== null && option.valueName !== undefined) return { flag: option.valueName, value: option.value };
  const eq = word.indexOf('=');
  return { flag: option.names?.at(-1), value: word.startsWith('--') && eq > 0 ? word.slice(eq + 1) : undefined };
}

// A chdir or chroot option moves where the operands are resolved; a
// directory spelled with byte escapes cannot be resolved faithfully, and
// neither can the target's own view that nsenter enters.
function noteWrapperMove(name, move, valueWord, moves, state) {
  if (move.flag === undefined) return;
  if (name === 'nsenter' && (NSENTER_TARGET_VIEW.has(move.flag) || (NSENTER_OPTIONAL_MOVES.has(move.flag) && move.value === undefined))) {
    state.unresolved = NSENTER_VIEW;
    return;
  }
  if (move.value === undefined) return;
  if (CHDIR_FLAGS[name]?.has(move.flag)) moves.dir = move.value;
  else if (CHROOT_FLAGS[name]?.has(move.flag)) moves.root = move.value;
  else return;
  moves.unsure = moves.unsure || Boolean(valueWord?.unsure);
}

// A path the wrapper was given, read from the view it runs in: relative to
// the directory an outer wrapper moved to, or to the top of its root.
function within(value, state) {
  if (path.isAbsolute(value)) return value;
  const top = state.chroot ? '/' : '';
  return path.join(state.cwd ?? top, value);
}

// A wrapper's new root is read from the view before it; chroot, unshare -R
// and nsenter -r start at the new root's top, and a directory given with it
// is inside it.
// A new root's top or an absolute directory is known again, whatever came
// before; sudo -i then moves to the target user's home, which is not.
function applyMoves(name, moves, state) {
  if (moves.root !== undefined) {
    const inside = within(moves.root, state);
    state.chroot = state.chroot ? path.join(state.chroot, inside) : inside;
    if (ROOT_STARTS_AT_TOP.has(name)) {
      state.cwd = null;
      state.cwdUnknown = null;
    }
  }
  if (moves.dir !== undefined) {
    state.cwd = within(moves.dir, state);
    if (path.isAbsolute(state.cwd)) state.cwdUnknown = null;
  }
  if (name === 'sudo' && moves.login && moves.dir === undefined) state.cwdUnknown = SUDO_LOGIN_VIEW;
  state.unsure = state.unsure || moves.unsure;
}

// The leading positionals a wrapper takes before its command; chroot's is
// its new root, and chroot takes --skip-chdir only when that root is the
// current `/`, which moves nothing.
function skipLeadingPositionals(words, index, name, moves) {
  const spec = WRAPPER_SPECS[name];
  let skip = spec?.leadingPositionals ?? 0;
  let at = index;
  while (skip > 0 && at < words.length && (!spec.positionalWhen || spec.positionalWhen.test(words[at].value))) {
    if (name === 'chroot' && !moves.skipChdir) {
      moves.root = words[at].value;
      moves.unsure = moves.unsure || Boolean(words[at].unsure);
    }
    at += 1;
    skip -= 1;
  }
  return at;
}

// Skips a wrapper's options and leading positionals; the directory and root
// they move to become where later operands are resolved.
const COMMAND_LOOKUP_FLAGS = new Set(['-v', '-V']);

// Where a wrapper's options end at the word at `index`: past a `--`, at a
// word that is no option, and at a lone `-` (past it where the wrapper reads
// it as an option, as env does); -1 while the options go on.
function optionsEndAt(word, index, name) {
  if (word === '--') return index + 1;
  if (!word.startsWith('-')) return index;
  if (word === '-') return WRAPPER_SPECS[name]?.loneDashIsOption ? index + 1 : index;
  return -1;
}

// command -v and -V only say what each name would run: the words after
// them are names, and nothing runs.
function runsNothing(name, option) {
  return name === 'command' && Boolean(option.names?.some(flag => COMMAND_LOOKUP_FLAGS.has(flag)));
}

// What one wrapper option at `index` tells about where the command runs.
function noteWrapperOption(name, option, words, index, moves, state) {
  moves.skipChdir = moves.skipChdir || Boolean(option.names?.includes('--skip-chdir'));
  moves.login = moves.login || Boolean(option.names?.some(flag => SUDO_LOGIN_FLAGS.has(flag)));
  noteWrapperMove(name, optionMove(option, words[index].value), option.width === 2 ? words[index + 1] : words[index], moves, state);
}

function skipWrapperOptions(words, start, name, state) {
  const moves = { root: undefined, dir: undefined, unsure: false, skipChdir: false, login: false };
  if (name === 'bwrap') state.unresolved = BWRAP_VIEW;
  let index = start;
  while (index < words.length) {
    const end = optionsEndAt(words[index].value, index, name);
    if (end >= 0) {
      index = end;
      break;
    }
    const option = readWrapperOption(name, words[index].value, words[index + 1]?.value) ?? NO_OPTION;
    if (runsNothing(name, option)) return words.length;
    noteWrapperOption(name, option, words, index, moves, state);
    index += option.width;
  }
  index = skipLeadingPositionals(words, index, name, moves);
  applyMoves(name, moves, state);
  return index;
}

// The egc subcommands that run the command after their options, as the
// validator unwraps them; `egc run --shell` hands a whole script to a shell
// and is read by egcShellScriptOf instead.
const EGC_EXECUTOR_SUBCOMMANDS = new Set(['run', 'verify']);

function skipEgcExecutor(words, index) {
  let i = index + 1;
  while (i < words.length && words[i].value.startsWith('-')) i += 1;
  if (!EGC_EXECUTOR_SUBCOMMANDS.has(words[i]?.value)) return index;
  i += 1;
  while (i < words.length && words[i].value.startsWith('-')) {
    if (words[i].value === '--shell') return index;
    i += 1;
  }
  return i;
}

// `case word in pattern) command`: the command starts after the pattern.
function skipCaseClause(words, index) {
  const at = words.findIndex((word, i) => i > index && word.value === 'in');
  let i = at === -1 ? index + 1 : at + 1;
  if (words[i]?.value === '(') i += 1;
  return words[i + 1]?.value === ')' ? i + 2 : words.length;
}

// The index past a shell keyword or grouping opener, a case arm, a
// coprocess, function header or egc executor in front of the command
// actually run, as the validator peels them (validator.ts
// tryUnwrapShellKeyword); the same index when there is none.
function skipCommandCarrier(words, index) {
  const head = words[index].value;
  if (SHELL_KEYWORDS.has(head)) return index + 1;
  if (head === 'case') return skipCaseClause(words, index);
  if (head === 'coproc') return ['{', '('].includes(words[index + 2]?.value) ? index + 2 : index + 1;
  if (head === 'function') return index + 2;
  if (head.endsWith('()')) return index + 1;
  // A later arm of a case (`b) command`) starts its own segment.
  if (words[index + 1]?.value === ')') return index + 2;
  if (words[index + 1]?.value === '(' && words[index + 2]?.value === ')') return index + 3;
  if (commandName(head) === 'egc') return skipEgcExecutor(words, index);
  return index;
}

// The index of the first word that is neither an environment assignment,
// a wrapper with its options, nor a keyword or construct that carries the
// command; a chdir or chroot a wrapper carries is noted on `state` for a
// caller that resolves operands against it.
function skipEnvAndWrappers(words, state) {
  const wrapperState = state === undefined ? { cwd: null, chroot: null, unsure: false, unresolved: null, cwdUnknown: null } : state;
  let index = 0;
  while (index < words.length) {
    const word = words[index].value;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index += 1;
      continue;
    }
    const name = commandName(word);
    if (isWrapper(name)) {
      index = skipWrapperOptions(words, index + 1, name, wrapperState);
      continue;
    }
    const runner = runnerCommandStart(words.slice(index).map(each => each.value));
    if (runner !== null && runner.start > 0 && index + runner.start < words.length) {
      index += runner.start;
      continue;
    }
    const next = skipCommandCarrier(words, index);
    if (next === index) break;
    index = next;
  }
  return index;
}

// The operands of the interpreter in a segment, after env assignments and
// the wrappers above, with the directory they are resolved against. A
// variable-expanded interpreter cannot be resolved, so its operands are
// inspected as if it were a shell. After `--` every word is an operand.
function interpreterOperands(words, cwdUnknown = null) {
  const state = { cwd: null, chroot: null, unsure: false, unresolved: null, cwdUnknown };
  const found = (operands, sources = false) => ({ operands, sources, cwd: state.cwd, chroot: state.chroot, unsure: state.unsure, unresolved: state.unresolved, cwdUnknown: state.cwdUnknown });


  const index = skipEnvAndWrappers(words, state);
  const head = words[index];
  if (!head) return found([]);


  const name = commandName(head.value);
  // A command whose name is a variable is only treated as an interpreter when
  // that variable names the shell itself ($BASH, $SHELL, $0). Any other
  // `$VAR` command (a resolvable one is already rewritten before this runs, so
  // what remains is the environment's, like $EDITOR) is not an interpreter, so
  // its operands are its own arguments, not a script to read.
  const isShellVar = head.value.startsWith('$') && SHELL_VARIABLES.has(head.value);
  // Any other command named by a path (./x.sh, /opt/x, dir/x) runs that file
  // itself; readOperand reads it like `bash file` when it is a shell script.
  // One the line has not made yet (a build's output) need not be there.
  const direct = !isShellVar && !SHELL_INTERPRETERS.has(name);
  if (direct && /[\\/]/.test(head.value)) return found([{ ...head, script: true, direct: true, optional: true, args: scriptArguments(words.slice(index + 1)) }]);
  if (direct) return found([]);

  const shell = !head.value.startsWith('$') || isShellVar;
  return found(interpreterScriptOperands(words.slice(index + 1), shell), name === 'source' || name === '.');
}

// A short option bundle (-nx) or --noexec asks the shell to read its script
// without running it; then its commands never execute and need no inspection.
function isNoexecFlag(value) {
  if (value === '--noexec') return true;
  return /^-[a-zA-Z]+$/.test(value) && value.includes('n');
}

// A word consumed as the value of the previous option (bash -o noexec): true
// once it is taken, after noting a noexec that arrived that way.
function consumedAsOptionValue(word, state) {
  if (!state.awaiting) return false;
  if ((state.awaiting === '-o' || state.awaiting === '-O') && word.value === 'noexec') state.noexec = true;
  state.awaiting = null;
  return true;
}

// A short option cluster that carries -c: the shell runs its first operand
// as code rather than a script file.
function isCommandStringFlag(value) {
  return /^-[A-Za-z]+$/.test(value) && value.includes('c');
}

// The operands after the interpreter's options: the first is the script the
// shell reads (unless -n or -o noexec keeps it from running), the rest its
// arguments. Under -c no operand is the script: the first is the code the
// shell runs, read with the command line (inlineShellCodeOf), and the words
// after it are its $0, $1 and on.
function interpreterScriptOperands(words, shell) {
  const operands = [];
  const state = { literal: false, awaiting: null, noexec: false, command: false };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    // A redirection and its target are no operand: `bash < x.sh` reads x.sh
    // as its input, judged with the programs a command reads there.
    if (word.redirect) {
      if (takesTarget(word.value)) i += 1;
      continue;
    }
    if (consumedAsOptionValue(word, state)) continue;
    if (!state.literal && word.value === '--') state.literal = true;
    else if (state.literal || !/^[-+]/.test(word.value)) operands.push(interpreterOperand(words, i, state, shell && operands.length === 0));
    else noteShellOption(word.value, state);
  }
  return operands;
}

// The operand at `i`; the first one, `first`, is the script the shell runs,
// and every word after it is that script's $1 and on.
function interpreterOperand(words, i, state, first) {
  const script = first && !state.noexec && !state.command;
  return { ...words[i], script, noRun: state.noexec, args: script ? scriptArguments(words.slice(i + 1)) : undefined };
}

// The words a script is run with, its $1 and on: those after its name,
// redirections and their targets left out.
function scriptArguments(words) {
  const args = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!words[i].redirect) args.push(words[i]);
    else if (takesTarget(words[i].value)) i += 1;
  }
  return args;
}

// What one of the shell's options tells: -n or --noexec, -c, or an option
// whose value is the next word.
function noteShellOption(value, state) {
  if (isNoexecFlag(value)) state.noexec = true;
  if (isCommandStringFlag(value)) state.command = true;
  state.awaiting = SHELL_VALUE_OPTIONS.has(value) ? value : null;
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
// Errors that mean the operand names no file the shell could run; any other
// (a permission this hook lacks but sudo has, a resource limit) means it
// could not be inspected.
const MISSING_OPERAND_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'EINVAL']);

// The path an operand names once the shell has expanded it: ~ and $HOME
// lead to the home directory; any other expansion (a variable, $(...),
// backticks, ~user) is only known when the command runs, so null.
function expandedOperandValue(operand, homeKnown) {
  if (!homeKnown && (operand.tilde || HOME_PARAMETER_RE.test(operand.value))) return null;
  if (operand.tilde) {
    if (operand.expands || (operand.value !== '~' && !/^~[\\/]/.test(operand.value))) return null;
    return os.homedir() + operand.value.slice(1);
  }
  if (!operand.expands) return operand.value;
  const home = HOME_PARAMETER_RE.exec(operand.value);
  const rest = home ? operand.value.slice(home[0].length) : '';
  return home && !/[$`]/.test(rest) ? os.homedir() + rest : null;
}

// The script file one operand names, the reason it cannot be inspected, or
// null when it names no file.
function inspectOperand(operand, root, base) {
  // The shell expands an unquoted wildcard to whatever matches at run time;
  // the literal name is not the file that runs.
  if (operand.globbed) return { blocked: `wildcard operand ${operand.value} cannot be inspected before the shell expands it` };
  if (operand.unsure) return { blocked: `operand ${operand.value} uses byte escapes that cannot be resolved faithfully` };
  const candidate = operandPath(operand.value, root, base);
  if (candidate === null) return { blocked: `operand ${operand.value} leaves the chroot` };
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    // A path that is not there is not a script the shell runs; one this hook
    // may not look at can still be one a wrapper like sudo runs.
    if (MISSING_OPERAND_CODES.has(error.code)) return null;
    return { blocked: `operand ${operand.value} cannot be inspected (${error.code})` };
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_SCRIPT_BYTES) return { blocked: `script ${operand.value} is too large to analyze`, oversized: candidate };
  return { file: candidate };
}

// A path that is there but is neither a file nor a directory: a pipe, a
// socket or a device, whose bytes are only known when they are read.
function isSpecialFile(file) {
  try {
    const stat = fs.statSync(file);
    return !stat.isFile() && !stat.isDirectory();
  } catch {
    return false;
  }
}

// Commands that can set HOME without an assignment word.
const HOME_CHANGERS = new Set(['unset', 'read', 'printf', 'declare', 'typeset', 'local', 'readonly', 'export', 'mapfile', 'readarray']);

// Whether a segment may set or clear HOME: an assignment to it, a builtin
// that sets it by name, or a name reference that could alias it. The code
// an eval runs is read as segments of its own, and a sourced script is
// read for the same (see scriptSegmentsOf). After such a segment, ~ and
// $HOME no longer name the home directory this hook knows.
function changesHome(segment) {
  const words = shellWords(segment).map(word => word.value);
  if (words.some(word => /^HOME\+?=/.test(word))) return true;
  if (['declare', 'typeset', 'local'].some(word => words.includes(word)) && words.some(word => /^-[A-Za-z]*n/.test(word))) return true;
  return words.includes('HOME') && words.some(word => HOME_CHANGERS.has(word));
}

// Variables a script sets to its own directory, spelled as above.
function scriptDirVariables(segments) {
  const names = new Set();
  for (const segment of segments) {
    for (const word of shellWords(segment)) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.value);
      if (assignment && SCRIPT_DIR_IDIOMS.includes(assignment[2].replaceAll(/\s+/g, ' '))) names.add(assignment[1]);
    }
  }
  return names;
}

// The variables these segments fix (scripts/lib/shell-bindings.js).
function bindingsOfSegments(segments) {
  return collectBindings(segments.map(segment => {
    const words = shellWords(segment);
    return { segment, words, commandIndex: skipEnvAndWrappers(words) };
  }));
}

// Variables the command fixes to literal filenames, and so can be followed to
// the scripts they name, with the value the environment holds, which the
// shell may still use where the line does not fix the variable first (a
// file it names that is not there only fails to run); a variable fixed from
// a source this hook cannot read is left out, so `bash "$VAR"` for it still
// fails closed.
function scriptVarsOf(bindings) {
  const values = new Map();
  for (const [name, entry] of bindings.names) {
    if (entry.opaque || entry.values.size === 0) continue;
    const fixed = [...entry.values].filter(value => value !== '').map(value => ({ value, optional: false }));
    const env = process.env[name];
    const fromEnv = typeof env === 'string' && env !== '' && !entry.values.has(env) ? [{ value: env, optional: true }] : [];
    values.set(name, [...fixed, ...fromEnv]);
  }
  return values;
}

// Each segment whose command word expands is judged as written and once per
// value the word can take (X=rm; $X -rf / is also judged as rm -rf /, and an
// empty $X hands the command to the next word). A word whose value this hook
// cannot read fails closed when `unknownFails`, and is left as it is
// otherwise (a committed script, held only to the grave denials).
const MAX_WORD_ROUNDS = 4;

function commandWordVariants(segment, context, round) {
  const words = shellWords(segment);
  const cmd = words[skipEnvAndWrappers(words)];
  if (!cmd?.expands || cmd.start === undefined) return { segments: [segment] };
  const raw = segment.slice(cmd.start, cmd.end);
  const outcome = commandWordChoices(raw, context.lookup, context.ifsBound, context.positional);
  if (outcome.keep) return { segments: [segment] };
  if (outcome.unknown) {
    return { blocked: `the command name comes from ${raw}, which the command sets from a source this hook cannot read or which only the shell knows when it runs (${outcome.unknown}); run it by its real name, or quote the expansion when only a literal file name follows it` };
  }
  if (round >= MAX_WORD_ROUNDS) return { blocked: `the command name comes from ${raw}, which expands into further expansions than this hook follows; run it by its real name` };
  const variants = [];
  for (const fields of outcome.choices) {
    const variant = (segment.slice(0, cmd.start) + fields.map(quoteField).join(' ') + segment.slice(cmd.end)).trim();
    if (variant === '') continue;
    const next = commandWordVariants(variant, context, round + 1);
    if (next.blocked) return next;
    variants.push(...next.segments);
  }
  return { segments: [...new Set(variants)] };
}

const NESTED_TOO_DEEP = 'a command it runs nests command/process substitutions deeper than this validator can safely unwrap and analyze';

function resolveCommandWords(segments, bindings, unknownFails, positional = null) {
  const context = {
    lookup: name => valuesOf(bindings, name, process.env),
    ifsBound: bindings.ifs,
    positional,
  };
  const resolved = [];
  for (const segment of segments) {
    const outcome = segmentWithVariants(segment, context, unknownFails, 0);
    if (outcome.blocked) return outcome;
    resolved.push(...outcome.segments);
  }
  return { segments: resolved };
}

// A segment with every value its command word takes, and the code each
// resolved one runs through a shell's -c or eval (`S=sh; $S -c '...'` runs
// that code as `sh -c` does), resolved in turn.
function segmentWithVariants(segment, context, unknownFails, depth) {
  const outcome = commandWordVariants(segment, context, 0);
  if (outcome.blocked && unknownFails) return { blocked: outcome.blocked };
  const found = [segment];
  for (const variant of outcome.segments ?? []) {
    if (variant === segment) continue;
    const stage = segmentsOfStage(variant, depth);
    if (stage === null) return { blocked: NESTED_TOO_DEEP };
    found.push(variant);
    for (const code of stage.slice(1)) {
      const inner = segmentWithVariants(code, context, unknownFails, depth + 1);
      if (inner.blocked) return inner;
      found.push(...inner.segments);
    }
  }
  return { segments: [...new Set(found)] };
}

// Code a shell reads only after this line's own shell has expanded it: the
// body of a heredoc with an unquoted delimiter that a shell reads, and the
// code of -c or eval in a word that expands. The value a variable takes
// there is read as code a second time, which one reading of the line misses.
function expandedCodes(text) {
  const codes = [];
  for (const stage of splitShellSegments(joinContinuations(text), { stripComments: true }).flatMap(pipelineStages)) {
    const { command: line, body } = splitHeredoc(stage);
    if (body !== null && readsItsInputAsCode(line) && !literalHeredoc(line, body)) codes.push(body);
    const inline = expandedInlineCode(line);
    if (inline !== null) codes.push(inline);
  }
  return codes;
}

// The code of -c or eval as the line's own shell hands it over, when a word
// of it expands: the -c operand as written, its $1 and on left alone, since
// the shell running the code expands those without reading them as code.
function expandedInlineCode(line) {
  const carrier = inlineCodeWords(line);
  if (carrier === null) return null;
  if (carrier.evaluated) return carrier.words.some(word => word.expands) ? carrier.words.map(word => word.value).join(' ') : null;
  return carrier.words[0].expands ? carrier.words[0].value : null;
}

const MAX_SECOND_READINGS = 64;
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /\w/;

// Whether the character at `at` is escaped by the backslashes before it.
function escapedAt(text, at) {
  let count = 0;
  while (at - count > 0 && text[at - count - 1] === '\\') count += 1;
  return count % 2 === 1;
}

// The variable a `$` at `at` reads, as { name, operator, end }: $NAME or
// ${NAME...}, the operator being whatever follows the name inside the
// braces; null for anything else ($1, $?, $(...), an escaped $).
function referenceAt(text, at) {
  if (escapedAt(text, at)) return null;
  const braced = text[at + 1] === '{';
  let end = at + (braced ? 2 : 1);
  if (!NAME_START.test(text[end] ?? '')) return null;
  const start = end;
  while (end < text.length && NAME_PART.test(text[end])) end += 1;
  const name = text.slice(start, end);
  if (!braced) return { name, operator: '', end };
  const close = text.indexOf('}', end);
  if (close === -1) return null;
  return { name, operator: text.slice(end, close), end: close + 1 };
}

// Every variable reference the code holds, in order, as referenceAt tells.
function variableReferences(code) {
  const references = [];
  for (let at = code.indexOf('$'); at !== -1; at = code.indexOf('$', at + 1)) {
    const reference = referenceAt(code, at);
    if (reference) references.push({ ...reference, start: at });
  }
  return references;
}

// The ${NAME...} operators this hook follows: those that fall back to their
// word (-, =, ?) and the one that swaps it in (+), each with or without :.
const FALLBACK_OPERATOR_RE = /^:?([-=?+])/;
const referenceKey = ({ name, operator }) => `${name}${operator}`;

// The values one reference takes the second time the code is read: those
// the line gives the variable (every name counts as given once the line
// sources a script or builds a name at run time), or the environment's own
// value for a name the line leaves to it; null when there is nothing to
// read again; the reason it cannot be read otherwise.
function referenceValues(reference, bindings, unknownFails) {
  const { name, operator } = reference;
  if (!bindings.names.has(name) && !bindings.sources && !bindings.dynamic) {
    const env = process.env[name];
    return typeof env === 'string' && !operator ? { values: [env] } : null;
  }
  const own = valuesOf(bindings, name, process.env);
  if (own === null) {
    return { blocked: `the code a shell reads a second time takes $${name}, which this line sets from a source this hook cannot read; write the value out or quote the heredoc delimiter` };
  }
  return operatorValues(reference, own, unknownFails);
}

// The values a reference takes once its operator applies to the variable's.
function operatorValues({ name, operator }, own, unknownFails) {
  if (!operator) return { values: own };
  const fallback = FALLBACK_OPERATOR_RE.exec(operator);
  const word = fallback ? operator.slice(fallback[0].length) : '';
  if (fallback && !/[$`]/.test(word)) {
    if (fallback[1] === '+') return { values: [word, ''] };
    return { values: fallback[1] === '?' ? own : [...new Set([...own, word])] };
  }
  // A committed script is held to the grave denials only: the variable's
  // own values stand in for what the expansion makes of them.
  if (!unknownFails) return { values: own };
  return { blocked: `the code a shell reads a second time takes \${${name}${operator}}, an expansion this hook does not follow; write the value out or quote the heredoc delimiter` };
}

// The values each reference of the code takes, keyed by the reference.
function secondReadValues(references, bindings, unknownFails) {
  const values = new Map();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (values.has(key)) continue;
    const found = referenceValues(reference, bindings, unknownFails);
    if (found === null) continue;
    if (found.blocked) return found;
    values.set(key, found.values);
  }
  return { values };
}

// The code with each reference in `choice` replaced by its value.
function substituted(code, references, choice) {
  let text = '';
  let from = 0;
  for (const reference of references) {
    const key = referenceKey(reference);
    if (!choice.has(key)) continue;
    text += code.slice(from, reference.start) + choice.get(key);
    from = reference.end;
  }
  return text + code.slice(from);
}

// The code as the shell reads it the second time, once per combination of
// the values its references take.
function codeVariants(code, bindings, unknownFails) {
  const references = variableReferences(code);
  const found = secondReadValues(references, bindings, unknownFails);
  if (found.blocked) return found;
  let choices = [new Map()];
  for (const [key, values] of found.values) {
    choices = choices.flatMap(choice => values.map(value => new Map([...choice, [key, value]])));
    if (choices.length > MAX_SECOND_READINGS) {
      return { blocked: 'the code a shell reads a second time takes more combinations of values than this hook follows; write the values out' };
    }
  }
  const texts = choices.map(choice => substituted(code, references, choice));
  return { texts: [...new Set(texts)].filter(text => text !== code) };
}

// The segments of the code a text hands a shell to read a second time, each
// reading resolved like any segment. A value this hook cannot read fails
// closed when `unknownFails`, and is left as it is otherwise (a committed
// script, held only to the grave denials).
function secondReadings(text, bindings, unknownFails) {
  const found = [];
  for (const code of expandedCodes(text)) {
    const variants = codeVariants(code, bindings, unknownFails);
    if (variants.blocked) {
      if (unknownFails) return { blocked: variants.blocked };
      continue;
    }
    for (const variant of variants.texts) {
      const nested = extractSegments(variant, 1);
      if (nested === null) return { blocked: NESTED_TOO_DEEP };
      const resolved = resolveCommandWords(nested, bindings, unknownFails);
      if (resolved.blocked) return resolved;
      found.push(...resolved.segments);
    }
  }
  return { segments: found };
}

// A script operand that is exactly one resolvable variable, spread to the
// literal filenames that variable takes; otherwise the operand unchanged.
// Unquoted, a value is split on blanks as the shell splits it, and its first
// field is the script that runs.
function expandScriptVar(word, context) {
  const reference = word.script && word.expands && /^\$\{?([A-Za-z_]\w*)\}?$/.exec(word.value);
  const found = reference && context.scriptVars?.get(reference[1]);
  if (!found) return [word];
  return found
    .map(({ value, optional }) => ({ value: word.bare ? value.trim().split(/[ \t\n]+/)[0] : value, optional }))
    .filter(({ value }) => value !== '')
    .map(({ value, optional }) => ({ ...word, value, optional, expands: false, globbed: /[*?[]/.test(value), tilde: value.startsWith('~') }));
}

// The file an operand names when it starts with the script's own
// directory, spelled as a scripts do; null when it does not.
function scriptRelative(value, context) {
  if (!context.scriptDir) return null;
  const spelled = value.replaceAll(/\s+/g, ' ');
  const prefixes = [...SCRIPT_DIR_IDIOMS, ...[...context.dirVars].flatMap(name => [`\${${name}}`, `$${name}`])];
  const prefix = prefixes.find(candidate => spelled.startsWith(candidate) && /^(?:$|[\\/])/.test(spelled.slice(candidate.length)));
  if (prefix === undefined) return null;
  const rest = spelled.slice(prefix.length);
  return /[$`]/.test(rest) ? null : context.scriptDir + rest;
}

// `cwdUnknown` carries a directory the script runs from but that cannot be
// known (sudo -i's target home), down to the scripts it runs.
const COPY_WRITERS = new Set(['cp', 'mv', 'install', 'ln']);
const REDIRECT_OUT_RE = /^\d*(?:>>?|>\||&>>?)/;

// The path a written word names, or null when it is only known at run time.
function writtenPath(value, base) {
  if (value === '~' || value.startsWith('~/')) return path.join(os.homedir(), value.slice(1));
  const home = HOME_PARAMETER_RE.exec(value);
  if (home) return /[$`]/.test(value.slice(home[0].length)) ? null : path.join(os.homedir(), value.slice(home[0].length));
  return /[$`*?[]/.test(value) ? null : path.resolve(base, value);
}

function valueAfter(args, names) {
  for (const [i, arg] of args.entries()) {
    if (names.includes(arg)) return args[i + 1];
    const long = names.find(name => name.startsWith('--') && arg.startsWith(`${name}=`));
    if (long) return arg.slice(long.length + 1);
  }
  return undefined;
}

// The files these segments write where the hook can see it (redirections,
// tee, touch, cp and its kin, curl -o, wget -O, dd of=) and whether one of
// them writes files it does not name, or names one only known at run time
// (`bulk`, counted for the command's own segments).
function writesOf(segments, base, own) {
  const paths = new Set();
  let bulk = false;
  const add = value => {
    if (!value || value.startsWith('&') || value === '/dev/null') return;
    const resolved = writtenPath(value, base);
    if (resolved === null) bulk = bulk || own;
    else paths.add(resolved);
  };
  for (const segment of segments) {
    const words = shellWords(segment);
    redirectedFiles(words).forEach(add);
    commandWrites(words, add);
  }
  return { paths, bulk };
}

// The files a segment's output redirections name.
function redirectedFiles(words) {
  const files = [];
  for (const [i, word] of words.entries()) {
    const redirect = REDIRECT_OUT_RE.exec(word.value);
    if (redirect) files.push(redirect[0].length === word.value.length ? words[i + 1]?.value : word.value.slice(redirect[0].length));
  }
  return files;
}

// Hands `add` each file the segment's command names as one it writes. The
// files a command writes without naming (a checkout, an extraction) are not
// treated as the script that runs next: their content comes from the repo
// or an archive, which is code inspected on its own terms, not bytes this
// command puts under the agent's control.
function commandWrites(words, add) {
  const index = skipEnvAndWrappers(words);
  const name = commandName(words[index]?.value);
  const args = words.slice(index + 1).map(word => word.value);
  const operands = args.filter(arg => !arg.startsWith('-'));
  if (name === 'tee' || name === 'touch') operands.forEach(add);
  else if (COPY_WRITERS.has(name) && operands.length >= 2) {
    add(operands.at(-1));
    for (const source of operands.slice(0, -1)) add(path.join(operands.at(-1), path.basename(source)));
  } else if (name === 'curl') add(valueAfter(args, ['-o', '--output']));
  else if (name === 'wget') add(valueAfter(args, ['-O', '--output-document']));
  else if (name === 'dd') add(args.find(arg => arg.startsWith('of='))?.slice(3));
}

// The scripts a segment runs, looked for in every directory the line can be
// in at that point (`dirs`), each with the directory it then runs from.
function scriptOperandsOf(segment, dirs, context) {
  const found = interpreterOperands(shellWords(segment), context.cwdUnknown);
  const outcome = (blocked, files = []) => ({ files, blocked, sources: found.sources, cwdUnknown: found.cwdUnknown });
  if (found.unsure) return outcome('a wrapper path uses byte escapes that cannot be resolved faithfully');
  if (found.unresolved && found.operands.length > 0) return outcome(found.unresolved);
  // A directory that cannot be known leaves an absolute path resolvable.
  if (found.cwdUnknown && found.operands.some(operand => !path.isAbsolute(operand.value))) return outcome(found.cwdUnknown);
  const read = readOperands(found, dirs, context);
  return outcome(read.blocked, read.files);
}

// The script files the operands name in each directory the line can be in.
function readOperands(found, dirs, context) {
  const places = dirs.map(dir => operandBases(found, dir));
  const files = [];
  for (const target of found.operands.flatMap(word => expandScriptVar(word, context))) {
    for (const { root, base } of places) {
      const read = readOperand(target, context, root, base);
      if (read?.blocked) return { files, blocked: read.blocked };
      if (!read) continue;
      // One file reached from several directories is read once, and runs
      // from any of them.
      const same = files.find(entry => entry.file === read.file && entry.args === target.args);
      if (same) same.bases.push(base);
      else files.push({ file: read.file, base, bases: [base], args: target.args });
    }
  }
  return { files, blocked: null };
}

// Shells a #! line can name, directly or through env.
const SHEBANG_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'mksh', 'dash', 'ash', 'busybox']);

// A file the kernel will not run is run by bash as a script of its own
// unless a NUL comes before the first newline within its first 128 bytes
// (measured on bash 5.2); zsh refuses a NUL anywhere in them, so what bash
// refuses zsh refuses too. An ELF, Mach-O or PE image has one in its header.
const BINARY_SAMPLE_BYTES = 128;

function readsAsBinary(head) {
  const sample = head.slice(0, BINARY_SAMPLE_BYTES);
  const newline = sample.indexOf('\n');
  return (newline < 0 ? sample : sample.slice(0, newline)).includes('\0');
}

// env's long options, and those of its options, short and long, that take
// the next word as their value (-S takes one too and splits it into more
// words).
const ENV_LONG_OPTIONS = ['unset', 'chdir', 'argv0', 'split-string', 'ignore-environment', 'null', 'debug', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'help', 'version'];
const ENV_LONG_VALUE = new Set(['unset', 'chdir', 'argv0']);
const ENV_SHORT_VALUE = new Set(['u', 'C', 'a']);
const ENV_SHORT_FLAGS = new Set(['i', '0', 'v']);

// The words env reads after one cluster of short options: `-iu NAME` takes
// NAME, `-Ssh -e` splits `sh` into a word of its own. null for an option env
// does not know.
function afterEnvShort(word, rest) {
  for (let k = 1; k < word.length; k += 1) {
    const attached = word.slice(k + 1);
    if (word[k] === 'S') return attached ? [attached, ...rest] : rest;
    if (ENV_SHORT_VALUE.has(word[k])) return attached ? rest : rest.slice(1);
    if (!ENV_SHORT_FLAGS.has(word[k])) return null;
  }
  return rest;
}

// The words env reads after one long option, abbreviated as getopt_long
// allows; none after --help or --version, which run nothing. null for an
// option env does not know.
function afterEnvLong(word, rest) {
  const eq = word.indexOf('=');
  const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
  const matches = ENV_LONG_OPTIONS.filter(option => option.startsWith(name));
  const option = matches.includes(name) ? name : matches.length === 1 && matches[0];
  if (!option) return null;
  if (option === 'help' || option === 'version') return [];
  if (option === 'split-string') return eq < 0 ? rest : [word.slice(eq + 1), ...rest];
  return ENV_LONG_VALUE.has(option) && eq < 0 ? rest.slice(1) : rest;
}

// The program env runs, read past its options and assignments; undefined
// when it runs none, null when an option cannot be read.
function envProgram(words) {
  let rest = words;
  while (rest?.length > 0) {
    const [word, ...after] = rest;
    if (word === '--') return after.find(operand => !operand.includes('='));
    if (word.startsWith('--')) rest = afterEnvLong(word, after);
    else if (word.startsWith('-')) rest = afterEnvShort(word, after);
    else if (word.includes('=')) rest = after;
    else return word;
  }
  return rest === null ? null : undefined;
}

// A word of an env -S string, read with its quotes as env reads them.
const unquoteEnvWord = word => word.replace(/^(['"])(.*)\1$/, '$2');

// A file this user cannot read and does not own was not written by it: run
// by its path (through sudo, as root) it is left to the program it is. One
// it owns could have been made unreadable to hide it, and is read, which
// fails closed; so is one whose owner cannot be told.
function unreadableRunsAsShell(file) {
  try {
    return typeof process.getuid !== 'function' || fs.statSync(file).uid === process.getuid();
  } catch {
    return true;
  }
}

// Whether a file run by its path is a shell script: its #! line names a
// shell, directly or through env (its -S string read with its quotes), or it
// has none or names no interpreter, and then the calling shell runs it as a
// script of its own. A binary and another interpreter's script are not read
// as shell. The extension decides nothing: Git Bash runs a .exe or .ps1 that
// is not an image as a script, and the commands of a .cmd run too, cmd
// finding rm and its kin on the Git for Windows PATH. An env line whose
// options cannot be read is read as shell.
function runsAsShellScript(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(256);
      head = buffer.subarray(0, fs.readSync(fd, buffer, 0, 256, 0)).toString('latin1');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return unreadableRunsAsShell(file);
  }
  if (readsAsBinary(head)) return false;
  if (!head.startsWith('#!')) return true;
  const line = head.slice(2).split('\n')[0].trim();
  if (!line) return true;
  const words = line.split(/\s+/);
  const program = path.basename(words[0]);
  const run = program === 'env' ? envProgram(words.slice(1).map(unquoteEnvWord)) : program;
  return run === null || SHEBANG_SHELLS.has(path.basename(run ?? ''));
}

// One operand of an interpreter: the script file it names, the reason it
// cannot be inspected, or null when it names no file to read.
function readOperand(word, context, root, base) {
  // Under -n or -o noexec the shell reads its operands but runs none of them.
  if (word.noRun) return null;
  const beside = word.expands ? scriptRelative(word.value, context) : null;
  const value = beside ?? expandedOperandValue(word, context.homeKnown);
  // An argument the shell expands at run time is not the script; the
  // script itself cannot be found before it runs.
  if (value === null) return word.script && !word.direct ? { blocked: `operand ${word.value} is expanded by the shell when it runs and cannot be inspected` } : null;
  const descriptor = descriptorOperand(word, value);
  if (descriptor !== undefined) return descriptor;
  const candidate = operandPath(value, root, base);
  // A script the command writes is not the file read here, wherever the
  // write sits on the line: a loop, a function called later, a background
  // job or a pipeline can run the script after a write written after it.
  if (word.script && candidate !== null && (context.written.bulk || context.written.paths.has(candidate))) {
    return { blocked: `script ${word.value} may be written by this command before it runs, so what runs is not what was read; run it in a command of its own` };
  }
  const inspected = inspectedFile(word, value, root, base);
  if (inspected || !word.script) return inspected;
  return missingScript(word, context, beside, candidate);
}

// A descriptor path names what the running command holds, not a file this
// hook can open: its standard input is judged as what it is fed there, any
// other descriptor cannot be inspected. undefined for any other path.
function descriptorOperand(word, value) {
  if (!isRuntimeOnly(value)) return undefined;
  return word.script && !isStdinPath(value) ? { blocked: `script ${word.value} names a file descriptor of the running command, so what it runs cannot be inspected` } : null;
}

// The file an operand names once inspected; a file run by its path counts
// only when it is a shell script, whatever its size: a binary or another
// interpreter's script past the size limit is left to the program it is.
function inspectedFile(word, value, root, base) {
  const inspected = inspectOperand({ ...word, value, expands: false, tilde: false }, root, base);
  const file = inspected?.file ?? inspected?.oversized;
  return word.direct && file && !runsAsShellScript(file) ? null : inspected;
}

// Why a script the command runs, which the hook did not find as a regular
// file, cannot be inspected; null when it need not be there.
function missingScript(word, context, beside, candidate) {
  if (candidate !== null && candidate !== '/dev/null' && isSpecialFile(candidate)) {
    return { blocked: `script ${word.value} is not a regular file (a pipe or a device), so what it hands the shell cannot be inspected` };
  }
  // A file beside the script that is not there is not one this hook read.
  if (beside !== null) return { blocked: `operand ${word.value} names ${beside}, which is not a file this hook can read` };
  // A script the command itself runs must be there to be read: one that is
  // not could be written by this very command before it runs. A cd in an
  // earlier segment moves the directory the hook cannot follow, so the file
  // may well be there under the real one; then this cannot be claimed.
  if (context.own && context.cwdKnown && !word.optional && candidate !== null && !fs.existsSync(candidate)) {
    return { blocked: `script ${word.value} is not there when the command is checked, so it cannot be inspected; write it first, then run it in a command of its own` };
  }
  return null;
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
  let text;
  let nested;
  try {
    text = fs.readFileSync(file, 'utf8');
    nested = extractSegments(text);
  } catch {
    return { blocked: `script ${file} cannot be read` };
  }
  if (nested === null) {
    return { blocked: 'a script it runs nests command/process substitutions deeper than this validator can safely unwrap and analyze' };
  }
  return { segments: nested, text };
}

// Segments of every script the command runs, following scripts that run
// scripts; `blocked` names the reason when one of them cannot be inspected.
const GIT_TIMEOUT_MS = 2000;

// git run to read, never to act: the variables that point it at another
// repository are dropped and fsmonitor, the one command the repository's
// config could have these subcommands start, is switched off.
function gitIn(dir, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { // NOSONAR javascript:S4036 -- the user's own git knows their repositories; fixed argv, no shell
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The id git gives a blob of these bytes, in the repository's hash.
function blobId(bytes, format) {
  const hash = crypto.createHash(format === 'sha256' ? 'sha256' : 'sha1');
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest('hex');
}

// Whether a script is committed in git and unchanged since: its bytes are
// the committed blob, or are it with CRLF line endings, as a checkout with
// core.autocrlf writes it. Project code rather than something written
// moments ago, its commands are then held only to the grave denials.
// Untracked, changed, staged or outside a repository, it is judged in full.
// The hashing is done here, so no filter the repository configures runs.
function isCommittedUnchanged(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  if (gitIn(dir, ['ls-files', '--error-unmatch', '--', name]) === null) return false;
  const entry = /^\d+ blob ([0-9a-f]+)\t/.exec(gitIn(dir, ['ls-tree', 'HEAD', '--', name]) ?? '');
  if (entry === null) return false;
  const format = gitIn(dir, ['rev-parse', '--show-object-format']) ?? 'sha1';
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (blobId(bytes, format) === entry[1]) return true;
  return bytes.includes(13) && blobId(Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'), format) === entry[1];
}

// Segments of every script the command runs, and for each whether it was
// read out of a committed, unchanged script. A committed script is held
// only to grave denials, so a script it runs that cannot be inspected is
// passed over there, while one the command itself names fails closed.
// What the command line itself leaves the scripts it runs to know: the
// variables it or the environment sets (a committed script cannot count
// those as its own), and no script directory.
function commandContext(segments, cwd, bindings) {
  return {
    own: true,
    cwdUnknown: null,
    cwdKnown: true,
    homeKnown: true,
    scriptDir: null,
    dirVars: new Set(),
    bindings,
    scriptVars: scriptVarsOf(bindings),
    callerSet: new Set([...Object.keys(process.env), ...assignedNames(segments)]),
    written: writesOf(segments, cwd || process.cwd(), true),
  };
}

// The command a segment runs and its arguments, after env assignments and
// wrappers.
function commandOf(segment) {
  const words = shellWords(segment);
  const index = skipEnvAndWrappers(words);
  return { name: words[index] ? commandName(words[index].value) : undefined, args: words.slice(index + 1) };
}

// Whether a CDPATH search can decide where a relative cd lands: the
// environment or the line sets one.
function cdpathSearched(context) {
  return Boolean(process.env.CDPATH) || Boolean(context.bindings?.names?.has('CDPATH'));
}

// The directories a cd target word names (see scripts/lib/shell-cwd.js);
// null when only the running shell knows them. `word` null is a bare cd,
// which goes home; `raw` is the word as the line spells it.
function cdTargetsOf(word, context, raw) {
  if (word === null) return context.homeKnown ? [os.homedir()] : null;
  if (word.globbed || word.unsure) return null;
  let targets = [word.value];
  if (word.tilde || word.expands) {
    const beside = word.expands ? scriptRelative(word.value, context) : null;
    const value = beside ?? expandedOperandValue(word, context.homeKnown);
    targets = value === null ? boundCdTargets(raw, context) : [value];
  }
  // A relative target that CDPATH may find elsewhere lands where only the
  // running shell knows.
  const searched = targets !== null && cdpathSearched(context) && targets.some(target => !path.isAbsolute(target) && !/^\.{0,2}(?:[\\/]|$)/.test(target));
  return searched ? null : targets;
}

// The directories a target word names once the shell expands it with the
// values the line gives the variables in it, and HOME for a leading ~ (see
// commandWordChoices). A variable the line does not set is one only the
// running shell knows: null then, and for any value this hook cannot read.
function boundCdTargets(raw, context) {
  const { bindings } = context;
  const lookup = name => {
    if (bindings.names.has(name)) return valuesOf(bindings, name, process.env);
    return name === 'HOME' && context.homeKnown ? [os.homedir()] : null;
  };
  const outcome = commandWordChoices(raw, lookup, bindings.ifs);
  if (!outcome.choices) return null;
  const targets = [];
  for (const fields of outcome.choices) {
    // A word that expands to nothing leaves a bare cd, which goes home; one
    // that splits into several is too many operands, and cd stays.
    if (fields.length === 0) {
      if (!context.homeKnown) return null;
      targets.push(os.homedir());
    } else if (fields.length === 1) {
      targets.push(fields[0]);
    }
  }
  return targets;
}

// Whether a sourced script, whose own commands run in its caller, has one
// that `acts` does. A script it sources in turn may bring anything; one it
// runs with a shell of its own acts only in that shell.
function actsInCaller(own, acts) {
  return own.some(segment => acts(segment) || ['source', '.'].includes(commandOf(segment).name));
}

// Where the line can be after a segment that runs a script it sources: that
// script's own cd moves the caller too, which this hook does not follow.
function sourcedMove(where, operands, own) {
  if (!operands.sources || !actsInCaller(own, segment => CWD_CHANGERS.has(commandOf(segment).name))) return where;
  return where.unknown ? where : { ...where, unknown: 'a script it sources moves the directory, which this hook does not follow' };
}

// Also gives, for each of `segments` and each segment collected from the
// scripts they run, the directories it can run in (null when only the
// running shell knows them), so each is judged there.
function scriptSegmentsOf(segments, cwd, depth, seen, context) {
  const collected = [];
  const committed = [];
  const places = [];
  const collectedPlaces = [];
  const outcome = blocked => ({ segments: collected, committed, places, collectedPlaces, blocked });
  let homeKnown = context.homeKnown;
  let where = startCwd(cwd || process.cwd());
  for (const segment of segments) {
    places.push(where.unknown ? null : where.dirs);
    const here = { ...context, homeKnown, cwdKnown: context.cwdKnown && where.dirs.length === 1, cwdUnknown: context.cwdUnknown ?? where.unknown };
    const operands = scriptOperandsOf(segment, where.dirs, here);
    if (operands.blocked) return outcome(operands.blocked);
    let sourcedChangesHome = false;
    for (const { file, base, bases, args } of operands.files) {
      const found = fileSegmentsOf(file, { ...operands, base, bases, args }, depth, seen, here);
      collected.push(...found.segments);
      committed.push(...found.committed);
      collectedPlaces.push(...found.places);
      if (found.blocked) return outcome(found.blocked);
      sourcedChangesHome = sourcedChangesHome || (operands.sources && actsInCaller(found.own, changesHome));
      where = sourcedMove(where, operands, found.own);
    }
    homeKnown = homeKnown && !changesHome(segment) && !sourcedChangesHome;
    const { name, args } = commandOf(segment);
    where = afterMove(where, name, args, word => cdTargetsOf(word, { ...here, homeKnown }, word && segment.slice(word.start, word.end)));
  }
  return outcome(null);
}

// The positional parameters a script gets from the words it is run with
// (see commandWordChoices), when this hook can read them all as written.
// Null otherwise: a word the shell expands, a script sourced without words
// of its own (it shares its caller's), and one that can move or reset them
// (shift, set, and eval or source, which may run either with code this hook
// does not read here) or defines a function, whose $1 and on are its own.
function scriptPositional(operands, file, segments, homeKnown) {
  const { args } = operands;
  if (!Array.isArray(args) || (operands.sources && args.length === 0)) return null;
  if (segments.some(changesPositionals)) return null;
  const words = positionalWords(args, homeKnown);
  return words === null ? null : { zero: file, words };
}

// The values of the words a script is run with, a leading ~ already the
// home directory, as the shell running the line hands them over; null when
// one of them only that shell can read.
function positionalWords(args, homeKnown) {
  const words = [];
  for (const word of args) {
    if (!literalWords([{ ...word, tilde: false }])) return null;
    const value = word.tilde ? expandedOperandValue(word, homeKnown) : word.value;
    if (value === null) return null;
    words.push(value);
  }
  return words;
}

const FUNCTION_DEFINITION_RE = /^\s*(?:function\s+\S|[\w.:-]+\s*\(\s*\))/;
const POSITIONAL_CHANGERS = new Set(['shift', 'eval', 'source', '.']);

function changesPositionals(segment) {
  if (FUNCTION_DEFINITION_RE.test(segment)) return true;
  const { name, args } = commandOf(segment);
  if (POSITIONAL_CHANGERS.has(name)) return true;
  return name === 'set' && setsPositionals(args.map(word => word.value));
}

// Whether set's words give the script new positional parameters: `--`, or
// any word that is no option (the name after an o, as in -o or -euo, is the
// option's).
function setsPositionals(values) {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === '--' || !/^[-+]./.test(values[i])) return true;
    if (/^[-+][A-Za-z]*o$/.test(values[i])) i += 1;
  }
  return false;
}

// The segments one script file brings, its own and those of the scripts it
// runs in turn, each marked committed or not. A script that cannot be
// analyzed fails closed whoever runs it: its commands could be anything.
const NO_FILE_SEGMENTS = { segments: [], own: [], committed: [], places: [] };

function fileSegmentsOf(file, operands, depth, seen, context) {
  const nested = nestedSegmentsOf(file, depth, seen);
  if (nested.blocked) return { ...NO_FILE_SEGMENTS, blocked: nested.blocked };
  if (nested.segments === null) return { ...NO_FILE_SEGMENTS, blocked: null };
  const committedFile = isCommittedUnchanged(file);
  // A script's command words are judged by every value they can take, from
  // what the script and its caller fix; one the hook cannot read fails closed
  // unless the script is committed, where only the grave denials apply.
  const ownBindings = bindingsOfSegments(nested.segments);
  const bindings = mergeBindings(context.bindings, ownBindings);
  const positional = scriptPositional(operands, file, nested.segments, context.homeKnown);
  const words = resolveCommandWords(nested.segments, bindings, !committedFile, positional);
  if (words.blocked) return { ...NO_FILE_SEGMENTS, blocked: `script ${file}: ${words.blocked}` };
  const reread = secondReadings(nested.text, bindings, !committedFile);
  if (reread.blocked) return { ...NO_FILE_SEGMENTS, blocked: `script ${file}: ${reread.blocked}` };
  const own = [...words.segments, ...reread.segments];
  const mark = committedFile ? { bound: boundAssignments(nested.segments, context.callerSet) } : false;
  // A script the wrapper moved into a directory runs its own children there.
  const ownWrites = writesOf(own, operands.base, false);
  const inner = scriptSegmentsOf(own, operands.bases ?? operands.base, depth + 1, seen, {
    own: false,
    cwdUnknown: operands.cwdUnknown,
    cwdKnown: true,
    homeKnown: context.homeKnown,
    scriptDir: path.dirname(file),
    dirVars: scriptDirVariables(nested.segments),
    bindings,
    scriptVars: scriptVarsOf(ownBindings),
    callerSet: new Set([...context.callerSet, ...assignedNames(nested.segments)]),
    written: { paths: new Set([...context.written.paths, ...ownWrites.paths]), bulk: context.written.bulk },
  });
  // Its commands run where its own moves leave them, from where it starts;
  // one past a move only the running shell knows, and code it reads after
  // expanding, where it starts.
  const ownPlaces = own.map((_, i) => (i < words.segments.length ? inner.places[i] : null) ?? operands.bases ?? [operands.base]);
  return {
    segments: [...own, ...inner.segments],
    own,
    committed: [...own.map(() => mark), ...inner.committed],
    places: [...ownPlaces, ...inner.collectedPlaces],
    blocked: inner.blocked,
  };
}

// Names these segments assign or export.
function assignedNames(segments) {
  const names = new Set();
  for (const segment of segments) {
    const words = shellWords(segment).map(word => word.value);
    for (const [i, word] of words.entries()) {
      const assignment = /^([A-Za-z_]\w*)\+?=/.exec(word);
      if (assignment) names.add(assignment[1]);
      else if (words[i - 1] === 'export' && /^[A-Za-z_]\w*$/.test(word)) names.add(word);
    }
  }
  return names;
}

// What a committed script sets each variable to, for the ones neither the
// command nor the environment can set before it runs: the validator counts
// a variable as the script's own only when every value is a narrow target.
function boundAssignments(segments, callerSet) {
  const values = {};
  for (const segment of segments) {
    for (const word of shellWords(segment)) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.value);
      if (!assignment || callerSet.has(assignment[1])) continue;
      values[assignment[1]] = [...(values[assignment[1]] ?? []), assignment[2]];
    }
  }
  return values;
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

// A `#` opening a word starts a comment; the caller asks only outside quotes
// and outside ${...}.
function opensComment(out, ch) {
  return ch === '#' && (out === '' || /[\s;&|(]/.test(out.at(-1)));
}

// A backslash-newline outside single quotes is a line continuation and is
// dropped; inside a comment it is comment text, and the newline still ends
// the comment, as bash reads it.
// A command body (`$(...)`, backquotes, and outside double quotes `<(...)`
// and `>(...)`) is copied as written: bash reads its comments, and so its
// line continuations, as a command of its own, and extractSegments joins it
// when it reads that body in turn.
function commandBodyEnd(text, i, double) {
  if (text[i] === '$' && text[i + 1] === '{') return null;
  if (double && text[i] !== '`' && !(text[i] === '$' && text[i + 1] === '(')) return null;
  return constructEnd(text, i);
}

// `state.open` holds the quotes and ${...} expansions open around the
// character, innermost last: a `"` inside a ${...} opens a string of its
// own, even when that ${...} sits in double quotes, as bash reads it.
function joinContinuations(text) {
  const state = { out: '', single: false, open: [], comment: false };
  let i = 0;
  while (i < text.length) i = joinStep(text, i, state);
  return state.out;
}

// Reads the character at `i` into `state.out`; the index to read next.
function joinStep(text, i, state) {
  const ch = text[i];
  if (state.comment) {
    state.comment = ch !== '\n';
    state.out += ch;
    return i + 1;
  }
  const double = state.open.includes('"');
  const body = state.single ? null : commandBodyEnd(text, i, double);
  if (body !== null) {
    const end = body === -1 ? text.length : body + 1;
    state.out += text.slice(i, end);
    return end;
  }
  if (state.single) {
    state.single = ch !== "'";
    state.out += ch;
    return i + 1;
  }
  if (state.open.length === 0) state.comment = opensComment(state.out, ch);
  if (ch === '\\') return escapeStep(text, i, state);
  return quoteStep(text, i, state, double);
}

// A quote, a `${` or its `}`, or any other character outside single quotes.
// `$'...'` is copied whole: its escapes are its own, an escaped quote too.
function quoteStep(text, i, state, double) {
  const ch = text[i];
  if (ch === '$' && text[i + 1] === "'" && !double) {
    const end = constructEndOfAnsi(text, i);
    state.out += text.slice(i, end);
    return end;
  }
  if (ch === '$' && text[i + 1] === '{') {
    state.open.push('{');
    state.out += '${';
    return i + 2;
  }
  const inner = state.open.at(-1);
  if (ch === '}' && inner === '{') state.open.pop();
  else if (ch === '"' && inner === '"') state.open.pop();
  else if (ch === '"') state.open.push('"');
  else if (ch === "'" && !double) state.single = true;
  state.out += ch;
  return i + 1;
}

// Index past the `$'...'` opening at `i`.
function constructEndOfAnsi(text, i) {
  let j = i + 2;
  while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

// A continuation is dropped; any other escape is kept with its character.
function escapeStep(text, i, state) {
  const skip = continuationLength(text, i);
  if (skip > 0) return i + skip;
  state.out += text.slice(i, i + 2);
  return i + 2;
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
  const isShell = head.value.startsWith('$') || SHELL_INTERPRETERS.has(commandName(head.value));
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
  if (commandName(words[index]?.value) !== 'egc') return null;
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

// The code `eval` or a shell's -c runs, read as the command line it is, so
// the commands inside are judged like any other: in a committed script the
// eval itself is only flagged, and what it runs still meets the grave
// denials. null when the stage runs no such code.
function inlineShellCodeOf(line) {
  const carrier = inlineCodeWords(line);
  if (carrier === null) return null;
  return carrier.evaluated ? carrier.words.map(word => word.value).join(' ') : withPositionals(carrier.words[0].value, carrier.words.slice(1));
}

// The words that carry that code: every word after eval, or the operand of
// a shell's -c followed by its $0, $1 and on; null when there is none.
function inlineCodeWords(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  const name = commandName(words[index]?.value);
  if (name === 'eval') return words.length > index + 1 ? { words: words.slice(index + 1), evaluated: true } : null;
  if (!SHELL_INTERPRETERS.has(name) || name === 'source' || name === '.') return null;
  const rest = words.slice(index + 1);
  const at = shellCommandIndex(rest);
  return at < 0 ? null : { words: rest.slice(at), evaluated: false };
}

// Where the string a shell's -c runs stands: its first operand after the
// options, when one of them is -c, alone or in a cluster such as -ec. The
// words after it are its $0, $1 and on, read into the code where it names
// them. Under -n or -o noexec the shell only parses the string, so it runs
// no code: -1 then, and when there is no -c.
function shellCommandIndex(words) {
  const state = { awaiting: null, noexec: false, command: false };
  for (const [i, word] of words.entries()) {
    if (consumedAsOptionValue(word, state)) continue;
    if (!/^[-+]/.test(word.value)) return state.command && !state.noexec ? i : -1;
    noteShellOption(word.value, state);
  }
  return -1;
}

// A positional parameter the code of a shell's -c reads, replaced by the
// word given for it: a find action's {} or a literal path is then judged as
// the target it is. One with no word given stays as written, a value the
// caller chooses.
function withPositionals(code, given) {
  return code.replace(/\$(?:\{(\d+|[@*])\}|(\d|[@*]))/g, (whole, braced, bare) => {
    const name = braced ?? bare;
    if (name === '@' || name === '*') return given.length > 1 ? given.slice(1).map(word => word.value).join(' ') : whole;
    const index = Number(name);
    return index < given.length ? given[index].value : whole;
  });
}

// find's actions that run a command, which ends at a `;` or `+`.
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_ENDS = new Set([';', String.raw`\;`, '+']);

// The commands a find in this stage runs through -exec and its kin, each
// read as its own command line, so what they run (a shell's -c included)
// is judged too.
function findExecCommandsOf(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  if (commandName(words[index]?.value) !== 'find') return [];
  const commands = [];
  let current = null;
  for (const word of words.slice(index + 1)) {
    if (current === null) {
      if (FIND_EXEC_FLAGS.has(word.value)) current = [];
    } else if (FIND_EXEC_ENDS.has(word.value)) {
      commands.push(current.map(word => singleQuoted(word)).join(' '));
      current = null;
    } else {
      current.push(word.value);
    }
  }
  // find refuses an action that has no end, so nothing runs past the last one.
  return commands;
}

// A program a command runs that this hook cannot read: the whole command
// is refused, with the reason.
class ProgramUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProgramUnreadable';
  }
}

const inlineCode = name => `${name} reads the program it runs from its standard input, which is inline code; write the code to a file and run the file instead`;
const runtimeOnly = (name, source) => `${name} reads the program it runs from ${source}, which only exists while the command runs, so this hook cannot read it; save it to a file, read it, and run the file instead`;
const expandedInput = (name, kind) => `${name} reads the program it runs from a ${kind} the shell expands when the command runs, which this hook cannot read as written; quote it (<<'EOF', <<< '...') or write the script to a file and run the file instead`;

// The words of a stage, environment assignments and wrappers skipped: the
// command it runs, first.
function stageWords(stage) {
  const words = shellWords(splitHeredoc(stage).command);
  return words.slice(skipEnvAndWrappers(words));
}

const stageValues = stage => stageWords(stage).map(word => word.value);

// Whether words are the text the command runs with: nothing the shell
// expands, globs, brace-expands or reads as ~, no escape it cannot place,
// and no quoted word that only reads like a redirection.
function literalWords(words) {
  return words.every(word => !word.expands && !word.globbed && !word.tilde && !word.unsure && !word.braced && (word.redirect || !isRedirection(word.value)));
}

// Whether a heredoc's body is the text the command reads: every delimiter
// on its line is quoted, or the body holds nothing the shell expands in it.
function literalHeredoc(line, body) {
  if (!/[$`\\]/.test(body)) return true;
  const delimiters = [...line.matchAll(/(?:^|[^<])<<(?!<)-?\s*(\S+)/g)].map(match => match[1]);
  return delimiters.length > 0 && delimiters.every(delimiter => /['"\\]/.test(delimiter));
}

// The word a here-string (`<<< word`) feeds a command's standard input.
function hereStringWord(line) {
  const words = shellWords(line);
  for (let i = 0; i < words.length; i += 1) {
    if (!words[i].redirect) continue;
    if (words[i].value === '<<<') return words[i + 1] ?? null;
    if (words[i].value.startsWith('<<<')) return { ...words[i], value: words[i].value.slice(3) };
  }
  return null;
}

// What a command that reads its program on standard input is given there,
// as the command lines to judge: a shell's or at's script, read like any
// other, and the files it reads, as the script operands they are. An
// interpreter of another language reading its code there is inline code,
// and a path only the running command has cannot be read at all.
function fedLines(reader, produced) {
  if (reader.kind === 'interpreter') {
    throw new ProgramUnreadable(reader.files.length > 0 ? runtimeOnly(reader.name, reader.files[0]) : inlineCode(reader.name));
  }
  const shell = reader.kind === 'shell' ? reader.name : 'sh';
  if (produced.text !== undefined) return [produced.text];
  const runtime = produced.files.find(isRuntimeOnly);
  if (runtime !== undefined) throw new ProgramUnreadable(runtimeOnly(reader.name, runtime));
  return produced.files.map(file => `${shell} ${singleQuoted(file)}`);
}

// What a stage writes to the pipe, when this hook can read it as written.
function producedBy(stage) {
  const words = stageWords(stage);
  const { command, body } = splitHeredoc(stage);
  if (!literalWords(words) || (body !== null && !literalHeredoc(command, body))) return null;
  return producedProgram(words.map(word => word.value), body);
}

// The stages of a pipeline, a heredoc's body given to the stage whose
// operator opened it: in `cat <<EOF | sh` the body is what cat reads, and sh
// reads cat's output, not a script operand on the line after it.
function pipelineStages(pipeline) {
  const { command: line, body } = splitHeredoc(pipeline);
  if (body === null) return splitShellSegments(pipeline, { splitOnPipe: true, stripComments: true });
  const stages = splitShellSegments(line, { splitOnPipe: true, stripComments: true });
  const owner = stages.findIndex(stage => HEREDOC_OPERATOR_RE.test(stage));
  return stages.map((stage, i) => (i === owner ? `${stage}\n${body}` : stage));
}

// The programs each stage of the pipelines in `command` hands the next one
// as the program that one reads on standard input.
function fedPrograms(command) {
  const fed = [];
  for (const pipeline of splitShellSegments(command, { stripComments: true })) {
    const stages = pipelineStages(pipeline);
    for (let s = 1; s < stages.length; s += 1) {
      const reader = stdinReaderOf(stageValues(stages[s]));
      // A reader with input of its own (a file, a heredoc, a here-string)
      // runs that, judged with the stage, not what the stage before writes.
      if (reader === null || reader.files.length > 0 || splitHeredoc(stages[s]).body !== null || hereStringWord(stages[s]) !== null) continue;
      const produced = producedBy(stages[s - 1]);
      if (produced === null && reader.kind !== 'interpreter') {
        throw new ProgramUnreadable(`${reader.name} reads the program it runs from the output of '${stageValues(stages[s - 1]).join(' ')}', which this hook cannot read; save that output to a file, read it, and run the file instead`);
      }
      fed.push(...fedLines(reader, produced ?? { text: '' }));
    }
  }
  return fed;
}

// The text a stage's own heredoc or here-string feeds its reader, refused
// when the shell expands it before the reader gets it.
function ownInputText(reader, line, body) {
  const here = hereStringWord(line);
  if (here !== null) {
    if (here.expands || here.unsure || here.tilde) throw new ProgramUnreadable(expandedInput(reader.name, 'here-string'));
    return here.value;
  }
  if (body === null) return null;
  if (!literalHeredoc(line, body)) throw new ProgramUnreadable(expandedInput(reader.name, 'heredoc'));
  return body;
}

// The program a stage's own input hands the command it runs: a heredoc or
// a here-string, and the files it reads instead (at's scripts, the file a
// shell's input comes from).
function ownFedPrograms(line, body) {
  const reader = stdinReaderOf(stageValues(line));
  if (reader === null) return [];
  const text = ownInputText(reader, line, body);
  const programs = text === null ? [] : fedLines(reader, { text });
  return reader.files.length === 0 ? programs : [...programs, ...fedLines(reader, { files: reader.files })];
}

// The command lines this stage hands to another process (a terminal
// multiplexer, a remote shell, a container) to run.
function handedOffCommandsOf(line) {
  const words = shellWords(line);
  return handoffCommandsOf(words.slice(skipEnvAndWrappers(words)).map(word => word.value));
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
  const inline = inlineShellCodeOf(line);
  let own = trimmed ? [trimmed] : [];
  for (const code of [...(inline === null ? [] : [inline]), ...findExecCommandsOf(line), ...handedOffCommandsOf(line), ...ownFedPrograms(line, readsItsInputAsCode(line) ? null : body)]) {
    own = own === null ? null : withNested(own, code, depth);
  }
  if (own === null) return null;
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
  for (const raw of splitShellSegments(command, { stripComments: true }).flatMap(pipelineStages)) {
    const stage = segmentsOfStage(raw, depth);
    if (stage === null) return null;
    segments.push(...stage);
  }

  for (const body of bodies) {
    const nested = extractSegments(body, depth + 1);
    if (nested === null) return null;
    segments.push(...nested);
  }

  for (const program of fedPrograms(command)) {
    const nested = withNested([], program, depth);
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

function withoutVerdict(failure) {
  return {
    exitCode: 2,
    stderr: `EGC Guardian could not validate this command, so it did not run: ${guardianFailureReason(failure, VALIDATE_TIMEOUT_MS)}. Nothing was executed. Run the command again; on a slow machine, set EGC_GUARDIAN_TIMEOUT_MS to a larger budget in milliseconds (${VALIDATE_TIMEOUT_MS} now). If this keeps happening, run 'egc doctor' to check the Guardian build, and set EGC_DISABLED_HOOKS=pre:bash:guardian-validate to lift this gate while you repair it.`,
  };
}

// `options.truncated`: the input was cut at the size the caller reads, as
// run-with-flags reports it.
function run(inputOrRaw, options = {}) {
  if (options.truncated) return { exitCode: 2, stderr: OVER_LIMIT };
  try {
    return judgeCommand(inputOrRaw);
  } catch (error) {
    if (error instanceof ProgramUnreadable) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${error.message}.` };
    throw error;
  }
}

function judgeCommand(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = input?.tool_input?.command;
  if (!command || typeof command !== 'string') return { exitCode: 0 };

  const extracted = extractSegments(command);
  if (extracted === null) {
    return {
      exitCode: 2,
      stderr:
        'EGC Guardian BLOCKED this command: nested command/process substitutions ' +
        'go deeper than this validator can safely unwrap and analyze. Simplify the ' +
        'command so every substitution can be validated.',
    };
  }
  if (extracted.length === 0) return { exitCode: 0 };

  // A command word that comes from an expansion is judged by every value it
  // can take (X=rm; $X -rf / -> rm -rf /; an empty $X hands the command to
  // the next word), and fails closed when that value cannot be read.
  const bindings = bindingsOfSegments(extracted);
  const words = resolveCommandWords(extracted, bindings, true);
  if (words.blocked) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${words.blocked}.` };
  const reread = secondReadings(command, bindings, true);
  if (reread.blocked) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${reread.blocked}.` };
  const segments = [...words.segments, ...reread.segments];

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
  const scripts = scriptSegmentsOf(segments, cwd, 0, new Set(), commandContext(segments, cwd, bindings));
  if (scripts.blocked) {
    return {
      exitCode: 2,
      stderr: `EGC Guardian BLOCKED this command: ${scripts.blocked}.`,
    };
  }
  const committed = [...segments.map(() => false), ...scripts.committed];
  // A segment is judged in every directory a cd before it can have left it
  // in (`cd dir && git status` runs git in dir), a script's from where the
  // script runs; code the line reads after expanding, and a segment after a
  // move only the running shell knows, where the line starts.
  const cwds = [...segments.map((_, i) => (i < words.segments.length ? scripts.places[i] ?? null : null)), ...scripts.collectedPlaces];
  segments.push(...scripts.segments);
  const answer = callGuardianVerdict(
    cli,
    ['command-batch'],
    JSON.stringify({ commands: segments, cwd, cwds, committed }),
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

module.exports = { run, extractSegments, isAdvisory, bindingsOfSegments, gitIn, ProgramUnreadable };

if (require.main === module) {
  readHookInput(({ raw, truncated }) => {
    const result = run(raw, { truncated });
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}
