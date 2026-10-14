'use strict';

// Resolves the script FILE a command or interpreter actually runs: operand
// paths, shebang/binary detection, environment-wrapper option parsing,
// the files a segment writes, and whether a script is an unchanged git
// commit (so it is judged only by the grave denials). Part of the
// pre-bash-guardian-validate.js split (#1712).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { commandName } = require('../lib/wrapper-options');
const { takesTarget, isRuntimeOnly, isStdinPath } = require('../lib/stdin-programs');
const { shellWords, SHELL_INTERPRETERS, consumedAsOptionValue, noteShellOption } = require('./pre-bash-guardian-shell-words');
const { skipEnvAndWrappers } = require('./pre-bash-guardian-wrapper-walk');
const { extractSegments } = require('./pre-bash-guardian-segmentation');

const MAX_SCRIPT_BYTES = 512 * 1024;
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

// The git calls of one judgement share one budget, inside the 30 seconds
// the hook runner gives the whole hook: a loaded runner that takes longer
// than a fixed two seconds for one call (the Windows lane of 2026-10-08) is
// no reason to judge a committed script as if it were written moments ago.
// Once the budget is spent, the calls left are not made and the script is
// judged in full, as a script outside a repository is.
const GIT_BUDGET_MS = 15000;
// The budget of the judgement under way: the git time it has left. Only the
// time git itself takes is deducted, so the validator and the reads of the
// hook never eat into it.
let gitBudget = null;

// Runs `work` with one git budget for every gitIn it makes, and ends the
// budget after it. A budget opened inside another never has more than the
// outer one has left, and what it spends is spent for the outer one too. A
// call outside any budget gets the whole budget for itself.
function withGitBudget(work, budgetMs = GIT_BUDGET_MS) {
  const previous = gitBudget;
  const inner = { left: previous === null ? budgetMs : Math.min(previous.left, budgetMs) };
  const opened = inner.left;
  gitBudget = inner;
  try {
    return work();
  } finally {
    if (previous !== null) previous.left -= opened - inner.left;
    gitBudget = previous;
  }
}

// git run to read, never to act: the variables that point it at another
// repository are dropped and fsmonitor, the one command the repository's
// config could have these subcommands start, is switched off.
function gitIn(dir, args) {
  const budget = gitBudget ?? { left: GIT_BUDGET_MS };
  if (budget.left <= 0) return null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const started = Date.now();
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { // NOSONAR javascript:S4036 -- the user's own git knows their repositories; fixed argv, no shell
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: budget.left,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  budget.left -= Date.now() - started;
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

module.exports = {
  SCRIPT_DIR_IDIOMS,
  scriptOperandsOf,
  writesOf,
  expandedOperandValue,
  scriptRelative,
  nestedSegmentsOf,
  isCommittedUnchanged,
  withGitBudget,
  gitIn,
};
