import os from 'node:os';
import path from 'node:path';
import { session } from './validator-session.js';
import { tokenizeWords, shellWord, skipText, closingParenthesis } from './validator-shell-text.js';
import { expandHome } from './validator-path-utils.js';
import { isProtectedPath } from './validator-protected-paths.js';
import { pathCandidatesOf, isProtectedOperand } from './validator-line-values.js';

// Where a delete, move or overwrite in a committed script is grave: a
// protected path, the filesystem root, the home directory, the directory
// that holds it, a directory right under the root, or everything inside
// one of them (`/*`, `~/*`). `dd of=...` names its target after the `=`.
// In a committed script a delete, move or overwrite is flagged only when
// its target is known to be narrow: a literal path below the directory the
// script stands in (not climbing out with `..`, a pattern with a literal
// part), a literal path inside a temporary directory or at least two levels
// down the home, or a variable the script itself sets to a file (`bound`).
// Anything else, a path the caller or the environment chooses included, is
// grave. dd names what it writes as `of=`; its `if=` is only read.
export function isGraveTarget(arg: string, cwd?: string): boolean {
  return pathCandidatesOf([arg])
    .map(candidate => (candidate.startsWith('of=') ? candidate.slice(3) : candidate))
    .some(candidate => !isNarrowTarget(candidate, cwd));
}

// `$NAME` or `${NAME}` leading a target, and what follows it.
const VARIABLE_TARGET_RE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/;

function isNarrowTarget(candidate: string, cwd?: string): boolean {
  const variable = VARIABLE_TARGET_RE.exec(candidate);
  if (variable) {
    const rest = candidate.slice(variable[0].length);
    const values = session.committedBound.get(variable[1] ?? variable[2]) ?? [];
    if (values.length === 0 || (rest !== '' && !/^[\\/]/.test(rest)) || /[$`*?[]/.test(rest)) return false;
    return values.every(value => isNarrowValue(value + rest, cwd));
  }
  if (/[$`]/.test(candidate) || isProtectedOperand(candidate, cwd)) return false;
  const expanded = expandHome(withHomeSpelled(candidate));
  return path.isAbsolute(expanded) ? isNarrowAbsolute(path.resolve(expanded)) : isNarrowRelative(expanded);
}

// A value a committed script sets a variable to is narrow when it is a
// fresh temporary path (`$(mktemp ...)`), a narrow literal path, a path
// below another variable the script sets whose every value keeps it narrow
// (`BASE=/; tmp=$BASE/etc/passwd` is /etc/passwd), or otherwise ends in at
// least two literal components below whatever it starts from (a named file
// deep in some directory, as `$BASE/.mvn/wrapper/maven-wrapper.jar`).
const MAX_BOUND_DEPTH = 4;

// What follows `$(mktemp ...)` or backquoted mktemp given nothing but options
// and a template; null for anything else, such as a second command after it
// (`$(mktemp -d >/dev/null; printf /etc)` prints /etc).
function freshTempRest(value: string): string | null {
  const open = ['$(', '`'].find(prefix => value.startsWith(`${prefix}mktemp`));
  if (open === undefined) return null;
  const close = value.indexOf(open === '$(' ? ')' : '`', open.length);
  if (close === -1) return null;
  const args = value.slice(open.length + 'mktemp'.length, close);
  if (args !== '' && !/^\s/.test(args)) return null;
  return mktempPrintsAPath(tokenizeWords(args)) ? value.slice(close + 1) : null;
}

const MKTEMP_VALUE_OPTIONS = new Set(['-p', '--tmpdir', '--suffix']);

// Whether mktemp given these words prints nothing but a fresh path: words
// of plain characters or quoted, never another command, never --help or
// --version (whose text, split into words, names real paths). A parameter
// expansion may only sit in a double-quoted template (it holds XXX) or in
// the value of an option, where its value can never turn into an option.
function mktempPrintsAPath(words: string[]): boolean {
  return words.every((word, i) => {
    if (/[`;&|<>()]/.test(word) || isHelpOrVersion(shellWord(word))) return false;
    if (!word.includes('$')) return /^(?:[\w./%=+,:@-]|"[^"]*"|'[^']*')+$/.test(word);
    return /^"[^"`]*"$/.test(word) && (word.includes('XXX') || MKTEMP_VALUE_OPTIONS.has(words[i - 1] ?? ''));
  });
}

function isHelpOrVersion(word: string): boolean {
  const name = word.split('=', 1)[0];
  return name.length >= 3 && ['--help', '--version'].some(option => option.startsWith(name));
}

// The directories at the root of a system whose contents a delete must never
// reach, compared without case.
const ROOT_SYSTEM_DIRS = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'usr', 'var', 'home',
  'snap', 'mnt', 'media', 'nix', 'private', 'system', 'library', 'applications', 'users', 'volumes', 'windows', 'program files', 'programdata',
]);

// What follows a fresh temporary path stays inside it, and names nothing
// grave where mktemp fails and prints nothing, which leaves it read from the
// root (`$(mktemp -d)/usr/lib` is /usr/lib then, `$(mktemp -d)/build` is
// /build): nothing, or a narrow tail of literal components that neither
// climb out nor start in a system directory.
function staysInFreshTemp(rest: string): boolean {
  if (rest === '') return true;
  const tail = shellWord(rest);
  const parts = literalParts(tail);
  return parts !== null && !ROOT_SYSTEM_DIRS.has(parts[0]?.toLowerCase() ?? '') && isNarrowTail(tail);
}

function isNarrowValue(value: string, cwd?: string, depth = 0): boolean {
  const tempRest = freshTempRest(value);
  if (tempRest !== null) return staysInFreshTemp(tempRest);
  if (!/[$`]/.test(value)) return isNarrowTarget(value, cwd);
  const variable = VARIABLE_TARGET_RE.exec(value);
  const prefixes = variable ? session.committedBound.get(variable[1] ?? variable[2]) ?? [] : [];
  if (variable && prefixes.length > 0) {
    if (depth >= MAX_BOUND_DEPTH) return false;
    const rest = value.slice(variable[0].length);
    return prefixes.every(prefix => isNarrowValue(prefix + rest, cwd, depth + 1));
  }
  return hasNarrowLiteralTail(value);
}

// At least two literal components at the end of a path whose start is only
// known when the script runs, naming no protected path whether that start is
// the root or the home directory (`$(cd ~ && pwd)/.ssh/id_rsa` is grave).
// The components are counted only after the last expansion closes, so a
// slash inside a substitution (`$(printf /tmp/x/.env)`) is not one of them.
function hasNarrowLiteralTail(value: string): boolean {
  return isNarrowTail(shellWord(afterLastExpansion(value)));
}

// A path below a start that is unknown or may be empty, as the shell hands
// it over (quotes and escapes resolved): at least two components, every one
// literal, with no glob, no expansion and no `..`, naming no protected path
// from the root or from the home directory.
function isNarrowTail(rest: string): boolean {
  const parts = literalParts(rest);
  return parts !== null && parts.length >= 2 && namesNoProtectedPath(parts);
}

// The components of a path that continues below something else (it starts
// with a separator), when every one is literal: no glob, no expansion, no
// `.` or `..`. null otherwise.
function literalParts(rest: string): string[] | null {
  if (!/^[\\/]/.test(rest)) return null;
  const parts = rest.split(/[\\/]/).filter(Boolean);
  return parts.some(part => /[$`*?[]/.test(part) || part === '.' || part === '..') ? null : parts;
}

// Whether these components name no protected path read from the root or
// from the home directory.
function namesNoProtectedPath(parts: string[]): boolean {
  const tail = parts.join('/');
  return !isProtectedPath(`/${tail}`) && !isProtectedPath(path.join(os.homedir(), tail));
}

// What a value holds after its last `$NAME`, `${...}`, `$(...)` or
// backquoted command.
function afterLastExpansion(value: string): string {
  let start = 0;
  let i = 0;
  while (i < value.length) {
    const end = expansionEnd(value, i);
    if (end === null) {
      i += value[i] === '\\' ? 2 : 1;
    } else {
      start = end;
      i = end;
    }
  }
  return value.slice(start);
}

// Index past the expansion opening at `i`; null when none opens there.
function expansionEnd(value: string, i: number): number | null {
  if (value[i] === '`') {
    const close = value.indexOf('`', i + 1);
    return close === -1 ? value.length : close + 1;
  }
  if (value[i] !== '$') return null;
  if (value[i + 1] === '(') return Math.min(closingParenthesis(value, i + 2) + 1, value.length);
  if (value[i + 1] === '{') return skipText(value, i);
  const name = /^(?:[A-Za-z_]\w*|[\d@*#?$!-])/.exec(value.slice(i + 1));
  return name ? i + 1 + name[0].length : null;
}

// A glob component with no literal part of its own (`*`, `.*`, `[a-z]*`)
// matches everything in its directory.
function isNarrowPattern(component: string): boolean {
  if (!/[*?[]/.test(component)) return true;
  let literal = '';
  let inBracket = false;
  for (const ch of component) {
    if (inBracket) inBracket = ch !== ']';
    else if (ch === '[') inBracket = true;
    else literal += ch;
  }
  return /[^.*?]/.test(literal);
}

function isNarrowRelative(target: string): boolean {
  const parts = target.split(/[\\/]/).filter(part => part !== '' && part !== '.');
  return parts.length > 0 && !parts.includes('..') && isNarrowPattern(parts[0]);
}

function isNarrowAbsolute(resolved: string): boolean {
  const home = os.homedir();
  if (isDevice(resolved) || resolved === home || home.startsWith(resolved + path.sep)) return false;
  const below = (base: string): string[] | null => {
    const relative = path.relative(base, resolved);
    return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? null : relative.split(/[\\/]/);
  };
  // The home rule comes first: a home directory may itself sit under /tmp.
  const inHome = below(home);
  if (inHome !== null) return inHome.length >= 2 && !/[*?[]/.test(inHome[0]) && isNarrowPattern(inHome[1]);
  const temporary = [os.tmpdir(), '/tmp', '/var/tmp'].map(base => below(path.resolve(base))).find(parts => parts !== null);
  return temporary !== undefined && isNarrowPattern(temporary[0]);
}

// Devices a script may name without touching a disk.
const HARMLESS_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);

function isDevice(resolved: string): boolean {
  if (process.platform === 'win32' || !resolved.startsWith('/dev/')) return false;
  return !HARMLESS_DEVICES.has(resolved) && !resolved.startsWith('/dev/fd/');
}

// ${HOME:?}, ${HOME:-x} and the like still name the home directory; ~name
// names that user's.
function withHomeSpelled(target: string): string {
  let spelled = target;
  const close = spelled.indexOf('}');
  if (spelled.startsWith('${HOME') && close !== -1 && '}:-?=+#%/'.includes(spelled[6])) spelled = `$HOME${spelled.slice(close + 1)}`;
  if (!spelled.startsWith('~') || spelled.length === 1 || spelled[1] === '/' || spelled[1] === '\\') return spelled;
  const separator = spelled.search(/[\\/]/);
  const name = separator === -1 ? spelled.slice(1) : spelled.slice(1, separator);
  return path.join(path.dirname(os.homedir()), name, separator === -1 ? '' : spelled.slice(separator));
}
