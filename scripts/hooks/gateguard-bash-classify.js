'use strict';

const path = require('node:path');
const { splitShellSegments, extractSubstitutionBodies } = require('../lib/shell-split');
const { WRAPPER_SPECS, readWrapperOption } = require('../lib/wrapper-options');

function commandWord(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.split(/[\\/]/).pop();
}

// One pattern per destructive command, anchored: these name the command being
// run, so they only count at the head of a segment, after wrappers and with
// quotes removed. Tested against the raw text, as they were before, they also
// fired on a grep pattern, a commit message and a heredoc body that merely
// named the command, and a gate that cries wolf is one people walk around.
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /^rm\s+-rf\b/i,
  /^git\s+reset\s+--hard\b/i,
  // The pathspec form and the two merge sides all overwrite the working file.
  /^git\s+checkout\s+(--(\s|$)|--ours\b|--theirs\b|-f\b|--force\b)/i,
  /^git\s+clean\s+-f/i,
  /^git\s+push\s+--force(?!-with-lease)\b/i,
  /^git\s+commit\s+--amend\b/i,
  /^dd\s+if=/i,
];

// These name what a command carries rather than the command itself: SQL
// reaches the database as an argument or through a heredoc, so it is read
// wherever it sits.
const DESTRUCTIVE_CONTENT_PATTERNS = [
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\b/i,
];

// Words that stand in front of the command they run, read by the Guardian
// validator's own wrapper tables (scripts/lib/wrapper-options.js).
// Wrapper options that make the wrapper answer for itself and exit, so the
// words after them are never executed and classify nothing.
const TERMINATING_WRAPPER_FLAGS = new Set(['-V', '--version', '--help']);
const HELP_H = new Set(['-h']);
const TERMINATING_BY_WRAPPER = {
  sudo: new Set(['-v', '--validate', '-l', '--list']),
  command: new Set(['-v', '-V']),
  doas: new Set(['-L']),
  parallel: HELP_H, setsid: HELP_H, taskset: HELP_H, chrt: HELP_H, unshare: HELP_H, nsenter: HELP_H, prlimit: HELP_H, runuser: HELP_H,
};
// numactl's -V is --verify, which runs the command.
const RUNNING_BY_WRAPPER = { numactl: new Set(['-V']) };
const ENV_ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;

// The words of a line as the shell would see them: quotes group and then
// disappear, a backslash escapes the next character.
function shellWordsOf(line) {
  const words = [];
  let word = '';
  let quote = null;
  let open = false;
  const flush = () => {
    if (open || word) words.push(word);
    word = '';
    open = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      word += line[i + 1];
      i += 1;
      open = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
      open = true;
    }
  }
  flush();
  return words;
}

function isTerminating(name, word, names) {
  return [word, ...names].some((flag) => !RUNNING_BY_WRAPPER[name]?.has(flag)
    && (TERMINATING_WRAPPER_FLAGS.has(flag) || TERMINATING_BY_WRAPPER[name]?.has(flag)));
}

// taskset -p and chrt -p (--pid, which getopt_long also takes as any prefix
// down to --p) act on a process that is already running: the words after
// them are its mask or priority and its pid, and no command is run.
const PID_MODE_WRAPPERS = new Set(['taskset', 'chrt']);

function isPidMode(name, word, names) {
  if (!PID_MODE_WRAPPERS.has(name)) return false;
  if (word.startsWith('--')) return word.length >= 3 && '--pid'.startsWith(word.split('=', 1)[0]);
  return names.includes('-p');
}

// The index of the first word after a wrapper's own options and the
// positionals it takes (timeout's duration, flock's lock file, chrt's
// priority when it is a number); -1 when an option ends the wrapper's work
// (`sudo -v`, `timeout --help`) and no command follows.
function skipWrapperOptions(words, start, name) {
  let i = start;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-') {
      if (WRAPPER_SPECS[name].loneDashIsOption) i += 1;
      break;
    }
    const option = readWrapperOption(name, words[i], words[i + 1]);
    if (isTerminating(name, words[i], option.names) || isPidMode(name, words[i], option.names)) return -1;
    i += option.width;
  }
  const spec = WRAPPER_SPECS[name];
  let skip = spec.leadingPositionals ?? 0;
  while (skip > 0 && i < words.length && (!spec.positionalWhen || spec.positionalWhen.test(words[i]))) {
    i += 1;
    skip -= 1;
  }
  return i;
}

// What a segment actually runs: its command line (a backslash-newline is a
// continuation and joins; a heredoc body follows a real newline and is data),
// dequoted, with leading environment assignments and wrapper commands dropped,
// options and values included, so the real command sits at position zero.
function commandLineOf(segment) {
  const joined = segment.replace(/\\\n\s*/g, ' ');
  const words = shellWordsOf(joined.split('\n', 1)[0]);
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ENV_ASSIGNMENT_RE.test(word)) { i += 1; continue; }
    const name = path.basename(word);
    if (!Object.hasOwn(WRAPPER_SPECS, name)) break;
    // A wrapper carries its own options (`sudo -u root`, `xargs -n1 -I{}`)
    // and sometimes a mandatory value (`timeout 30`): skipping only the word
    // itself left the wrapper's first option in command position and the real
    // command unread.
    i = skipWrapperOptions(words, i + 1, name);
    if (i < 0) return '';
  }
  return words.slice(i).join(' ');
}

// Every place a segment can hide a command the shell runs: the pipeline
// stages, and the bodies of command substitutions.
function commandLinesOf(command) {
  const segments = [
    ...splitShellSegments(command, { splitOnPipe: true }),
    ...extractSubstitutionBodies(command).flatMap((body) => splitShellSegments(body, { splitOnPipe: true })),
  ];
  return segments.map(commandLineOf);
}

// The wording of the destructive gate's own messages: what anchors a
// destructive retry, so a file denial that happens to mention a rollback
// never does.
const DESTRUCTIVE_ANCHORS = ['destructive command detected', 'retry for this command'];

function isDestructiveBash(command) {
  if (DESTRUCTIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return commandLinesOf(command)
    .some((line) => DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(line)));
}

const SAFE_GIT_SUBCOMMANDS = {
  status: (args) => args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg)),
  diff: (args) => args.length <= 1 && args.every(arg => ['--name-only', '--name-status'].includes(arg)),
  log: (args) => args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg)),
  show: (args) => args.length === 1 && !args[0].startsWith('--') && /^[a-zA-Z0-9._:/-]+$/.test(args[0]),
  branch: (args) => args.length === 1 && args[0] === '--show-current',
  'rev-parse': (args) => args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]),
};

function isReadOnlyGitIntrospection(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'git' || tokens.length < 2) return false;

  const checker = SAFE_GIT_SUBCOMMANDS[tokens[1].toLowerCase()];
  return checker ? checker(tokens.slice(2)) : false;
}

// The Bash-command-shaped slice of the gateguard-fact-force.js split (part
// of #1712): shell-word parsing, wrapper-skipping and the destructive and
// read-only-git-introspection classifiers it already had, moved as is.
module.exports = {
  DESTRUCTIVE_ANCHORS,
  commandWord,
  isDestructiveBash,
  isReadOnlyGitIntrospection,
};
