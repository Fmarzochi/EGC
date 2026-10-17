import fs from 'node:fs';
import path from 'node:path';
import { flagsInCommittedScript, type ValidationResult } from './validator-session.js';
import { redirectionsOf, type ShellWord } from './validator-shell-text.js';
import { expandHome, writeBaseDir } from './validator-path-utils.js';
import { isProtectedPath, isReadDeniedPath } from './validator-protected-paths.js';
import { targetSpellings } from './validator-line-values.js';

// A shell script, to the writes judged here: a file named like one, or an
// existing file whose first line runs a POSIX shell. The Write and Edit
// tools judge what such a file will run through the write hook; the shell's
// own ways of writing one would skip that judgment, so they are refused.
const SHELL_SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh']);
const SHELL_SHEBANG_RE = /^#![^\n]*\b(?:sh|bash|zsh|ksh|dash|ash)\b/;

function isShellScriptTarget(target: string, cwd?: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (SHELL_SCRIPT_EXTENSIONS.has(path.extname(trimmed).toLowerCase())) return true;
  let fd: number | undefined;
  try {
    const resolved = path.resolve(writeBaseDir(cwd), expandHome(trimmed));
    if (!fs.statSync(resolved).isFile()) return false;
    fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(128);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return SHELL_SHEBANG_RE.test(head.subarray(0, read).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A denial of what would run later without being judged: flagged, not
// refused, in a committed script.
function laterRunDenial(reason: string): ValidationResult | null {
  const denial: ValidationResult = { allowed: false, reason, trust_level: 'DANGEROUS' };
  return flagsInCommittedScript(denial) ? null : denial;
}

function scriptWriteDenial(writer: string, target: string): ValidationResult | null {
  return laterRunDenial(`${writer} writes the shell script '${target}'; a script gets its content only through the Write or Edit tool, where the commands it will run are judged`);
}

// A cluster of short options (`-sSo file`): the flag letters before the
// first letter that takes a value, that letter, and its value, the rest of
// the word or else the next word.
interface ShortCluster { flags: string; letter: string | null; value: string | null; takesNext: boolean }

function readCluster(arg: string, next: string | undefined, valueLetters: string): ShortCluster {
  for (let k = 1; k < arg.length; k += 1) {
    if (!valueLetters.includes(arg[k])) continue;
    const rest = arg.slice(k + 1);
    return { flags: arg.slice(1, k), letter: arg[k], value: rest === '' ? next ?? null : rest, takesNext: rest === '' };
  }
  return { flags: arg.slice(1), letter: null, value: null, takesNext: false };
}

const isShortCluster = (arg: string): boolean => arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--');

// sed's options that take a value: -e and -f give its script, -l a length.
const SED_VALUE_LETTERS = 'efl';
const SED_LONG_VALUE_OPTIONS = new Set(['--expression', '--file', '--line-length']);

// sed edits in place with -i (alone, with a suffix, or in a cluster of short
// options) or --in-place.
function isInPlaceSed(args: string[]): boolean {
  return args.some(arg => arg === '--in-place' || arg.startsWith('--in-place=') || (isShortCluster(arg) && readCluster(arg, undefined, SED_VALUE_LETTERS).flags.includes('i')));
}

// A cluster with its -i suffix (`-i.bak`, `-Ei~`) dropped, so the suffix is
// not read as options.
function withoutInPlaceSuffix(arg: string): string {
  if (!isShortCluster(arg)) return arg;
  const at = readCluster(arg, undefined, SED_VALUE_LETTERS).flags.indexOf('i');
  return at < 0 ? arg : arg.slice(0, at + 2);
}

// The files sed -i edits: its operands, the first one aside when that is
// the script (no -e or -f gave it).
function sedEditedFiles(args: string[]): string[] {
  if (!isInPlaceSed(args)) return [];
  const words = args.filter((_, i) => !SED_LONG_VALUE_OPTIONS.has(args[i - 1])).map(withoutInPlaceSuffix);
  const { values, operands } = readOptions(words, SED_VALUE_LETTERS);
  const scripted = values.has('e') || values.has('f') || hasLongOption(args, ['expression', 'file']);
  return scripted ? operands : operands.slice(1);
}

// cp, install and ln write their last operand, or, where that is a directory
// (named with -t, or one that exists or ends in a separator), a file there
// named as each source is; ln given only a target links it here.
const COPYING_COMMANDS = new Set(['cp', 'install', 'ln']);
// Their long options that take the next word as a value, and the short ones
// that take the rest of their word, or the next word.
const COPY_LONG_VALUE_OPTIONS = new Set(['--mode', '--owner', '--group', '--suffix', '--target-directory']);
const COPY_VALUE_LETTERS = 'mogSt';

function copyWords(args: string[]): { operands: string[]; directory: string | null } {
  const words = args.filter((_, i) => !COPY_LONG_VALUE_OPTIONS.has(args[i - 1]));
  const { values, operands } = readOptions(words, COPY_VALUE_LETTERS);
  const directories = [...(values.get('t') ?? []), ...longOptionValues(args, ['target-directory'])];
  return { operands, directory: directories.at(-1) ?? null };
}

function isDirectoryTarget(target: string, cwd?: string): boolean {
  if (target.endsWith('/') || target.endsWith('\\')) return true;
  try {
    return fs.statSync(path.resolve(writeBaseDir(cwd), expandHome(target))).isDirectory();
  } catch {
    return false;
  }
}

interface Copy { source: string; destination: string }

// What cp, install and ln make of each source: a copy or a link of it, at
// the destination it gets.
function copies(baseCommand: string, args: string[], cwd?: string): Copy[] {
  const { operands, directory } = copyWords(args);
  const into = (dir: string, sources: string[]) => sources.map(source => ({ source, destination: path.join(dir, path.basename(source)) }));
  if (directory !== null) return into(directory, operands);
  if (operands.length < 2) return baseCommand === 'ln' ? operands.map(source => ({ source, destination: path.basename(source) })) : [];
  const destination = operands.at(-1) ?? '';
  const sources = operands.slice(0, -1);
  return isDirectoryTarget(destination, cwd) ? into(destination, sources) : sources.map(source => ({ source, destination }));
}

// A copy or a link of a shell script is a shell script too, whatever its
// new name.
function copiedScript(baseCommand: string, args: string[], cwd?: string): string | undefined {
  const copy = copies(baseCommand, args, cwd).find(({ source, destination }) => isShellScriptTarget(destination, cwd) || isShellScriptTarget(source, cwd));
  return copy?.destination;
}

// A command's short options, read cluster by cluster: the flag letters set,
// the values each value-taking letter was given, and the words that are
// neither (long options aside).
function readOptions(args: string[], valueLetters: string): { flags: string; values: Map<string, string[]>; operands: string[] } {
  let flags = '';
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!isShortCluster(arg)) {
      if (!arg.startsWith('--')) operands.push(arg);
      continue;
    }
    const cluster = readCluster(arg, args[i + 1], valueLetters);
    flags += cluster.flags;
    if (cluster.letter !== null) values.set(cluster.letter, [...(values.get(cluster.letter) ?? []), cluster.value ?? '']);
    if (cluster.takesNext) i += 1;
  }
  return { flags, values, operands };
}

// The values long options are given: `--name value` and `--name=value`.
function longOptionValues(args: string[], names: string[]): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    for (const name of names) {
      if (arg === `--${name}`) values.push(args[i + 1] ?? '');
      else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3));
    }
  });
  return values;
}

const hasLongOption = (args: string[], names: string[]): boolean => args.some(arg => names.some(name => arg === `--${name}` || arg.startsWith(`--${name}=`)));

// The name a download keeps when no output is named: the last part of the
// URL's path, a URL without a scheme being taken as http, as both tools do.
function urlFileNames(words: string[]): string[] {
  return words.map(word => {
    try {
      return path.posix.basename(new URL(word.includes('://') ? word : `http://${word}`).pathname);
    } catch {
      return path.posix.basename(word.split(/[?#]/)[0]);
    }
  });
}

// What a download writes: the files the command line names, and whether the
// server or a list the command reads names others, which it does not show.
interface DownloadWrites { files: string[]; namesUnseen: boolean }

// The short options of curl and wget that take a value (wget's -n takes the
// letter after it: -nv, -np).
const CURL_VALUE_LETTERS = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
const WGET_VALUE_LETTERS = 'aABDeiIlnOoPQRtTUwX';

// curl writes -o, its headers (-D) and cookies (-c), its traces and logs,
// and with -O the URL's own name, or with -J one the server sends; a config
// file (-K) may name any of them.
function curlWrites(args: string[]): DownloadWrites {
  const { flags, values, operands } = readOptions(args, CURL_VALUE_LETTERS);
  const named = ['o', 'D', 'c'].flatMap(letter => values.get(letter) ?? []);
  const files = [...named, ...longOptionValues(args, ['output', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'libcurl', 'etag-save'])];
  const remoteName = flags.includes('O') || hasLongOption(args, ['remote-name', 'remote-name-all']);
  const serverNamed = remoteName && (flags.includes('J') || hasLongOption(args, ['remote-header-name']));
  const configured = values.has('K') || hasLongOption(args, ['config']);
  return { files: remoteName ? [...files, ...urlFileNames(operands)] : files, namesUnseen: serverNamed || configured };
}

// wget writes -O and its log (-o, -a), or else each URL's own name, unless
// recursion, an input list or the server picks the names; a wgetrc command
// (-e) or file (--config) may name any of them.
function wgetWrites(args: string[]): DownloadWrites {
  const { flags, values, operands } = readOptions(args, WGET_VALUE_LETTERS);
  const configured = values.has('e') || hasLongOption(args, ['execute', 'config']);
  const documents = [...(values.get('O') ?? []), ...longOptionValues(args, ['output-document'])];
  const logs = [...['o', 'a'].flatMap(letter => values.get(letter) ?? []), ...longOptionValues(args, ['output-file', 'append-output'])];
  if (documents.length > 0) return { files: [...documents, ...logs], namesUnseen: configured };
  const listed = values.has('i') || /[rmp]/.test(flags) || hasLongOption(args, ['input-file', 'recursive', 'mirror', 'page-requisites', 'content-disposition', 'trust-server-names']);
  return { files: [...logs, ...urlFileNames(operands)], namesUnseen: listed || configured };
}

function downloadVerdict(baseCommand: string, args: string[], cwd?: string): ValidationResult | null {
  const { files, namesUnseen } = baseCommand === 'wget' ? wgetWrites(args) : curlWrites(args);
  if (namesUnseen) {
    return laterRunDenial(`'${baseCommand}' here lets the server, a list or a config name the files it writes, so one may be a shell script the Guardian never sees; name the output (curl -o, wget -O) on the command line instead`);
  }
  const script = files.find(target => isShellScriptTarget(target, cwd));
  return script === undefined ? null : scriptWriteDenial(`'${baseCommand}'`, script);
}

function writtenFiles(baseCommand: string, args: string[]): string[] {
  if (baseCommand === 'tee') return readOptions(args, '').operands;
  if (baseCommand === 'sed') return sedEditedFiles(args);
  return [];
}

const DOWNLOADERS = new Set(['curl', 'wget']);

export function scriptWriteVerdict(baseCommand: string, args: string[], cwd?: string): ValidationResult | null {
  if (DOWNLOADERS.has(baseCommand)) return downloadVerdict(baseCommand, args, cwd);
  const script = COPYING_COMMANDS.has(baseCommand)
    ? copiedScript(baseCommand, args, cwd)
    : writtenFiles(baseCommand, args).find(target => isShellScriptTarget(target, cwd));
  return script === undefined ? null : scriptWriteDenial(`'${baseCommand}'`, script);
}

// A job handed to cron or at runs later, outside every check here, so
// scheduling one is the user's call; listing what is scheduled is not.
const SCHEDULERS = new Set(['crontab', 'at', 'batch']);

function onlyListsJobs(baseCommand: string, args: string[]): boolean {
  if (baseCommand === 'crontab') {
    const rest = args.filter((arg, i) => !arg.startsWith('-u') && args[i - 1] !== '-u');
    return rest.length === 1 && rest[0] === '-l';
  }
  return baseCommand === 'at' && (args[0] === '-l' || args[0] === '-c');
}

export function schedulerVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  if (!SCHEDULERS.has(baseCommand) || onlyListsJobs(baseCommand, args)) return null;
  return laterRunDenial(`'${baseCommand}' hands a job to the scheduler, which runs it later without the Guardian judging it; scheduling one is the user's call`);
}

function redirectedScriptVerdict(target: ShellWord, cwd?: string): ValidationResult | null {
  const script = targetSpellings(target).find(spelling => isShellScriptTarget(spelling, cwd));
  return script === undefined ? null : scriptWriteDenial('redirecting output', script);
}

export function redirectionVerdict(command: string, cwd?: string): ValidationResult | null {
  for (const { target, writes } of redirectionsOf(command)) {
    const denies = writes ? isProtectedPath : isReadDeniedPath;
    const denied = targetSpellings(target).find(spelling => denies(spelling, cwd));
    if (denied === undefined) {
      const scriptDenial = writes ? redirectedScriptVerdict(target, cwd) : null;
      if (scriptDenial) return scriptDenial;
      continue;
    }
    const denial: ValidationResult = {
      allowed: false,
      reason: writes
        ? `redirecting output onto protected file '${denied}' is forbidden: the command would write over it, so send the output to another path`
        : `redirecting input from protected file '${denied}' is forbidden: it would hand the command a credential, so read another file`,
      trust_level: 'DANGEROUS',
    };
    if (writes || !flagsInCommittedScript(denial)) return denial;
  }
  return null;
}
