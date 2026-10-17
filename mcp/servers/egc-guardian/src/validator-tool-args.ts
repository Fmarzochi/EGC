import os from 'node:os';
import { FIND_ACTION_FLAGS } from './validator-allowlists.js';
import { session, flagsInCommittedScript, readDenial, type ValidationResult } from './validator-session.js';
import { bareToken, stripQuotes, embeddedPathCandidate } from './validator-tokens.js';
import { INLINE_EVAL_COMMANDS, matchesEvalFlag } from './validator-eval.js';
import { pathSpellings, isProtectedOperand, isReadDeniedOperand } from './validator-line-values.js';
import { isGraveTarget } from './validator-narrow-target.js';
import { validateCommandVerdict } from './validator.js';

function grepIsRecursive(args: string[]): boolean {
  // combined short flags: -rn, -Rn, -rl, etc.
  return args.some(a => a === '-r' || a === '-R' || a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a));
}

// The FILE operand of a -f/--file flag: undefined when the argument is not a
// file flag, null when it is one but the operand is missing, the operand
// itself otherwise.
function grepFileFlagValue(arg: string, next: string | undefined): string | null | undefined {
  if (arg === '-f' || arg === '--file') return next ?? null;
  if (arg.startsWith('--file=')) return arg.slice('--file='.length);
  if (arg.startsWith('-f') && arg.length > 2) return arg.slice(2);
  return undefined;
}

function isGrepPatternFlag(arg: string): boolean {
  return arg === '-e' || arg === '--regexp' || arg.startsWith('--regexp=') || (arg.startsWith('-e') && arg.length > 2);
}

// -f/--file makes grep read its patterns from a FILE, so that value is a
// real filesystem read target and must pass the protected-path check even
// though it is not positional. It also means the pattern did not consume
// the first positional slot (the same is true of -e/--regexp).
function collectGrepPatternFlags(args: string[]): { fileFlagValues: string[]; patternViaFlag: boolean } {
  const fileFlagValues: string[] = [];
  let patternViaFlag = false;
  for (let i = 0; i < args.length; i++) {
    const fileValue = grepFileFlagValue(args[i], args[i + 1]);
    if (fileValue !== undefined) {
      if (fileValue !== null) fileFlagValues.push(fileValue);
      patternViaFlag = true;
    } else if (isGrepPatternFlag(args[i])) {
      patternViaFlag = true;
    }
  }
  return { fileFlagValues, patternViaFlag };
}

function checkRecursiveGrepPaths(pathArgs: string[], positionalArgs: string[], cwd?: string): ValidationResult | null {
  const home = os.homedir();
  for (const p of pathArgs) {
    const covers = pathSpellings(p).some(s => s === '/' || s === home) || isProtectedOperand(p, cwd);
    const denial = covers ? readDenial(`grep recursive over protected path '${p}' is forbidden`) : null;
    if (denial) return denial;
  }
  // If no explicit path args, grep defaults to '.', which is fine.
  // But if the only non-flag positional IS '/' (i.e., pattern was empty), still block.
  if (positionalArgs.length === 1 && (pathSpellings(positionalArgs[0]).includes('/') || isProtectedOperand(positionalArgs[0], cwd))) {
    return readDenial(`grep over protected path '${positionalArgs[0]}' is forbidden`);
  }
  return null;
}

export function validateGrepArgs(args: string[], cwd?: string): ValidationResult {
  const { fileFlagValues, patternViaFlag } = collectGrepPatternFlags(args);
  for (const p of fileFlagValues) {
    const denial = isReadDeniedOperand(p, cwd) ? readDenial(`grep pattern file '${p}' is a protected path`) : null;
    if (denial) return denial;
  }

  // Non-flag, non-empty args are candidates for pattern or path.
  // In grep: grep [options] PATTERN [FILE…]
  // The first non-flag arg is the pattern; the rest are paths. When the
  // pattern was supplied via -e/-f, every positional is a path.
  const flagValueSet = new Set(fileFlagValues);
  const positionalArgs = args.filter(a => a.length > 0 && !a.startsWith('-') && !flagValueSet.has(a));

  // Paths are all positional args after the first one (the pattern).
  const pathArgs = patternViaFlag ? positionalArgs : positionalArgs.slice(1);

  if (grepIsRecursive(args)) {
    const recursiveDenial = checkRecursiveGrepPaths(pathArgs, positionalArgs, cwd);
    if (recursiveDenial) return recursiveDenial;
  }

  // Even without -r, block explicit protected paths
  for (const p of pathArgs) {
    const denial = isReadDeniedOperand(p, cwd) ? readDenial(`grep over protected path '${p}' is forbidden`) : null;
    if (denial) return denial;
  }

  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

export function validateCatArgs(args: string[], cwd?: string): ValidationResult {
  for (const arg of args) {
    const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
    const denial = candidate !== null && isReadDeniedOperand(candidate, cwd) ? readDenial(`cat of protected path '${arg}' is forbidden`) : null;
    if (denial) return denial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

// The starting points of a find come before its expression: every word up
// to the first test, action or operator (`-name`, `(`, `!`), the leading
// options (`-H`, `-L`, `-P`, `-D...`, `-O...`) and the `--` that ends them
// skipped. A value inside the expression (`-name "*.env"`) is a search
// pattern, not a path.
const FIND_LEADING_OPTIONS = new Set(['-H', '-L', '-P', '--']);

function findStartingPoints(args: string[]): string[] {
  const points: string[] = [];
  for (const arg of args) {
    if (FIND_LEADING_OPTIONS.has(arg) || arg.startsWith('-D') || arg.startsWith('-O')) continue;
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    points.push(arg);
  }
  return points;
}

// find's actions that run a command, up to the `;` or `+` that ends it.
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// find's actions that write the list of found files to a file.
const FIND_WRITE_FLAGS = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);

function findExecCommands(args: string[]): string[] {
  const commands: string[] = [];
  let at = args.findIndex(arg => FIND_EXEC_FLAGS.has(arg));
  while (at !== -1) {
    const end = args.findIndex((arg, j) => j > at && (arg === ';' || arg === '+'));
    const stop = end === -1 ? args.length : end;
    commands.push(args.slice(at + 1, stop).join(' '));
    at = args.findIndex((arg, j) => j > stop && FIND_EXEC_FLAGS.has(arg));
  }
  return commands;
}

// In a committed script a find action is grave when it acts on a protected
// or top-level tree, writes its list over one, or runs a command that is
// itself grave there.
function findActionIsGrave(args: string[], cwd?: string): boolean {
  // A find with no starting point starts at `.`; what it acts on under a
  // starting point that is not narrow cannot be told from its tests.
  const points = findStartingPoints(args);
  const actsOnFound = args.some(arg => arg === '-delete' || FIND_EXEC_FLAGS.has(arg));
  if (actsOnFound && (points.length === 0 ? ['.'] : points).some(p => isGraveTarget(p, cwd))) return true;
  if (args.some((arg, i) => FIND_WRITE_FLAGS.has(arg) && args[i + 1] !== undefined && isGraveTarget(args[i + 1], cwd))) return true;
  return findExecCommands(args).some(command => {
    const verdict = validateCommandVerdict(command, cwd);
    return !verdict.allowed && verdict.advisory !== true;
  });
}

export function validateFindArgs(args: string[], cwd?: string): ValidationResult {
  // -delete/-exec/etc. make find perform an action instead of just
  // filtering, which reproduces 'rm -rf' through a base command that
  // isn't in the DANGEROUS list. Deny regardless of path.
  const actionFlag = args.find(a => FIND_ACTION_FLAGS.includes(a));
  if (actionFlag) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `find with action flag '${actionFlag}' is forbidden (use a read-only find, then a separate reviewed command)`,
      trust_level: 'DANGEROUS',
    };
    if (!session.committedScript || findActionIsGrave(args, cwd) || !flagsInCommittedScript(denial)) return denial;
  }

  for (const p of findStartingPoints(args)) {
    const denial = isProtectedOperand(p, cwd) ? readDenial(`find over protected path '${p}' is forbidden`) : null;
    if (denial) return denial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

// The operands `[`, `[[` and `test` look up as files: what a unary file test
// (-e, -f, -d...) names and both sides of -nt, -ot and -ef. The others are
// strings compared, never opened.
const FILE_TEST_OPERATORS = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-u', '-w', '-x', '-G', '-L', '-N', '-O', '-S']);
const FILE_COMPARISON_OPERATORS = new Set(['-nt', '-ot', '-ef']);

// -a tests a file where an expression starts and joins two expressions
// between them.
const EXPRESSION_STARTS = new Set<string | undefined>([undefined, '!', '(', '&&', '||', '-a', '-o']);

function isTestedFile(args: string[], i: number): boolean {
  const operator = args[i - 1];
  if (operator === '-a') return EXPRESSION_STARTS.has(args[i - 2]);
  return FILE_TEST_OPERATORS.has(operator) || FILE_COMPARISON_OPERATORS.has(operator) || FILE_COMPARISON_OPERATORS.has(args[i + 1]);
}

export function testedFiles(args: string[]): string[] {
  return args.filter((_, i) => isTestedFile(args, i));
}

export function validateReadOnlyPathArgs(baseCommand: string, args: string[], cwd?: string): ValidationResult {
  // These are read-only but we still block protected paths
  for (const arg of args) {
    const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
    const denial = candidate !== null && isReadDeniedOperand(candidate, cwd) ? readDenial(`${baseCommand} on protected path '${arg}' is forbidden`) : null;
    if (denial) return denial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

export function validateDevToolArgs(baseCommand: string, args: string[], cwd?: string): ValidationResult {
  // node -e/-p can read, write, or exfiltrate anything the process can
  // touch, including files DENIED_PATHS protects (e.g. the state
  // encryption key) — inline eval is caught by the interpreter check in
  // validateCommand, but a defense-in-depth check here means this branch
  // is still safe even if it's ever reached directly.
  const evalFlags = INLINE_EVAL_COMMANDS[baseCommand];
  if (evalFlags && args.some(a => matchesEvalFlag(bareToken(a), evalFlags, stripQuotes(a)))) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `inline code execution via '${baseCommand}' eval flag is forbidden`,
      trust_level: 'DANGEROUS',
    };
    if (!flagsInCommittedScript(denial)) return denial;
  }

  // Any argument that resolves to a protected path (a script path, a
  // require target, etc.) is denied the same way 'cat'/'find' deny it —
  // being in SAFE_DEV means "safe to run", not "exempt from path checks".
  for (const arg of args) {
const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
if (candidate !== null && isProtectedOperand(candidate, cwd)) {
  return {
    allowed: false,
    reason: `${baseCommand} on protected path '${arg}' is forbidden`,
    trust_level: 'SAFE_DEV',
  };
}
  }

  return { allowed: true, trust_level: 'SAFE_DEV' };
}
