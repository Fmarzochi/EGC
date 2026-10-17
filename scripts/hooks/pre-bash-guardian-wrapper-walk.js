'use strict';

// Skips environment assignments, wrappers (sudo, env, unshare...), shell
// keywords and other command carriers to find where a segment's real
// command starts, tracking any chdir/chroot a wrapper applies along the
// way. Part of the pre-bash-guardian-validate.js split (#1712).

const path = require('node:path');
const { WRAPPER_SPECS, SHELL_KEYWORDS, readWrapperOption, runnerCommandStart, commandName } = require('../lib/wrapper-options');

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
// actually run, as the validator peels them (validator-unwrap.ts
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

module.exports = { skipEnvAndWrappers };
