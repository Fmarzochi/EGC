import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readParallelOption } from './parallel-options.js';
import { LOCAL_WRAPPER_SPECS } from './local-wrappers.js';

// Trust level tiers
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git'];
// egc is this package's own CLI and gh is how reviews, checks and merges
// happen: answering "is not in the allowlist" for either reads as a block on
// the tools the work runs on. Their destructive forms are covered where it
// counts, by checkGhDestructive for gh and by unwrapping `egc run`, which
// executes whatever follows it, so the wrapped command is the one judged.
export const SAFE_DEV = ['npm', 'npx', 'node', 'tsc', 'egc', 'gh'];
// dd/shred/truncate have no legitimate small/safe use in an agent workflow
// (unlike e.g. chmod, which is mostly benign and only dangerous with
// specific destructive flags — a blanket ban there would be a false-positive
// magnet, not a security fix). rm/mv are the two most obviously reachable
// destructive commands; these three round out the same tier now that the
// allowlist-miss path is advisory-only by design (see validateCommand).
export const DANGEROUS = ['rm', 'mv', 'dd', 'shred', 'truncate'];

export const SHELL_META_REGEX = /[&|;<>$`\n\r]/;

// find flags that perform an action (delete, run arbitrary commands) rather
// than just filtering results. These bypass the DANGEROUS ['rm', 'mv'] check
// entirely because the base command is 'find', which is SAFE_READONLY.
export const FIND_ACTION_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'];

// A command read out of a script committed in git and unchanged since is
// project code, not something the agent may have just written: it is held
// to the grave denials (writing or deleting a protected or top-level path,
// git and container overrides), while a rule that exists only to stop a
// command from hiding (eval, -c, reading a protected file) records its
// reason and lets the remaining checks run, so the verdict flags the command
// instead of blocking it. Both are set only for one synchronous validation.
let committedScript = false;
let committedFlag: ValidationResult | null = null;
// What the committed script itself sets its variables to, for the ones the
// command and the environment cannot set first (see isNarrowTarget).
let committedBound: ReadonlyMap<string, readonly string[]> = new Map();

function flagsInCommittedScript(denial: ValidationResult): boolean {
  if (!committedScript) return false;
  committedFlag ??= denial;
  return true;
}

// A read of a protected file: the denial for a typed command, null in a
// committed script, where it is flagged instead.
function readDenial(reason: string, trustLevel: ValidationResult['trust_level'] = 'SAFE_READONLY'): ValidationResult | null {
  const denial: ValidationResult = { allowed: false, reason, trust_level: trustLevel };
  return flagsInCommittedScript(denial) ? null : denial;
}

// Interpreters/shells whose inline-eval flags let an agent execute arbitrary
// code that bypasses every path- and content-based check in this file (the
// interpreter reads/writes/execs whatever the inline string tells it to,
// independent of the guardian's allowlist for base commands). Denied
// regardless of whether the interpreter itself is otherwise allowlisted,
// because 'allowed to run node' must not imply 'allowed to eval anything'.
// Matches an eval flag given exactly, glued to its value (-e'code', -ccode),
// or joined with = or : (--eval=code, -Command:code). Exact membership alone
// misses every glued form, which the underlying interpreters all accept.
// Interpreters whose single-dash options are long words (-NonInteractive,
// -Command): a letter inside one of those is not a combined short flag.
const NO_SHORT_FLAG_CLUSTERS = new Set(['pwsh', 'powershell', 'powershell.exe']);
const SHORT_FLAG_CLUSTER = /^-[A-Za-z]+$/;

// `arg` is the lowercased token the exact and glued comparisons always used;
// `casedArg` keeps the letter case, because inside a cluster -c and -C are
// different options (bash -xC is noclobber, not eval), so the cluster check
// must not inherit the lowercasing. Pass null to skip the cluster check.
function matchesEvalFlag(arg: string, flags: string[], casedArg: string | null): boolean {
  for (const flag of flags) {
    if (arg === flag) return true;
    if (arg.startsWith(flag + '=') || arg.startsWith(flag + ':')) return true;
    if (flag.startsWith('--') || flag.length !== 2) continue;
    if (arg.startsWith(flag) && arg.length > 2) return true;
    // getopt-style interpreters accept combined short options, so the eval
    // letter anywhere in a pure letter cluster (-xc, -lc, -Bc, -pe, -ne)
    // still switches on eval. Matching only the exact token or the glued
    // value form let `bash -xc "..."` through with no warning at all.
    if (casedArg !== null && SHORT_FLAG_CLUSTER.test(casedArg) && casedArg.includes(flag[1])) return true;
  }
  return false;
}

function inlineEvalVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  const evalName = INLINE_EVAL_COMMANDS[baseCommand] ? baseCommand : bareInterpreterName(baseCommand);
  const evalFlags = INLINE_EVAL_COMMANDS[evalName];
  const clusters = !NO_SHORT_FLAG_CLUSTERS.has(evalName);
  const abbreviates = ABBREVIATING_EVAL_COMMANDS.has(evalName);
  const isEvalFlag = (a: string, flags: string[]): boolean =>
    matchesEvalFlag(bareToken(a), flags, clusters ? stripQuotes(a) : null) || (abbreviates && abbreviatesEvalFlag(bareToken(a), flags));
  if (evalFlags && args.some(a => isEvalFlag(a, evalFlags))) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `inline code execution via '${baseCommand}' eval flag is forbidden — write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
    if (HANDOFF_EVAL_COMMANDS.has(evalName) || !flagsInCommittedScript(denial)) return denial;
  }
  return suShellOperandsVerdict(evalName, args);
}

// su, runuser and script read long options with getopt_long, which takes any
// prefix of `--command` (`--comm`) as the option itself.
const ABBREVIATING_EVAL_COMMANDS = new Set(['su', 'runuser', 'script']);
// They also run the code they are given as another user or through a
// terminal of their own, which nothing reads back out of: even in a
// committed script their -c stays a denial.
const HANDOFF_EVAL_COMMANDS = ABBREVIATING_EVAL_COMMANDS;

function abbreviatesEvalFlag(arg: string, flags: string[]): boolean {
  if (!arg.startsWith('--')) return false;
  const name = arg.split('=')[0];
  return name.length > 2 && flags.some(flag => flag.startsWith('--') && flag.startsWith(name));
}

// su, and runuser without -u, hand every word after the user to that user's
// shell as its arguments: a script to run, or `-c` and a command.
function suShellOperandsVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  if (baseCommand !== 'su' && baseCommand !== 'runuser') return null;
  const operands = permutedOptions(args, WRAPPER_SPECS.runuser).operands;
  const afterLogin = operands[0] === '-' ? operands.slice(1) : operands;
  if (afterLogin.length < 2) return null;
  return {
    allowed: false,
    reason: `'${baseCommand}' hands the words after the user to that user's shell, which runs them; run the command directly instead`,
    trust_level: 'DANGEROUS',
  };
}

// Strip a trailing version suffix (python3.11 -> python) so a versioned
// interpreter binary resolves to the same inline-eval rule as its bare name.
// Linear scan rather than a regex to keep this off any backtracking path.
function bareInterpreterName(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || (name[end - 1] >= '0' && name[end - 1] <= '9'))) {
    end -= 1;
  }
  return name.slice(0, end);
}

// A flag like --file=/path carries a real filesystem target even though the
// argument starts with '-'; loops that skip dashed args entirely would let
// protected paths through inside the value.
function embeddedPathCandidate(arg: string): string | null {
  if (!arg.startsWith('-')) return null;
  const eq = arg.indexOf('=');
  if (eq > 0 && eq < arg.length - 1) return arg.slice(eq + 1);
  return null;
}

// Bare comparison token for the destructive-CLI checks: shell quotes and
// backslash escapes stripped, lowercased, so `"prune"`, \reset and DELETE
// all compare equal to their plain spellings (the shell strips those before
// the real CLI sees them, so the validator must too). Quotes are stripped
// wherever they appear in the token, not just at the edges — a real shell
// removes a quote character from a word regardless of position (pru"ne"
// is shell-equivalent to prune), so an anchored-only strip leaves embedded
// quotes able to defeat every exact-match keyword check below. Path checks
// elsewhere keep the raw argument.
function bareToken(a: string): string {
  return a.replaceAll('\\', '').replaceAll(/["']/g, '').toLowerCase();
}

// Same quote/backslash stripping as bareToken(), but case-preserving. Used
// wherever a flag's exact letter case is part of its identity (e.g. a
// wrapper's -e vs -E are two different flags with different arities) -
// lowercasing before the membership check would make an unrecognized
// uppercase flag collide with an unrelated lowercase entry in valueFlags,
// silently consuming (or failing to consume) the wrong number of tokens and
// misidentifying the real wrapped command.
function stripQuotes(a: string): string {
  return a.replaceAll('\\', '').replaceAll(/["']/g, '');
}

function stripEnclosingQuotes(s: string): string {
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function positionalsOf(tokens: string[]): string[] {
  return tokens.filter(t => t.length > 0 && !t.startsWith('-'));
}

// Splits a command string into words, honoring single/double quotes and
// backslash escapes so a quoted argument with embedded whitespace (e.g. the
// prompt text in `sudo -p "enter password" cmd`) stays one token. Without
// this, a naive whitespace split misaligns the wrapper-flag skipping in
// unwrapLeadingConstructs below and can leave a stray quote character in the
// slot later read as the base command. Quote/backslash characters are kept
// in the returned tokens (not stripped) — bareToken() strips them at the
// point of use, same as every other check in this file.
interface TokenizerState {
  words: string[];
  current: string;
  quote: string | null;
  hasToken: boolean;
}

// Consumes one character (or an escaped pair, or a run through a quote span)
// starting at `command[i]`, mutating `state` in place, and returns the index
// to resume from.
function consumeTokenChar(command: string, i: number, state: TokenizerState): number {
  const ch = command[i];

  if (state.quote) return consumeQuotedChar(command, i, state);

  if (ch === '\\' && i + 1 < command.length) {
    state.current += ch + command[i + 1];
    state.hasToken = true;
    return i + 2;
  }

  // `$'...'` is read whole, its backslash escapes (an escaped quote too)
  // included.
  if (ch === '$' && command[i + 1] === "'") {
    const end = readAnsiC(command, i + 1).end;
    state.current += command.slice(i, end);
    state.hasToken = true;
    return end;
  }

  if (ch === '"' || ch === "'") {
    state.quote = ch;
    state.current += ch;
    state.hasToken = true;
    return i + 1;
  }

  if (/\s/.test(ch)) {
    if (state.hasToken) { state.words.push(state.current); state.current = ''; state.hasToken = false; }
    return i + 1;
  }

  state.current += ch;
  state.hasToken = true;
  return i + 1;
}

// One character inside a quoted span. In double quotes a backslash escapes
// the next character and a `${...}`, `$(...)` or backquoted command is read
// whole, so a quote of theirs does not close the string; in single quotes
// every character is literal up to the closing quote.
function consumeQuotedChar(command: string, i: number, state: TokenizerState): number {
  const ch = command[i];
  state.hasToken = true;
  if (state.quote === '"') {
    const end = doubleQuotedSpanEnd(command, i);
    if (end !== i) {
      state.current += command.slice(i, end);
      return end;
    }
  }
  state.current += ch;
  if (ch === state.quote) state.quote = null;
  return i + 1;
}

// Index past an escaped character, a parameter expansion, a command
// substitution or a backquoted command opening at `i` inside double quotes;
// `i` itself when none opens there.
function doubleQuotedSpanEnd(command: string, i: number): number {
  const ch = command[i];
  if (ch === '\\' && i + 1 < command.length) return i + 2;
  if (ch === '$' && command[i + 1] === '{') return parameterExpansionEnd(command, i + 2);
  if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return skipSubstitution(command, i);
  return i;
}

function tokenizeWords(command: string): string[] {
  const state: TokenizerState = { words: [], current: '', quote: null, hasToken: false };
  let i = 0;
  while (i < command.length) {
    i = consumeTokenChar(command, i, state);
  }
  if (state.hasToken) state.words.push(state.current);
  return state.words;
}

// Wrappers that re-execute a following command: each entry lists the flags
// that consume a following token as a value (so the scan below does not
// mistake a flag's value for the wrapped command), plus how many additional
// non-flag positionals appear before the wrapped command starts (e.g.
// `timeout 5 cmd` has a mandatory DURATION positional; `flock file cmd` has
// the lockfile/fd). This replaces a fixed 5-name strip list with a table
// that both grows easily and — via the while loop in
// unwrapLeadingConstructs — unwraps stacked wrappers (`sudo timeout 5 xargs
// -I{} rm -rf {}`) instead of stopping after a single layer. Options are
// read the way getopt reads them (readWrapperOption), so the tables list
// every option that takes a value, checked against each tool's own parser.
// optionalValueFlags are short flags whose value, when present, is attached
// (`xargs -i{}`, `watch -dpermanent`) and never taken from the next word.
// sudo -h is optional in sudo's getopt string, but sudo itself takes the
// next word as the host when -h stands alone, so it is read as a value flag;
// where that differs from sudo, sudo refuses to run. sudo -U only works
// together with -l, which lists instead of running, so it stays out.
// exactLongFlags are long flags that take no value (or only one attached with
// `=`), listed where one is a prefix of a value option (sudo --login and
// --login-class) or where the name itself matters (nsenter's): they count
// when a prefix is matched, so an abbreviation resolves among them the way
// getopt_long resolves it and is never stretched into the value option.
export interface WrapperSpec {
  valueFlags: Set<string>;
  optionalValueFlags?: Set<string>;
  exactLongFlags?: Set<string>;
  leadingPositionals?: number;
  // A leading positional the wrapper may leave out, read as one only when
  // the word matches (chrt's priority, all digits).
  positionalWhen?: RegExp;
  // getopt reads a lone `-` as an operand, which ends the options; env reads
  // it right after its options as -i, and the command follows it.
  loneDashIsOption?: boolean;
  // A wrapper whose options follow other rules than getopt reads each option
  // word itself, given the word and the next one, quotes already stripped.
  readOption?: (word: string, next: string | undefined) => { names: string[]; width: number };
}

export const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  sudo: {
    valueFlags: new Set(['-a', '--auth-type', '-u', '--user', '-g', '--group', '-p', '--prompt', '-h', '--host', '-C', '--close-from', '-c', '--login-class', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-R', '--chroot', '-D', '--chdir']),
    exactLongFlags: new Set(['--login']),
  },
  doas: { valueFlags: new Set(['-a', '-u', '-C']) },
  env: { valueFlags: new Set(['-a', '--argv0', '-u', '--unset', '-C', '--chdir', '-f', '--file', '-S', '--split-string']), loneDashIsOption: true },
  nohup: { valueFlags: new Set() },
  time: { valueFlags: new Set(['-o', '--output', '-f', '--format']) },
  command: { valueFlags: new Set() },
  exec: { valueFlags: new Set(['-a']) },
  nice: { valueFlags: new Set(['-n', '--adjustment']) },
  ionice: { valueFlags: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']) },
  timeout: { valueFlags: new Set(['-s', '--signal', '-k', '--kill-after']), leadingPositionals: 1 },
  stdbuf: { valueFlags: new Set(['-i', '--input', '-o', '--output', '-e', '--error']) },
  xargs: {
    valueFlags: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
    optionalValueFlags: new Set(['-e', '-i', '-l']),
  },
  flock: { valueFlags: new Set(['-w', '--timeout', '--wait', '-E', '--conflict-exit-code']), leadingPositionals: 1 },
  watch: { valueFlags: new Set(['-n', '--interval', '-q', '--equexit']), optionalValueFlags: new Set(['-d']) },
  strace: {
    valueFlags: new Set([
      '-a', '-b', '-e', '-E', '-I', '-o', '-O', '-p', '-P', '-s', '-S', '-u', '-U', '-X',
      '--abbrev', '--argv0', '--attach', '--columns', '--const-print-style', '--decode-pids', '--detach-on',
      '--env', '--fault', '--inject', '--interruptible', '--kvm', '--output', '--raw', '--read', '--signal',
      '--status', '--string-limit', '--summary-columns', '--summary-sort-by', '--summary-syscall-overhead',
      '--syscall-limit', '--trace', '--trace-fds', '--trace-path', '--user', '--verbose', '--write',
      '--stack-trace-frame-limit',
    ]),
    exactLongFlags: new Set(['--stack-trace']),
  },
  'systemd-run': {
    valueFlags: new Set([
      '-p', '--property', '-u', '--unit', '--slice', '--uid', '--gid', '--nice', '-E', '--setenv',
      '--working-directory', '-M', '--machine', '-H', '--host', '--description', '--background',
      '--expand-environment', '--on-active', '--on-boot', '--on-calendar', '--on-startup', '--on-unit-active',
      '--on-unit-inactive', '--path-property', '--service-type', '--socket-property', '--timer-property',
      '--json',
    ]),
  },
  parallel: { valueFlags: new Set(), readOption: readParallelOption },
  ...LOCAL_WRAPPER_SPECS,
};

interface WrapperOptions {
  names: string[];
  end: number;
}

// getopt_long takes an exact long name as itself and a prefix that names a
// single option as that option; a prefix that fits several (sudo --log fits
// --login and --login-class) is an error that stops the wrapper before it
// runs anything, so it is left as written. An exact name that is also a
// prefix of a longer one is ambiguous here too and so stays itself.
function resolveLongOption(name: string, spec: WrapperSpec): string {
  if (name.length <= 2) return name;
  const known = [...spec.valueFlags, ...(spec.exactLongFlags ?? [])];
  const matches = known.filter(flag => flag.startsWith(name));
  return matches.length === 1 ? matches[0] : name;
}

// Reads one option word the way getopt does and returns the option names it
// sets plus how many words it spans. A long flag takes the next word only
// when it is a value flag written without `=value`. A short cluster (`-Hu`)
// is read letter by letter up to the first letter that takes a value: that
// value is the rest of the word or, when nothing is left, the next word.
export function readWrapperOption(flag: string, spec: WrapperSpec): { names: string[]; width: number } {
  if (flag.startsWith('--')) {
    const eq = flag.indexOf('=');
    const name = resolveLongOption(eq > 0 ? flag.slice(0, eq) : flag, spec);
    return { names: [name], width: eq < 0 && spec.valueFlags.has(name) ? 2 : 1 };
  }
  const names: string[] = [];
  for (let k = 1; k < flag.length; k++) {
    const name = `-${flag[k]}`;
    names.push(name);
    if (spec.optionalValueFlags?.has(name)) break;
    if (spec.valueFlags.has(name)) return { names, width: k === flag.length - 1 ? 2 : 1 };
  }
  return { names, width: 1 };
}

function readWrapperOptions(current: string[], spec: WrapperSpec): WrapperOptions {
  const names: string[] = [];
  let i = 1;
  while (i < current.length && stripQuotes(current[i]).startsWith('-')) {
    const word = stripQuotes(current[i]);
    if (word === '-') {
      if (spec.loneDashIsOption) i += 1;
      break;
    }
    const next = i + 1 < current.length ? stripQuotes(current[i + 1]) : undefined;
    const option = spec.readOption ? spec.readOption(word, next) : readWrapperOption(word, spec);
    names.push(...option.names);
    i += option.width;
  }
  return { names, end: i };
}

const ENV_ASSIGNMENT_RE = /^([A-Za-z_]\w*)=/;

// Environment variables that let a command persist or override git's hook
// and execution config the same way `-c core.hooksPath=`/`git config` does
// (see DANGEROUS_GIT_CONFIG_RULES below), but via `VAR=value git ...` on the
// command line instead — a form the old strip-and-ignore VAR= handling let
// through untouched. GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n are numbered
// (GIT_CONFIG_COUNT-driven), hence the pattern rather than a fixed name.
const DANGEROUS_ENV_VAR_EXACT = new Set([
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH',
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_PAGER',
]);
const DANGEROUS_ENV_VAR_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function isDangerousEnvVarName(varName: string): boolean {
  const upper = varName.toUpperCase();
  return DANGEROUS_ENV_VAR_EXACT.has(upper)
    || DANGEROUS_ENV_VAR_PATTERN.test(upper)
    || upper.startsWith('GIT_ALIAS_');
}

interface UnwrapResult {
  blocked?: ValidationResultLike;
  tokens: string[];
}

// A ValidationResult-shaped object, declared ahead of the real interface
// (defined further down this file) so unwrapLeadingConstructs can be typed
// without reordering the whole file.
interface ValidationResultLike {
  allowed: boolean;
  reason?: string;
  trust_level?: 'SAFE_READONLY' | 'SAFE_DEV' | 'DANGEROUS' | 'BLOCKED';
}

// One attempt at peeling a single leading construct off `current`. Returns
// null when this check doesn't apply (caller tries the next one); otherwise
// either `blocked` (hard-deny, unwrapping stops) or `remaining` (the new
// front of the token list to keep unwrapping from).
interface UnwrapStep {
  blocked?: ValidationResultLike;
  remaining?: string[];
}

// A bare `VAR=value` prefix persists in the shell's environment for every
// command that follows, so a dangerous git-persistence variable here is a
// hard block rather than a silent strip: stripping it would judge the
// command by a name that never actually ran with that override in effect.
function tryUnwrapEnvAssignment(current: string[]): UnwrapStep | null {
  const envMatch = ENV_ASSIGNMENT_RE.exec(current[0]);
  if (!envMatch) return null;
  if (isDangerousEnvVarName(envMatch[1])) {
    return {
      blocked: {
        allowed: false,
        reason: `setting '${envMatch[1]}' persists a git execution/config override and is forbidden`,
        trust_level: 'DANGEROUS',
      },
    };
  }
  return { remaining: current.slice(1) };
}

// `export VAR=value` persists the same way a bare `VAR=value` prefix does
// (the shell keeps it in the environment for every command that follows in
// this session/segment chain, not just the current one), so it gets the
// identical dangerous-name check rather than being treated as an unknown,
// advisory-only 'export' command. `export` accepts its own options (-f, -n,
// -p) and a `--` end-of-options marker before the assignment, same as any
// other bash builtin — skipping straight to current[1] missed
// `export -- GIT_SSH_COMMAND=...`, which real bash still treats as an
// assignment despite the leading `--`.
function tryUnwrapExport(current: string[]): UnwrapStep | null {
  if (bareToken(current[0]) !== 'export' || current.length <= 1) return null;

  let idx = 1;
  while (idx < current.length) {
    const flagToken = stripQuotes(current[idx]);
    if (flagToken === '--') { idx += 1; break; }
    if (!flagToken.startsWith('-')) break;
    idx += 1;
  }
  const exportMatch = idx < current.length ? ENV_ASSIGNMENT_RE.exec(current[idx]) : null;
  if (!exportMatch) return null;

  if (isDangerousEnvVarName(exportMatch[1])) {
    return {
      blocked: {
        allowed: false,
        reason: `exporting '${exportMatch[1]}' persists a git execution/config override and is forbidden`,
        trust_level: 'DANGEROUS',
      },
    };
  }
  return { remaining: current.slice(idx + 1) };
}

const FLOCK_COMMAND_FLAGS = new Set(['-c', '--command']);

function isSplitStringFlag(flag: string): boolean {
  return flag === '-S' || flag === '--split-string' || flag.startsWith('--split-string=');
}

function envSplitsString(current: string[], optionNames: string[]): boolean {
  return optionNames.some(isSplitStringFlag) || current.slice(1).some(t => isSplitStringFlag(stripQuotes(t)));
}

function forbiddenCommandString(reason: string): UnwrapStep {
  return { blocked: { allowed: false, reason, trust_level: 'DANGEROUS' } };
}

// Every word of a command whose options getopt permutes (su, runuser):
// the option names set anywhere before `--`, and the other words in order.
export function permutedOptions(words: string[], spec: WrapperSpec): { names: string[]; operands: string[] } {
  const names: string[] = [];
  const operands: string[] = [];
  let i = 0;
  while (i < words.length) {
    const word = stripQuotes(words[i]);
    if (word === '--') {
      operands.push(...words.slice(i + 1).map(stripQuotes));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      operands.push(word);
      i += 1;
      continue;
    }
    const option = readWrapperOption(word, spec);
    names.push(...option.names);
    i += option.width;
  }
  return { names, operands };
}

const RUNUSER_USER_FLAGS = new Set(['-u', '--user']);
const RUNUSER_SHELL_FLAGS = new Set(['-c', '--command', '--session-command']);

// runuser runs the words after its options only with -u/--user and without
// a command for the shell (which it refuses alongside -u); otherwise it
// behaves like su and is judged as su is.
function runuserRunsWords(current: string[], spec: WrapperSpec): boolean {
  const names = permutedOptions(current.slice(1), spec).names;
  return names.some(name => RUNUSER_USER_FLAGS.has(name)) && !names.some(name => RUNUSER_SHELL_FLAGS.has(name));
}

// `sg [-] GROUP [-c] COMMAND` hands COMMAND to `sh -c`.
function sgRunsCommand(current: string[]): boolean {
  const words = current.slice(1).map(stripQuotes);
  let k = words[0] === '-' || words[0] === '-l' ? 1 : 0;
  if (k >= words.length || words[k].startsWith('-')) return false;
  k += 1;
  return k < words.length;
}

// Unwraps a known wrapper command (sudo, timeout, xargs, ...), skipping its
// flags and any mandatory leading positionals to reach the wrapped command.
function tryUnwrapWrapper(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  if (head === 'sg' && sgRunsCommand(current)) {
    return forbiddenCommandString(`'sg' runs its command through a shell and is forbidden`);
  }
  const spec = WRAPPER_SPECS[head];
  if (!spec) return null;
  if (head === 'runuser' && !runuserRunsWords(current, spec)) return null;

  // env -S/--split-string re-splits its value into a new argv and execs the
  // first word of that split, the same "string becomes code" shape as
  // eval, just via env(1) instead of a shell builtin. The value isn't a
  // simple opaque flag argument to skip past; it can itself be a full
  // destructive command, so this is a hard deny rather than an unwrap.
  const options = readWrapperOptions(current, spec);
  if (head === 'env' && envSplitsString(current, options.names)) {
    return forbiddenCommandString(`'env -S/--split-string' re-splits and executes its value and is forbidden`);
  }

  let i = options.end;
  let skip = spec.leadingPositionals ?? 0;
  while (skip > 0 && i < current.length && (!spec.positionalWhen || spec.positionalWhen.test(stripQuotes(current[i])))) {
    i += 1;
    skip -= 1;
  }

  // `flock FILE -c STRING` (or --command) hands STRING to a shell, the same
  // shape as env -S, so it is denied the same way.
  if (head === 'flock' && i < current.length && FLOCK_COMMAND_FLAGS.has(stripQuotes(current[i]))) {
    return forbiddenCommandString(`'flock -c/--command' runs its value through a shell and is forbidden`);
  }
  return { remaining: current.slice(i) };
}

// Peels leading environment-variable assignments and known wrapper commands
// off the front of a token list until the real command is reached, looping
// so stacked wrappers (`sudo timeout 5 xargs rm -rf`) all get unwrapped
// rather than just the outermost one.
// Shell keywords and grouping openers that stand in front of the command
// actually run: `if rm ...; then`, `then rm ...`, `(rm ...)`, `{ rm ...; }`,
// `! rm ...`. Judged as "the command", the keyword would read as a mere
// allowlist miss and let whatever follows it pass.
export const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);

// `case word in pattern) command`: the command starts after the pattern.
function unwrapCaseClause(current: string[]): string[] {
  const inIndex = current.findIndex((token, index) => index > 0 && bareToken(token) === 'in');
  const rest = current.slice(inIndex === -1 ? 1 : inIndex + 1);
  return rest.length > 0 && stripQuotes(rest[0]).endsWith(')') ? rest.slice(1) : rest;
}

function isBlockOpener(token: string | undefined): boolean {
  const bare = token === undefined ? '' : stripQuotes(token);
  return bare.startsWith('{') || bare.startsWith('(');
}

// Constructs that run a command of their own: case arms, coprocesses and
// function bodies (`function f { ... }`, `f() { ... }`) are unwrapped to the
// command they carry so it is judged as if typed directly.
function tryUnwrapCommandCarrier(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  if (head === 'case') return { remaining: unwrapCaseClause(current) };
  if (head === 'coproc') return { remaining: current.slice(isBlockOpener(current[2]) ? 2 : 1) };
  if (head === 'function') return { remaining: current.slice(2) };
  if (head.endsWith('()')) return { remaining: current.slice(1) };
  // A later arm of a case (`b) command`, `b ) command`) starts its own segment after ;;.
  if (head.endsWith(')')) return { remaining: current.slice(1) };
  if (current.length > 1 && bareToken(current[1]) === ')') return { remaining: current.slice(2) };
  if (current.length > 1 && bareToken(current[1]) === '()') return { remaining: current.slice(2) };
  return null;
}

function tryUnwrapShellKeyword(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  if (SHELL_KEYWORDS.has(head)) return { remaining: current.slice(1) };
  if ((head.startsWith('(') || head.startsWith('{')) && head.length > 1) {
    return { remaining: [stripQuotes(current[0]).slice(1), ...current.slice(1)] };
  }
  return tryUnwrapCommandCarrier(current);
}

// The egc subcommands that run a command the caller hands them: `run` sends
// it through the Token Crusher and `verify` runs the project's verification
// command after `--`. Both execute what follows, so the wrapped command is
// judged as if it had been typed. Every other subcommand is the CLI itself
// and falls through to the ordinary allowlist handling.
const EGC_EXECUTOR_SUBCOMMANDS = new Set(['run', 'verify']);

function tryUnwrapEgcExecutor(current: string[]): UnwrapStep | null {
  if (path.basename(bareToken(current[0])) !== 'egc') return null;
  let i = 1;
  while (i < current.length && bareToken(current[i]).startsWith('-')) i += 1;
  if (!EGC_EXECUTOR_SUBCOMMANDS.has(bareToken(current[i] ?? ''))) return null;

  i += 1;
  let viaShell = false;
  while (i < current.length) {
    const token = bareToken(current[i]);
    if (token === '--') { i += 1; break; }
    if (!token.startsWith('-')) break;
    if (token === '--shell') viaShell = true;
    i += 1;
  }

  const rest = current.slice(i);
  if (rest.length === 0) return null;
  // --shell joins the words and hands them to a shell, so a whole script can
  // arrive as one quoted token: it is re-read as the command line it is.
  if (viaShell) return { remaining: tokenizeWords(rest.map(stripQuotes).join(' ')) };
  return { remaining: rest };
}

function unwrapLeadingConstructs(tokens: string[]): UnwrapResult {
  let current = tokens;
  let changed = true;
  while (changed && current.length > 0) {
    changed = false;

    const step = tryUnwrapEnvAssignment(current) ?? tryUnwrapExport(current) ?? tryUnwrapEgcExecutor(current) ?? tryUnwrapWrapper(current) ?? tryUnwrapShellKeyword(current);
    if (step) {
      if (step.blocked) return { tokens: [], blocked: step.blocked };
      current = step.remaining as string[];
      changed = true;
    }
  }
  return { tokens: current };
}

// Destructive variants of CLIs that are otherwise advisory-only at the
// enforcement hook (see the allowlist-miss comment in validateCommand):
// plain `docker build` / `gh pr list` / `prisma migrate dev` keep today's
// advisory behavior, but the data-destroying forms below hard-block the
// same way inline eval does. Returning null means "nothing destructive
// here" and the command falls through to the ordinary allowlist handling.

// docker management groups whose next positional is the real subcommand
// (`docker system prune`, `docker volume rm`, `docker compose down`).
const DOCKER_MGMT_GROUPS = new Set(['container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'compose']);

// Global docker flags that take a value and can appear BEFORE the subcommand
// (`docker -H tcp://x system prune`, `docker --log-level debug rm c1`) — a
// small, stable, fully-documented set (unlike run's much larger per-
// subcommand flag surface below), so it can be enumerated completely.
// Stripping these, and their values, before computing positionals is what
// keeps a global value-flag from shifting the real subcommand out of the
// position checkDockerDestructive looks at.
const DOCKER_GLOBAL_VALUE_FLAGS = new Set([
  '-h', '--host', '-l', '--log-level', '-c', '--context', '--config',
  '--tlscacert', '--tlscert', '--tlskey',
]);

function stripDockerGlobalFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.indexOf('=');
    if (eq > 0 && DOCKER_GLOBAL_VALUE_FLAGS.has(t.slice(0, eq))) continue;
    if (DOCKER_GLOBAL_VALUE_FLAGS.has(t)) {
      // Only consume the next token as this flag's value if it doesn't
      // itself look like a flag — mirrors how real getopt-style parsers
      // never let one flag silently swallow the next flag as a value.
      if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

// run/create flags that consume the following token as a value; skipping the
// value keeps the option-window scan below from mistaking it for the image.
// Cannot be exhaustive against docker's full run-flag surface — that is why
// runWindowMountsOrPrivileges never treats "unrecognized flag" as proof the
// window has ended (see its own comment); this set only needs to cover the
// common cases so their values are not misread as the image.
const DOCKER_RUN_VALUE_FLAGS = new Set([
  '-e', '--env', '-p', '--publish', '-w', '--workdir', '--name', '-u', '--user',
  '--network', '-l', '--label', '--entrypoint', '--platform', '--pull', '--add-host',
  '-m', '--memory', '--memory-swap', '-h', '--hostname', '--gpus', '--device',
  '--dns', '--dns-search', '--restart', '--tmpfs', '--ip', '--ip6', '--mac-address',
  '--health-cmd', '--health-interval', '--health-retries', '--health-timeout',
  '--health-start-period', '--security-opt', '--log-driver', '--log-opt',
  '--stop-signal', '--stop-timeout', '--shm-size', '--ulimit', '--pid', '--ipc',
  '--uts', '--cgroup-parent', '--blkio-weight', '--cpus', '--cpuset-cpus', '--cpu-shares',
]);

// A docker volume/mount SOURCE is a real host-escape risk only if it looks
// like a path — absolute, relative, home-relative, or a Windows drive
// letter. A bare identifier (docker's named-volume naming rule is
// [a-zA-Z0-9][a-zA-Z0-9_.-]*) is a Docker-managed named volume with no host
// filesystem access, and is the common form for stateful dev containers
// (postgres/redis/mongo data volumes). Anything that fails to parse as a
// clean identifier is treated as a path — fail closed on ambiguity.
function isHostMountSource(source: string): boolean {
  if (source.length === 0) return true;
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source)) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source);
}

function volumeValueIsHostMount(value: string): boolean {
  return isHostMountSource(value.split(':')[0]);
}

// In docker syntax every option of run/create precedes the image name, and
// everything after the image is the command executed INSIDE the container.
// Scanning only that option window is what lets `docker run alpine rm -rf
// /tmp/x` or `docker run img tar -xvf a.tar` pass while a host mount or
// privilege escalation before the image still blocks. The bundled/glued
// short-flag test (-itv, -v/:/host) is why exact `-v` membership is not
// enough. -v/--volume get their value checked (isHostMountSource) so a
// named volume — the common stateful-dev-container pattern — does not
// hard-block; every other spelling of a mount/privilege flag stays an
// unconditional block, same as before.
const DOCKER_UNCONDITIONAL_PRIVILEGE_FLAGS = new Set(['--privileged', '--mount', '--cap-add']);

function isUnconditionalPrivilegeFlag(t: string): boolean {
  return DOCKER_UNCONDITIONAL_PRIVILEGE_FLAGS.has(t) || t.startsWith('--mount=') || t.startsWith('--cap-add=');
}

// A volume flag carrying its value inline (--volume=..., -v/...) is judged on
// that value. Bundled short flags (-itv, -dv...): the value's position inside
// the bundle is ambiguous, so they stay unconditionally dangerous rather than
// risk mis-parsing a host mount as a safe named volume.
function inlineVolumeIsHostMount(t: string): boolean {
  if (t.startsWith('--volume=')) return volumeValueIsHostMount(t.slice('--volume='.length));
  if (t.startsWith('-v') && t.length > 2) return volumeValueIsHostMount(t.slice(2));
  return !t.startsWith('--') && /^-[a-z]*v/.test(t);
}

function runWindowMountsOrPrivileges(tokens: string[], startIdx: number): boolean {
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) return false;
    if (isUnconditionalPrivilegeFlag(t)) return true;
    if (t === '-v' || t === '--volume') {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('-') || volumeValueIsHostMount(value)) return true;
      i++;
      continue;
    }
    if (inlineVolumeIsHostMount(t)) return true;
    if (DOCKER_RUN_VALUE_FLAGS.has(t)) i++;
  }
  return false;
}

function checkDockerDestructive(args: string[]): ValidationResult | null {
  const tokens = stripDockerGlobalFlags(args.map(bareToken));
  const positionals = positionalsOf(tokens);
  // The destructive subcommand is the first positional, or the second when
  // the first is a management group. A later `rm`/`prune` (e.g. the command
  // run inside a container) is not a docker subcommand and must not match.
  const sub = DOCKER_MGMT_GROUPS.has(positionals[0] ?? '') ? positionals[1] : positionals[0];
  if (sub === 'rm' || sub === 'rmi' || sub === 'prune') {
    return { allowed: false, reason: 'destructive docker operation is forbidden', trust_level: 'DANGEROUS' };
  }
  const volumesFlag = tokens.some(t => t === '-v' || t === '--volumes' || t.startsWith('--volumes='));
  if (sub === 'down' && volumesFlag) {
    return { allowed: false, reason: 'destructive docker operation is forbidden', trust_level: 'DANGEROUS' };
  }
  const startIdx = tokens.findIndex(t => t === 'run' || t === 'create');
  if (startIdx >= 0 && runWindowMountsOrPrivileges(tokens, startIdx)) {
    return { allowed: false, reason: 'docker run with host mounts or elevated privileges is forbidden', trust_level: 'DANGEROUS' };
  }
  return null;
}

// gh options that take the next word: without skipping their values, a
// global option in front (`gh -R owner/repo repo delete`) shifts the verb out
// of the position the subcommand check reads.
const GH_VALUE_FLAGS = new Set([
  '-r', '--repo', '--hostname', '-t', '--template', '-q', '--jq', '-h', '--header',
  '-f', '--field', '--raw-field', '-x', '--method', '--input', '--cache', '-p', '--preview', '--json',
]);

function ghPositionals(tokens: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.includes('=') && GH_VALUE_FLAGS.has(token)) i += 1;
  }
  return positionals;
}

function checkGhDestructive(args: string[]): ValidationResult | null {
  const tokens = args.map(bareToken);
  const positionals = ghPositionals(tokens);
  // `gh <resource> delete` always puts the verb in the second positional;
  // a later token spelled delete (an issue title word, a repo actually
  // named delete in `gh repo view delete`) is data, not a subcommand. gh
  // also has compound noun-verb subcommand names for the same action
  // (`item-delete`, `field-delete` on `gh project`), so the suffix is
  // checked too, not just an exact match.
  if (positionals[1] === 'delete' || (positionals[1] ?? '').endsWith('-delete')) {
    return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
  }
  // gh api with an explicit DELETE method, in every spelling getopt
  // accepts: -X DELETE, -XDELETE, -X=DELETE, --method DELETE, --method=delete.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-xdelete' || t === '--method=delete' || t === '-x=delete') {
      return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
    }
    if ((t === '-x' || t === '--method') && tokens[i + 1] === 'delete') {
      return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
    }
  }
  return null;
}

function checkPrismaDestructive(args: string[]): ValidationResult | null {
  const tokens = args.map(bareToken);
  const positionals = positionalsOf(tokens);
  // Subcommand context, not token presence: `prisma migrate dev --name
  // reset` names a migration and must pass; `prisma migrate reset` wipes.
  if (positionals[0] === 'migrate' && positionals[1] === 'reset') {
    return { allowed: false, reason: 'prisma data-loss operation is forbidden', trust_level: 'DANGEROUS' };
  }
  if (tokens.some(t =>
    t === '--force-reset' || t.startsWith('--force-reset=') ||
    t === '--accept-data-loss' || t.startsWith('--accept-data-loss='),
  )) {
    return { allowed: false, reason: 'prisma data-loss operation is forbidden', trust_level: 'DANGEROUS' };
  }
  if (positionals[0] === 'db' && positionals[1] === 'execute') {
    return { allowed: false, reason: 'prisma db execute runs arbitrary SQL and is forbidden', trust_level: 'DANGEROUS' };
  }
  return null;
}

const DESTRUCTIVE_CLI_CHECKS: Record<string, (args: string[]) => ValidationResult | null> = {
  docker: checkDockerDestructive,
  'docker-compose': checkDockerDestructive,
  gh: checkGhDestructive,
  prisma: checkPrismaDestructive,
};

// Package runners re-execute their first non-flag argument, so `npx prisma
// migrate reset` must be judged as prisma, not as npx (which is SAFE_DEV) —
// and `yarn prisma ...` must not slide through as a plain allowlist miss.
const RUNNER_CLIS = new Set(['npx', 'pnpx', 'bunx', 'yarn', 'pnpm', 'bun']);
// 'run' included alongside dlx/x/exec: `yarn run <bin>`/`bun run <bin>`
// re-execute a node_modules/.bin binary the same way dlx/x/exec do.
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'x', 'exec', 'run']);
// Runner flags that consume the following token as a value (the package to
// install/run, a cwd, a registry). Without skipping the value too, the
// unwrap loop below mistakes it for the inner command and judges the wrong
// (misaligned) argument slice, e.g. `npx -p prisma prisma migrate reset`.
const RUNNER_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--cwd', '--registry']);

function destructiveVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  const check = DESTRUCTIVE_CLI_CHECKS[baseCommand];
  if (check) return check(args);
  if (!RUNNER_CLIS.has(baseCommand)) return null;
  let i = 0;
  while (i < args.length) {
    const t = bareToken(args[i]);
    if (RUNNER_VALUE_FLAGS.has(t)) { i += 2; continue; }
    if (!t.startsWith('-') && !RUNNER_SUBCOMMANDS.has(t)) break;
    i += 1;
  }
  if (i >= args.length) return null;
  // prisma@5.x and ./node_modules/.bin/prisma both resolve to prisma.
  let inner = path.basename(bareToken(args[i]));
  if (!inner.startsWith('@')) inner = inner.split('@')[0];
  const innerCheck = DESTRUCTIVE_CLI_CHECKS[inner];
  return innerCheck ? innerCheck(args.slice(i + 1)) : null;
}

const INLINE_EVAL_COMMANDS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  // su -c runs its whole argument as a shell command under another user,
  // same risk class as `bash -c` — unlike sudo/doas, su has no separate
  // "unwrap the next token as the real command" shape (the command is one
  // string argument to -c), so it is handled here instead of WRAPPER_SPECS.
  su: ['-c', '--command', '--session-command'],
  runuser: ['-c', '--command', '--session-command'],
  script: ['-c', '--command'],
  pwsh: ['-c', '-command', '-Command'],
  powershell: ['-c', '-command', '-Command'],
  'powershell.exe': ['-c', '-command', '-Command'],
};

// Protected file patterns (checked on full path string).
//
// AI coding tool home directories (~/.claude, ~/.cursor, ~/.gemini, ~/.config/*)
// mix real credential files with functional data the tool's own assistant
// legitimately writes (skills, agents, native memory, user-requested config
// edits). Blocking the whole directory breaks that functional data for no
// security gain, since the actual secret is always one specific file, not
// the directory. Deny the credential file by pattern instead. Sources: each
// tool's official docs, verified 2026-07-11 (see docs/architecture or the
// PR that introduced this comment for the full per-tool research).
export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  // EGC install-state: egc repair and uninstall replay what it records, so a
  // planted entry would turn either into a write or delete of its choosing.
  /(^|[\\/])egc[\\/][\w-]*install-state\.json$/,
  /(^|[\\/])egc-install-state\.json$/,
  /\.env$/,
  // .env.example/.sample/.template are conventionally committed templates
  // with placeholder values, never real secrets — excluded so they're
  // readable/writable like any other file. .env.local/.production/.staging
  // and everything else still match (real per-environment secret files).
  /\.env\.(?!example$|sample$|template$)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.npmrc$/,
  /\.pypirc$/,
  // Claude Code: OAuth session lives in .credentials.json inside ~/.claude,
  // and in ~/.claude.json at the home root (sibling of ~/.claude, not inside
  // it). settings.json, skills, agents, and projects/*/memory/ are functional.
  /\.claude[\\/]\.credentials\.json$/,
  /(^|[\\/])\.claude\.json$/,
  // Gemini CLI + Antigravity (share ~/.gemini). settings.json, GEMINI.md,
  // skills/, extensions/, and antigravity/brain (native memory) are functional.
  /\.gemini[\\/]oauth_creds\.json$/,
  /\.gemini[\\/]google_accounts\.json$/,
  /\.gemini[\\/].*mcp-oauth-tokens\.json$/,
  /\.gemini[\\/]a2a-oauth-tokens\.json$/,
  // Gemini CLI's real MCP server registration file (scripts/lib/
  // mcp-register.js, confirmed 2026-07-27). guardian-bin.js's
  // fromMcpConfigs() now trusts this file the same way it already trusts
  // ~/.claude.json, to resolve the guardian CLI for a Gemini-CLI-only
  // install — that trust is only sound if a write here is denied, or a
  // prompt-injected agent could repoint egc-guardian's own MCP entry at an
  // arbitrary script and have this validator treat it as authoritative.
  /\.gemini[\\/]config[\\/]mcp_config\.json$/,
  // Antigravity CLI's own MCP server registration file — a separate file
  // from Gemini CLI's above despite sharing the ~/.gemini home root
  // (scripts/lib/mcp-register.js's "Antigravity CLI" target). Internal
  // audit (EGC-460/461, 2026-07-27) found guardian-bin.js now also trusts
  // this file, for the same reasoning as the Gemini CLI entry above.
  /\.gemini[\\/]antigravity-cli[\\/]mcp_config\.json$/,
  // OpenCode's real MCP server registration file (scripts/lib/
  // mcp-register.js's "OpenCode" target); same reasoning and same audit.
  /\.config[\\/]opencode[\\/]config\.json$/,
  // Codex CLI: OAuth/API key auth file.
  /\.codex[\\/]auth\.json$/,
  // Codex CLI's real MCP server registration file (scripts/lib/
  // mcp-register.js's registerToml(), TOML not JSON). guardian-bin.js's
  // fromCodexToml() now trusts this file the same way fromMcpConfigs()
  // trusts the JSON configs above, to resolve the guardian CLI for a
  // Codex-only install: same reasoning, same audit (2026-07-27). A write
  // here must be denied, or a prompt-injected agent could repoint
  // egc-guardian's own MCP entry at an arbitrary script and have this
  // validator treat it as authoritative.
  /\.codex[\\/]config\.toml$/,
  // Home-scoped install marker (scripts/lib/install/apply.js's
  // writeGuardianCliMarker(), 2026-07-27 internal design review EGC-465).
  // guardian-bin.js's fromEgcHomeMarker() trusts this file's packageRoot
  // value to resolve the guardian CLI on installs with no MCP config of
  // their own (Copilot, CodeBuddy). Same reasoning as the other resolution
  // sources above: a write here must be denied, or a prompt-injected agent
  // could point resolution at an arbitrary script.
  /\.egc[\\/]guardian-cli-path\.json$/,
  // Amp: OAuth tokens live under this subfolder; config is elsewhere.
  /\.amp[\\/]oauth([\\/]|$)/,
  // Kiro: the CLI's token cache lives outside ~/.kiro, under XDG data dir.
  /\.local[\\/]share[\\/]kiro-cli[\\/]data\.sqlite3$/,
  // Continue.dev: not yet an EGC install target, but its real secret file is
  // .env (already caught by the generic pattern above) plus these two
  // environment dotfiles. config.yaml, prompts/, sessions/, and index/ are
  // functional and must stay writable once Continue.dev is integrated.
  /\.continue[\\/]\.local$/,
  /\.continue[\\/]\.staging$/,
  // Shell startup files and git config: not credential stores, but a
  // write here is a persistence mechanism — code planted here runs on
  // every new shell (rc files) or every git invocation that hits an
  // aliased subcommand (gitconfig aliases can run arbitrary shell via
  // `alias.x = "!sh -c ..."`), long after the current session ends.
  /(^|[\\/])\.bashrc$/,
  /(^|[\\/])\.zshrc$/,
  /(^|[\\/])\.bash_profile$/,
  /(^|[\\/])\.zprofile$/,
  /(^|[\\/])\.profile$/,
  /(^|[\\/])\.gitconfig$/,
  // A hook planted directly in .git/hooks/ fires on the next matching git
  // operation (pre-commit, pre-push, ...) without touching any config file
  // at all — the same persistence effect as the core.hooksPath/git-config
  // checks above, via a path validateWrite previously never inspected.
  // .git/config is the repo-local counterpart of ~/.gitconfig above; both
  // can carry the same dangerous keys checkGitConfigWrite denies when set
  // through the `git config` CLI, so a raw file write must be denied too.
  /(^|[\\/])\.git[\\/]hooks([\\/]|$)/,
  /(^|[\\/])\.git[\\/]config$/,
];

export function buildDeniedPaths(): string[] {
  const home = os.homedir();
  const isWindows = process.platform === 'win32';

  const paths = [
    // Pure credential stores: no legitimate reason for an AI tool to write here.
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.egc'),
    // A binary planted here (named e.g. 'git' or 'node') sits ahead of
    // /usr/bin on most PATH configurations, silently hijacking every
    // "safe, allowlisted" command this same guardian trusts by name.
    path.join(home, '.local', 'bin'),
    // User-level systemd units auto-run on login without any further
    // action from the agent that planted one — a persistence mechanism
    // equivalent in effect to a shell rc file.
    path.join(home, '.config', 'systemd', 'user'),
    // ~/.config is XDG_CONFIG_HOME, shared by many unrelated apps and by
    // OpenCode/Zed's functional (non-secret) config, which EGC itself
    // installs into. Deny only the specific subdirectories confirmed to
    // hold credentials for tools that don't expose them elsewhere.
    path.join(home, '.config', 'github-copilot'),
    path.join(home, '.config', 'Trae'),
    '/etc',
  ];

  if (isWindows) {
    const appData = process.env.APPDATA || '';
    const userProfile = process.env.USERPROFILE || home;
    paths.push(
      path.join(userProfile, '.ssh'),
      path.join(userProfile, '.aws'),
      appData,
    );
  }

  return paths.filter(Boolean);
}

export const DENIED_PATHS: string[] = buildDeniedPaths();

// Shared by both the incoming path and each DENIED_PATHS entry in
// isProtectedPath(): resolve through fs.realpathSync(), falling back to
// resolving the nearest existing ancestor directory (then rejoining the remaining
// path components) when the target doesn't exist yet. Walking ancestor directories
// ensures that symlinks at any parent level (such as macOS /etc -> /private/etc)
// resolve correctly even for deeply nested non-existent paths (e.g. /etc/wireguard/wg0.conf).
// Resolving both sides fresh on every isProtectedPath() call removes any staleness window entirely.
export function resolveRealOrLexical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let curr = p;
    const pieces: string[] = [];
    while (curr && curr !== path.dirname(curr)) {
      pieces.unshift(path.basename(curr));
      curr = path.dirname(curr);
      try {
        const resolved = fs.realpathSync(curr);
        return path.join(resolved, ...pieces);
      } catch {
        // continue walking up
      }
    }
    return p;
  }
}

// baseDir defaults to process.cwd() (path.resolve's own implicit behavior
// when given one argument) so existing callers are unaffected. Callers that
// know the real invocation directory of the command being checked (e.g. the
// PreToolUse hook, which receives it from the harness on every call) should
// pass it explicitly -- otherwise a relative path is judged against this
// process's own cwd, which is not guaranteed to match the shell the command
// actually runs in.
// macOS and Windows resolve paths case-insensitively; Linux does not. Every
// path comparison in this file folds through here so a case variant cannot
// name a protected file while dodging the check written for it.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

// `~`, `$HOME` and `${HOME}` at the start of a path name the home directory
// once the shell is done with them; every path check reads them the same
// way, so a file is recognized under each spelling of its location.
const HOME_PARAMETER_RE = /^\$(?:HOME|\{HOME\})(?=[\\/]|$)/;

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  const parameter = HOME_PARAMETER_RE.exec(p);
  return parameter ? path.join(os.homedir(), p.slice(parameter[0].length)) : p;
}

export function isProtectedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Trim first: a trailing newline (routine for anything piped through
  // `echo`) or stray whitespace survives path.resolve() into the final
  // string, and every pattern in PROTECTED_FILE_PATTERNS is anchored with
  // `$`, so an untrimmed ".env\n" silently failed to match ".env" and was
  // allowed through (audit EGC-533).
  p = p.trim();

  const expanded = expandHome(p);

  // Resolve symlinks so a link inside an allowed directory cannot point past
  // this check into a denied path. Fall back to the lexical path (then the
  // parent) when the target does not exist yet, e.g. a write being created.
  const normalizedP = resolveRealOrLexical(path.resolve(baseDir, expanded));
  // macOS and Windows open `.ENV`, `/etc/SHADOW` and `~/.SSH/id_rsa` as the
  // very same files their lower-case spellings name, so a comparison that is
  // not folded there protects only one spelling of each secret. Folding is
  // applied to both sides, and only where the filesystem actually behaves
  // that way -- on Linux those are genuinely different files.
  const candidate = foldCase(normalizedP);

  for (const denied of DENIED_PATHS) {
    const resolvedDenied = foldCase(resolveRealOrLexical(denied));
    if (candidate === resolvedDenied || candidate.startsWith(resolvedDenied + path.sep)) {
      return true;
    }
  }

  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(candidate)) {
      return true;
    }
  }

  return false;
}

// Reading and writing carry different risk, and treating them alike is what
// made the guardian deny `cat ~/.egc/bin/manifest.json`, `ls ~/.egc/bin` or
// `cat /etc/systemd/oomd.conf` -- none of which expose a secret, all of
// which someone diagnosing their own install genuinely needs. Writing into
// those directories can hijack execution or plant persistence, so every
// write denial stays exactly as it was.
//
// Derived from the write protection by subtraction, never restated: a read
// is denied wherever a write is denied, EXCEPT for the locations listed
// here. Stating the readable set positively (rather than re-listing what to
// deny) means a credential store added to the write protection tomorrow is
// read-protected automatically, instead of silently becoming readable
// because a parallel list was not updated.
//
// Deliberately narrow: specific directories whose entire contents are
// operational, never a whole tree with secrets carved back out. Opening
// /etc or ~/.egc wholesale and then listing the secrets inside them is a
// denylist wearing an allowlist's clothes, and it leaks by omission -- an
// audit of exactly that shape turned up /etc/ssl/private, /etc/wireguard,
// /etc/krb5.keytab, the shadow backup files (/etc/shadow-), and
// ~/.egc/encryption.key.bak, none of which had been listed. Anything not
// named here stays denied, so a secret nobody thought of stays protected.
function buildReadSafePaths(): string[] {
  const home = os.homedir();
  return [
    // EGC's own install surface: shim manifest and the binaries it wraps.
    path.join(home, '.egc', 'bin'),
    // Token Crusher ledger, which `egc gain` reports from.
    path.join(home, '.egc', 'metrics'),
    path.join(home, '.egc', 'logs'),
    // Service definitions: what runs, and how.
    '/etc/systemd',
    path.join(home, '.config', 'systemd', 'user'),
    // Listing what sits ahead of /usr/bin on PATH is diagnosis, not exposure.
    path.join(home, '.local', 'bin'),
  ];
}

export const READ_SAFE_PATHS: string[] = buildReadSafePaths();

// Files that are dangerous to modify but harmless to read: shell startup
// files and git config are persistence mechanisms, not credential stores.
// Anchored, and only ever consulted for a path that is NOT inside a denied
// directory -- otherwise a file named ~/.ssh/.gitconfig would read as safe.
const READ_SAFE_FILE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.(bashrc|zshrc|bash_profile|zprofile|profile)$/,
  /(^|[\\/])\.gitconfig$/,
  /(^|[\\/])\.git[\\/](config|hooks)$/,
  /(^|[\\/])\.git[\\/]hooks[\\/]/,
];

function isUnder(candidate: string, parent: string): boolean {
  const resolvedParent = foldCase(resolveRealOrLexical(parent));
  const folded = foldCase(candidate);
  return folded === resolvedParent || folded.startsWith(resolvedParent + path.sep);
}

// Whether the protection comes from the path living inside a denied
// directory (a credential store) rather than from the filename alone.
function isUnderDeniedDirectory(normalizedP: string): boolean {
  return DENIED_PATHS.some(denied => isUnder(normalizedP, denied));
}

export function isReadDeniedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Not protected at all: nothing to decide.
  if (!isProtectedPath(p, baseDir)) return false;

  const trimmed = p.trim();
  const expanded = expandHome(trimmed);
  const normalizedP = resolveRealOrLexical(path.resolve(baseDir, expanded));

  // An explicitly operational location is readable.
  if (READ_SAFE_PATHS.some(safe => isUnder(normalizedP, safe))) return false;

  // Inside a credential store, the filename means nothing: deny.
  if (isUnderDeniedDirectory(normalizedP)) return true;

  // Protection came from the filename alone. Allow the persistence-only
  // ones; everything else (.env, .pem, tokens, auth files) stays denied.
  // Folded on the same terms as the denial side: where the filesystem opens
  // ~/.BASHRC and ~/.bashrc as one file, both spellings have to be readable,
  // or the case fix would have quietly turned a harmless read into a denial.
  return !READ_SAFE_FILE_PATTERNS.some(pattern => pattern.test(foldCase(normalizedP)));
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  trust_level?: 'SAFE_READONLY' | 'SAFE_DEV' | 'DANGEROUS' | 'BLOCKED';
  // True only for the two verdicts the enforcement hook may treat as advice
  // (allowlist miss, shell metacharacters). The hook reads this field, so
  // whatever text a command puts into a reason cannot soften a hard block.
  advisory?: boolean;
}

/**
 * Validate arguments for a specific allowed command.
 * Returns { allowed: false, reason } if the args are unsafe.
 */
// Config keys whose value git runs as a command or program, or that make it
// run one (hooks, templates, included files, transport helpers), enumerated
// from the git-config manual of git 2.51. Set with git config they take
// effect on every later git invocation, not just the one that set them; set
// inline with -c they run in that very call. core.hooksPath repoints where
// git looks for hooks (including the DCO/commit hooks this project relies
// on); a pager, editor, textconv or driver runs on ordinary reads, checkouts,
// diffs and merges; a credential helper receives every credential request;
// include.path and includeIf load another config file wholesale;
// init.templateDir seeds the hooks of every repository git creates. A key
// set from the environment (--config-env) is judged without its value, which
// the command line does not show.
interface GitConfigKeyRule {
  // The section, which a rename would carry keys into.
  section: string;
  key: RegExp;
  // When given, only a value it accepts runs something.
  runs?: (value: string, cwd?: string) => boolean;
}

// git reads a pager.<cmd> value that parses as a boolean as on or off, and
// anything else as the pager command.
const GIT_BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off|\d+)?$/i;

const DANGEROUS_GIT_CONFIG_RULES: GitConfigKeyRule[] = [
  { section: 'core', key: /^core\.(?:hookspath|pager|editor|sshcommand|fsmonitor|gitproxy|askpass|alternaterefscommand)$/ },
  { section: 'credential', key: /^credential\.(?:.+\.)?helper$/ },
  { section: 'diff', key: /^diff\.(?:external|.+\.(?:command|textconv))$/ },
  { section: 'include', key: /^include\.path$/ },
  { section: 'includeif', key: /^includeif\..+\.path$/ },
  { section: 'merge', key: /^merge\..+\.driver$/ },
  { section: 'filter', key: /^filter\..+\.(?:clean|smudge|process)$/ },
  { section: 'difftool', key: /^difftool\..+\.(?:cmd|path)$/ },
  { section: 'mergetool', key: /^mergetool\..+\.(?:cmd|path)$/ },
  { section: 'man', key: /^man\..+\.(?:cmd|path)$/ },
  { section: 'browser', key: /^browser\..+\.(?:cmd|path)$/ },
  { section: 'guitool', key: /^guitool\..+\.cmd$/ },
  { section: 'gpg', key: /^gpg\.(?:program|.+\.program|ssh\.defaultkeycommand)$/ },
  { section: 'remote', key: /^remote\..+\.(?:uploadpack|receivepack|vcs)$/ },
  { section: 'tar', key: /^tar\..+\.command$/ },
  { section: 'trailer', key: /^trailer\..+\.(?:command|cmd)$/ },
  { section: 'sendemail', key: /^sendemail\.(?:.+\.)?(?:tocmd|cccmd|headercmd|sendmailcmd)$/ },
  // A full path is a sendmail-like program; a host name is just a server.
  { section: 'sendemail', key: /^sendemail\.(?:.+\.)?smtpserver$/, runs: value => /[\\/]/.test(value) },
  { section: 'sequence', key: /^sequence\.editor$/ },
  { section: 'gc', key: /^gc\.recentobjectshook$/ },
  { section: 'imap', key: /^imap\.tunnel$/ },
  { section: 'instaweb', key: /^instaweb\.httpd$/ },
  { section: 'interactive', key: /^interactive\.difffilter$/ },
  { section: 'uploadpack', key: /^uploadpack\.packobjectshook$/ },
  { section: 'init', key: /^init\.templatedir$/ },
  { section: 'pager', key: /^pager\..+$/, runs: value => !GIT_BOOLEAN_VALUE.test(stripQuotes(value).trim()) },
  { section: 'submodule', key: /^submodule\..+\.update$/, runs: value => stripQuotes(value).trim().startsWith('!') },
  // The ext:: transport runs the command its URL names once it is allowed.
  { section: 'protocol', key: /^protocol\.(?:ext\.)?allow$/, runs: value => /^(?:always|user)$/i.test(stripQuotes(value).trim()) },
  { section: 'alias', key: /^alias\..+$/, runs: (value, cwd) => isDangerousAliasValue(value, cwd) },
];
// An alias is a shell-escape risk when its value starts with '!' (git's
// own syntax for "run this as a shell command" instead of a git subcommand),
// or when its value's first token is -c, --config-env, or 'config' (which allows proxying
// Global git flags that take a value and can appear BEFORE the subcommand
// (`git -c foo=bar config ...`, `git -C /path config ...`), mirroring the
// same set block-no-verify.js already trusts for this exact purpose. Without
// skipping these (and their values), a global flag in front of `config`
// shifts the subcommand out of args[0] and the dangerous-key check below is
// never reached at all.
const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix', '--config-env']);

function isDangerousAliasValue(value: string, cwd?: string): boolean {
  const trimmed = stripEnclosingQuotes(value);
  if (stripQuotes(trimmed).startsWith('!')) return true;
  const words = tokenizeWords(trimmed);
  // An alias is judged by the git command it expands to: one that hides
  // a refused force or a clean is as dangerous as typing it.
  if (!validateGitArgs(words, cwd).allowed) return true;

  let i = 0;
  while (i < words.length) {
    const raw = words[i];
    const word = stripQuotes(raw);
    if (word.startsWith('!') || word.startsWith('-c') || word.startsWith('--config-env') || word === 'config') {
      return true;
    }
    if (GIT_GLOBAL_FLAGS_WITH_ARG.has(word)) {
      i += 2;
      continue;
    }
    if (word.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }

  if (i < words.length) {
    const raw = words[i];
    const word = stripQuotes(raw);
    if (word.startsWith('!') || word.startsWith('-c') || word.startsWith('--config-env') || word === 'config') {
      return true;
    }
  }

  return false;
}

// How git config reads its arguments, measured on git 2.51. A subcommand
// (set, get, ...) counts only as the very first word; otherwise the action
// comes from an option, and with none it reads one key or sets a key to a
// value. Options end at the first operand in every form, so a word after
// the key is an operand even when it looks like an option: `git config
// core.hooksPath /tmp/x --get` sets the key, with --get as a value pattern.
type GitConfigAction = 'read' | 'remove' | 'set' | 'rename' | 'edit';

const GIT_CONFIG_SUBCOMMANDS = new Map<string, GitConfigAction>([
  ['list', 'read'], ['get', 'read'], ['set', 'set'], ['unset', 'remove'],
  ['remove-section', 'remove'], ['rename-section', 'rename'], ['edit', 'edit'],
]);
const GIT_CONFIG_ACTION_OPTIONS = new Map<string, GitConfigAction>([
  ['--get', 'read'], ['--get-all', 'read'], ['--get-regexp', 'read'], ['--get-urlmatch', 'read'],
  ['--get-color', 'read'], ['--get-colorbool', 'read'], ['--list', 'read'],
  ['--unset', 'remove'], ['--unset-all', 'remove'], ['--remove-section', 'remove'],
  ['--rename-section', 'rename'], ['--add', 'set'], ['--replace-all', 'set'], ['--edit', 'edit'],
]);
// Long options that take the next word as their value unless it is glued on
// with =, abbreviated or not: `--comment --get` is a comment, not a read.
const GIT_CONFIG_VALUE_OPTIONS = ['--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];
// Options that change neither the action nor the operands.
const GIT_CONFIG_SWITCHES = new Set([
  '--global', '--system', '--local', '--worktree', '--includes', '--no-includes',
  '--null', '--name-only', '--show-origin', '--show-scope', '--show-names',
  '--fixed-value', '--all', '--regexp', '--append',
  '--bool', '--int', '--bool-or-int', '--bool-or-str', '--path', '--expiry-date', '--no-type',
]);
// Short options, read letter by letter in a cluster such as -zl or -zf FILE:
// f and t take the rest of the cluster, or the next word when none is left.
const GIT_CONFIG_SHORT_OPTIONS = new Map<string, GitConfigAction | 'switch' | 'file' | 'value'>([
  ['l', 'read'], ['e', 'edit'], ['z', 'switch'], ['f', 'file'], ['t', 'value'],
]);

interface GitConfigCall {
  actions: GitConfigAction[];
  // The files -f/--file (and --blob) name.
  files: string[];
  operands: string[];
  // An option this does not know may take a value and shift every word
  // after it, so the call is then judged as the write it may be.
  unsure: boolean;
}

// The index of the last word an option cluster uses.
function readGitConfigCluster(rest: string[], i: number, call: GitConfigCall): number {
  const cluster = stripQuotes(rest[i]);
  for (let j = 1; j < cluster.length; j++) {
    const kind = GIT_CONFIG_SHORT_OPTIONS.get(cluster[j]);
    if (kind === undefined) {
      call.unsure = true;
      return i;
    }
    if (kind === 'switch') continue;
    if (kind !== 'file' && kind !== 'value') {
      call.actions.push(kind);
      continue;
    }
    const glued = cluster.slice(j + 1);
    const value = glued === '' ? rest[i + 1] : glued;
    if (kind === 'file' && value !== undefined) call.files.push(stripQuotes(value));
    return glued === '' ? i + 1 : i;
  }
  return i;
}

const GIT_CONFIG_LONG_OPTIONS = [...GIT_CONFIG_ACTION_OPTIONS.keys(), ...GIT_CONFIG_SWITCHES, ...GIT_CONFIG_VALUE_OPTIONS];

// The long option a word names, read as git reads it: its exact name, or
// else the one option its name is a prefix of (`--ren` is
// --rename-section). null when it names none or several, which git refuses;
// a value glued on with = counts only for an option that takes one.
function resolveGitConfigLong(option: string): string | null {
  const eq = option.indexOf('=');
  const name = eq < 0 ? option : option.slice(0, eq);
  const matches = GIT_CONFIG_LONG_OPTIONS.filter(flag => flag.startsWith(name));
  let full: string | null = null;
  if (matches.includes(name)) full = name;
  else if (matches.length === 1) full = matches[0];
  return full !== null && (eq < 0 || GIT_CONFIG_VALUE_OPTIONS.includes(full)) ? full : null;
}

// The index of the last word the option at i uses.
function readGitConfigOption(rest: string[], i: number, call: GitConfigCall): number {
  const option = stripQuotes(rest[i]);
  if (!option.startsWith('--')) return readGitConfigCluster(rest, i, call);
  const valued = resolveGitConfigLong(option);
  if (valued === null) {
    call.unsure = true;
    return i;
  }
  const action = GIT_CONFIG_ACTION_OPTIONS.get(valued);
  if (action !== undefined) {
    call.actions.push(action);
    return i;
  }
  if (GIT_CONFIG_SWITCHES.has(valued)) return i;
  const glued = option.includes('=');
  const value = glued ? option.slice(option.indexOf('=') + 1) : rest[i + 1];
  if ((valued === '--file' || valued === '--blob') && value !== undefined) call.files.push(stripQuotes(value));
  return glued ? i : i + 1;
}

// `rest` is everything after 'config'.
function parseGitConfigCall(rest: string[]): GitConfigCall {
  const call: GitConfigCall = { actions: [], files: [], operands: [], unsure: false };
  const subcommand = GIT_CONFIG_SUBCOMMANDS.get(stripQuotes(rest[0] ?? ''));
  if (subcommand !== undefined) call.actions.push(subcommand);
  let i = subcommand === undefined ? 0 : 1;
  while (i < rest.length) {
    const word = stripQuotes(rest[i]);
    if (word === '--') {
      i += 1;
      break;
    }
    if (word.length < 2 || !word.startsWith('-')) break;
    i = readGitConfigOption(rest, i, call) + 1;
  }
  call.operands = rest.slice(i);
  if (call.actions.length === 0) call.actions.push(call.operands.length >= 2 ? 'set' : 'read');
  return call;
}

// `value` is undefined when the command line does not show it.
function isDangerousGitConfigWrite(key: string, value: string | undefined, cwd?: string): boolean {
  const lowerKey = key.toLowerCase();
  return DANGEROUS_GIT_CONFIG_RULES.some(rule => rule.key.test(lowerKey)
    && (rule.runs === undefined || value === undefined || rule.runs(value, cwd)));
}

// A section renamed into one that holds the keys above turns the keys it
// carries into those keys.
function isDangerousGitConfigSection(section: string): boolean {
  const name = section.toLowerCase().split('.')[0];
  return DANGEROUS_GIT_CONFIG_RULES.some(rule => rule.section === name);
}

const GIT_CONFIG_EDIT_DENIAL: ValidationResult = {
  allowed: false,
  reason: `git config --edit opens an editable session over the config file and is forbidden`,
  trust_level: 'DANGEROUS',
};

// Called only once the 'config' subcommand itself has been identified;
// `args` is everything after 'git' (so args[0] === 'config'). A set of one
// of the dangerous keys above is denied, and so is renaming a section into
// one that holds them, or an editor session, whose changes cannot be read
// the way a key and a value can. Reading or unsetting a key is left alone.
// Every key and value pair among the operands is judged, so a value an
// unknown option took cannot hide the key behind it.
function checkGitConfigWrite(args: string[], cwd?: string): ValidationResult | null {
  const call = parseGitConfigCall(args.slice(1));
  if (call.actions.includes('edit')) return GIT_CONFIG_EDIT_DENIAL;
  const operands = call.operands;
  const maySet = call.unsure || call.actions.includes('set');
  for (let k = 0; maySet && k + 1 < operands.length; k++) {
    const key = stripQuotes(operands[k]);
    if (!isDangerousGitConfigWrite(key, stripEnclosingQuotes(operands[k + 1]), cwd)) continue;
    return {
      allowed: false,
      reason: `git config write to '${key}' persists a hook/execution-bypass override and is forbidden`,
      trust_level: 'DANGEROUS',
    };
  }
  const section = call.actions.includes('rename')
    ? operands.slice(1).map(stripQuotes).find(name => isDangerousGitConfigSection(name))
    : undefined;
  if (section === undefined) return null;
  return {
    allowed: false,
    reason: `git config rename of a section to '${section}' would carry its keys into a hook/execution-bypass override and is forbidden`,
    trust_level: 'DANGEROUS',
  };
}

// Returns the index of the actual subcommand token (skipping global flags
// and their values), not just its name - reusing this same index to slice
// `args` is what keeps "is the subcommand config" and "where does config's
// own arg list start" from ever disagreeing with each other, which a second,
// independent indexOf/findIndex scan over the same array could do (e.g. if
// 'config' also appears earlier as the VALUE of a global flag like `-C`).
function findGitSubcommandIndex(args: string[]): number {
  let i = 0;
  while (i < args.length) {
    const t = bareToken(args[i]);
    if (!t.startsWith('-')) return i;
    if (GIT_GLOBAL_FLAGS_WITH_ARG.has(t)) i += 2;
    else i += 1;
  }
  return -1;
}

// The key and value an inline override sets. --config-env names the
// environment variable that holds the value, so the value is unknown.
function parseInlineConfigToken(token: string, nextToken: string | undefined): { key: string; value: string | undefined; consumedNext: boolean } | null {
  const stripped = stripQuotes(token);
  const bare = bareToken(token);
  let rawPair: string | null = null;
  let consumedNext = false;

  if (bare === '-c' || bare === '--config-env') {
    if (nextToken !== undefined) {
      rawPair = stripQuotes(nextToken);
      consumedNext = true;
    }
  } else if (bare.startsWith('--config-env=')) {
    rawPair = stripped.slice('--config-env='.length);
  } else if (bare.startsWith('-c=')) {
    rawPair = stripped.slice(3);
  } else if (bare.startsWith('-c') && bare.length > 2) {
    rawPair = stripped.slice(2);
  }

  if (rawPair === null) return null;

  const eq = rawPair.indexOf('=');
  const key = (eq > 0 ? rawPair.slice(0, eq) : rawPair).toLowerCase();
  if (bare.startsWith('--config-env')) return { key, value: undefined, consumedNext };
  const value = eq > 0 ? rawPair.slice(eq + 1) : '';
  return { key, value, consumedNext };
}

function checkInlineGitConfigOverrides(args: string[], cwd?: string): ValidationResult | null {
  const subIdx = findGitSubcommandIndex(args);
  const limit = subIdx >= 0 ? subIdx : args.length;
  for (let i = 0; i < limit; i++) {
    const pair = parseInlineConfigToken(args[i], args[i + 1]);
    if (!pair) continue;
    if (pair.consumedNext) i += 1;
    if (isDangerousGitConfigWrite(pair.key, pair.value, cwd)) {
      return {
        allowed: false,
        reason: `git inline config override for '${pair.key}' persists a hook/execution-bypass override and is forbidden`,
        trust_level: 'DANGEROUS',
      };
    }
  }
  return null;
}

// Force flags are judged per git subcommand. The refusal names what the
// command would actually do, so a reader who never opened the git manual
// knows why it stopped and what to do instead. Subcommands absent from every
// table keep the flag refused: the policy fails closed.
interface GitForceRefusal {
  reason: string;
  extraFlags?: string[];
}

const GIT_FORCE_REFUSED = new Map<string, GitForceRefusal>([
  ['push', {
    reason: 'git force-push is forbidden: it would overwrite the shared history on the server and other people could lose their work. Even with a lease it rewrites commits other people already pulled. Push normally, or ask the maintainer.',
  }],
  ['checkout', {
    reason: 'git checkout with force is forbidden: it would throw away changes you have not committed. Save them first with git stash, then try again.',
  }],
  ['switch', {
    reason: 'git switch with force is forbidden: it would throw away changes you have not committed. Save them first with git stash, then try again.',
    extraFlags: ['--discard-changes'],
  }],
  ['rm', {
    reason: 'git rm with force is forbidden: it would delete files you changed but did not commit. Commit or stash them first.',
  }],
  ['mv', {
    reason: 'git mv with force is forbidden: it would overwrite the destination file. Pick another name, or remove the destination first.',
  }],
  ['submodule', {
    reason: 'git submodule with force is forbidden: it would discard changes inside the submodule. Commit or stash them there first.',
  }],
]);

// Disposable working copies: removing or adding one touches no history and
// no remote, so the force flag is the honest way to drop one that still holds
// untracked files. The path itself is still checked against protected paths.
const GIT_FORCE_ALLOWED = new Set(['worktree']);

// Read-only subcommands where a short f names a file or a format and no
// force option exists, so neither spelling is a force.
const GIT_FORCE_NOT_APPLICABLE = new Set([
  'grep', 'config', 'log', 'diff', 'show', 'blame', 'status', 'shortlog',
  'rev-list', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'describe',
]);

const GIT_FORCE_LONG_FLAGS = ['--force', '--force-with-lease', '--force-if-includes'];
const GIT_LONG_FLAG_MIN_ABBREVIATION = 4;

const GIT_CLEAN_REASON = 'git clean is forbidden unless it is a dry run: it can permanently delete files git is not tracking, with no way to get them back. To only list what would be deleted, run git clean -nd.';

// git accepts any unique prefix of a long option (--forc, --force-with-leas),
// so a token is read as the option it abbreviates. Only prefixes of the full
// name count, which leaves --force-rebase and --no-force-with-lease out.
function abbreviates(token: string, fullFlag: string): boolean {
  const base = token.split('=')[0];
  return base.length >= GIT_LONG_FLAG_MIN_ABBREVIATION && fullFlag.startsWith(base);
}

function isLongGitForceFlag(token: string): boolean {
  return GIT_FORCE_LONG_FLAGS.some(flag => abbreviates(token, flag));
}

function hasShortForceCluster(token: string): boolean {
  return /^-[a-zA-Z]*f/.test(token);
}

// -n is a dry run only when git reads it as a flag, and the last word wins:
// --no-dry-run cancels it, nothing after -- is an option, inside a cluster
// the first e turns the rest of the cluster into the exclude pattern, and a
// separate -e or --exclude (abbreviations included) consumes the next token.
// What one token of `git clean` does to the dry-run reading: sets it, clears
// it, or leaves it (null), and how many tokens after it are its value.
function gitCleanTokenEffect(token: string): { dryRun: boolean | null; skip: number } {
  if (abbreviates(token, '--dry-run')) return { dryRun: true, skip: 0 };
  if (abbreviates(token, '--no-dry-run')) return { dryRun: false, skip: 0 };
  if (token === '-e' || (abbreviates(token, '--exclude') && !token.includes('='))) return { dryRun: null, skip: 1 };
  if (!/^-[a-zA-Z]+$/.test(token)) return { dryRun: null, skip: 0 };
  const letters = token.slice(1);
  const excludeAt = letters.indexOf('e');
  const flags = excludeAt >= 0 ? letters.slice(0, excludeAt) : letters;
  return { dryRun: flags.includes('n') ? true : null, skip: excludeAt === letters.length - 1 ? 1 : 0 };
}

function isGitCleanDryRun(rest: string[]): boolean {
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--') break;
    const effect = gitCleanTokenEffect(token);
    if (effect.dryRun !== null) dryRun = effect.dryRun;
    i += effect.skip;
  }
  return dryRun;
}

function checkGitClean(rest: string[]): ValidationResult | null {
  if (isGitCleanDryRun(rest)) return null;
  return { allowed: false, reason: GIT_CLEAN_REASON, trust_level: 'DANGEROUS' };
}

function checkGitWorktreePaths(rest: string[], cwd?: string): ValidationResult | null {
  const terminator = rest.indexOf('--');
  const operands = terminator >= 0
    ? [...rest.slice(0, terminator).filter(a => !a.startsWith('-')), ...rest.slice(terminator + 1)]
    : rest.filter(a => !a.startsWith('-'));
  const target = operands.find(a => isProtectedOperand(a, cwd));
  if (target === undefined) return null;
  return {
    allowed: false,
    reason: `git worktree would touch the protected path '${target}' and is forbidden. Keep worktrees inside the project.`,
    trust_level: 'DANGEROUS',
  };
}

// The subcommand name goes into the refusal text, so it is reduced to the
// characters a git subcommand can have: a name carrying an advisory marker
// would otherwise turn the hard block into advice at the hook layer.
function gitSubcommandLabel(subcommand: string): string {
  const name = subcommand.replace(/[^a-z0-9-]/g, '').slice(0, 32);
  return name ? `git ${name}` : 'git';
}

function checkGitForceFlag(args: string[], subcommandIdx: number, cwd?: string): ValidationResult | null {
  const subcommand = subcommandIdx >= 0 ? bareToken(args[subcommandIdx]) : '';
  // Flags keep their case: -F names a file on commit and grep, only -f forces.
  const rest = (subcommandIdx >= 0 ? args.slice(subcommandIdx + 1) : args).map(stripQuotes);

  if (subcommand === 'clean') return checkGitClean(rest);
  if (GIT_FORCE_NOT_APPLICABLE.has(subcommand)) return null;
  if (GIT_FORCE_ALLOWED.has(subcommand)) return checkGitWorktreePaths(rest, cwd);

  // Nothing after the option terminator is an option.
  const terminator = rest.indexOf('--');
  const options = terminator >= 0 ? rest.slice(0, terminator) : rest;
  const hasLongForce = options.some(isLongGitForceFlag);
  const hasShortForce = options.some(a => a === '-f' || hasShortForceCluster(a));
  const refused = GIT_FORCE_REFUSED.get(subcommand);
  if (refused !== undefined) {
    const extra = refused.extraFlags ?? [];
    const hasForce = hasLongForce || hasShortForce
      || options.some(a => extra.some(flag => abbreviates(a, flag)))
      || (subcommand === 'push' && rest.some(a => a.startsWith('+') && a.length > 1));
    return hasForce ? { allowed: false, reason: refused.reason, trust_level: 'DANGEROUS' } : null;
  }

  if (!hasLongForce && !hasShortForce) return null;
  return {
    allowed: false,
    reason: `${gitSubcommandLabel(subcommand)} with force is not on the safe list, so it was blocked. If you believe it is safe, ask the maintainer to allow it.`,
    trust_level: 'DANGEROUS',
  };
}

// The index of the last word a git grep option cluster uses, noting the
// pattern file its f names: the rest of the cluster, or the next word when
// none is left (-if FILE). A letter before f that takes a value would make
// the f part of that value; reading it as the file anyway can only refuse
// more, never less.
function readGitGrepCluster(rest: string[], i: number, files: string[]): number {
  const cluster = rest[i];
  const f = cluster.indexOf('f', 1);
  if (f === -1) return i;
  const glued = cluster.slice(f + 1);
  const value = glued === '' ? rest[i + 1] : glued;
  if (value !== undefined) files.push(value);
  return glued === '' ? i + 1 : i;
}

// The pattern files of git grep (-f, --file), in every spelling git
// accepts: separate, glued (-fx, --file=x), abbreviated and inside a
// cluster. Nothing after -- is an option.
function gitGrepPatternFiles(rest: string[]): string[] {
  const files: string[] = [];
  let i = 0;
  while (i < rest.length && rest[i] !== '--') {
    const token = rest[i];
    if (token.startsWith('--')) i = readGitGrepLongOption(rest, i, files) + 1;
    else if (token.length > 1 && token.startsWith('-')) i = readGitGrepCluster(rest, i, files) + 1;
    else i += 1;
  }
  return files;
}

// The index of the last word a git grep long option uses, noting the file
// --file names.
function readGitGrepLongOption(rest: string[], i: number, files: string[]): number {
  const token = rest[i];
  if (!abbreviates(token, '--file')) return i;
  const glued = token.includes('=');
  const value = glued ? token.slice(token.indexOf('=') + 1) : rest[i + 1];
  if (value !== undefined) files.push(value);
  return glued ? i : i + 1;
}

// The file git config -f/--file names is read by every call and written by
// every call that is not a read: a set, an unset, a rename.
function checkGitConfigFiles(rest: string[], cwd?: string): ValidationResult | null {
  const call = parseGitConfigCall(rest);
  const read = call.files.find(p => isReadDeniedOperand(p, cwd));
  if (read !== undefined) return readDenial(`git config would read the protected file '${read}' and is forbidden.`, 'DANGEROUS');
  if (!call.unsure && call.actions.every(action => action === 'read')) return null;
  const written = call.files.find(p => isProtectedOperand(p, cwd));
  if (written === undefined) return null;
  return {
    allowed: false,
    reason: `git config would write the protected file '${written}' and is forbidden.`,
    trust_level: 'DANGEROUS',
  };
}

function checkGitFileOperands(subcommand: string, rest: string[], cwd?: string): ValidationResult | null {
  if (subcommand === 'config') return checkGitConfigFiles(rest, cwd);
  if (subcommand !== 'grep') return null;
  const protectedFile = gitGrepPatternFiles(rest).find(p => isReadDeniedOperand(p, cwd));
  if (protectedFile === undefined) return null;
  return readDenial(`git grep would read the protected file '${protectedFile}' and is forbidden.`, 'DANGEROUS');
}

// Subcommands that name paths without reading what is in them, so a
// protected path among their arguments exposes nothing. Any other
// subcommand that names a protected file reads it: into its output (diff
// --no-index, grep, blame, show <rev>:<path>, archive), into the object
// store where the next command prints it (add, hash-object), into a message
// (commit -F), or under a new name (mv). config is judged on its own.
const GIT_PATH_ONLY_SUBCOMMANDS = new Set([
  'status', 'ls-files', 'check-ignore', 'check-attr', 'rm', 'reset', 'restore', 'checkout', 'config',
]);
// A setting glued to -c (-ckey=value) configures git rather than name a
// file it reads, so its value is not read as a path.
function isGluedGitSetting(arg: string): boolean {
  return /^-c./.test(stripQuotes(arg));
}

// The values of the options among `rest` that name a file: a long one
// (abbreviated or not, the value glued with = or the next word) or a short
// one (the value glued on or the next word).
function gitOptionFiles(rest: string[], longFlags: string[], shortFlag: string | null): string[] {
  const files: string[] = [];
  for (let i = 0; i < rest.length && rest[i] !== '--'; i++) {
    const option = stripQuotes(rest[i]);
    const isLong = longFlags.some(flag => abbreviates(option, flag));
    if (!isLong && (shortFlag === null || !option.startsWith(shortFlag))) continue;
    const glued = isLong ? option.split('=').slice(1).join('=') : option.slice(shortFlag?.length);
    if (option.includes('=') || (!isLong && glued !== '')) files.push(glued);
    else if (rest[i + 1] !== undefined) files.push(stripQuotes(rest[i + 1]));
  }
  return files;
}

// The files git writes its output into instead of standard output: --output
// (the diff family, log, show, archive) and archive -o.
function gitOutputFiles(subcommand: string, rest: string[]): string[] {
  return gitOptionFiles(rest, ['--output'], subcommand === 'archive' ? '-o' : null);
}

// The files a path-only subcommand still reads: its pathspecs
// (--pathspec-from-file) or its ignore patterns (ls-files --exclude-from
// and -X).
function gitReadOptionFiles(subcommand: string, rest: string[]): string[] {
  return gitOptionFiles(rest, ['--pathspec-from-file', '--exclude-from'], subcommand === 'ls-files' ? '-X' : null);
}

// The nearest directory up from `dir` that holds a .git entry: the top of
// its work tree. `dir` itself when there is none.
function nearestGitTop(dir: string): string {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return dir;
  }
}

// Where git runs and the top of the work tree it reads, as its global
// options set them: each -C moves on from the last, --work-tree names the
// top outright, and otherwise the top is found up from where git runs.
function gitPlaces(globals: string[], cwd?: string): { dir: string; top: string } {
  let dir = path.resolve(cwd ?? process.cwd());
  let top: string | null = null;
  for (let i = 0; i < globals.length; i++) {
    const option = stripQuotes(globals[i]);
    const next = globals[i + 1] === undefined ? undefined : expandHome(stripQuotes(globals[i + 1]));
    if (option === '-C' && next !== undefined) dir = path.resolve(dir, next);
    else if (option === '--work-tree' && next !== undefined) top = path.resolve(dir, next);
    else if (option.startsWith('--work-tree=')) top = path.resolve(dir, expandHome(option.slice('--work-tree='.length)));
  }
  return { dir, top: top ?? nearestGitTop(dir) };
}

// The files that <rev>:<path>, :<stage>:<path> and :<path> objects among
// `operands` name in the work tree: git reads <path> from the top of the
// tree, or from where it runs when <path> starts with ./ or ../. A <path>
// that starts with a slash names nothing in the tree (git refuses it), and
// neither does a URL or a drive letter, whose part after the colon does.
function gitObjectFiles(globals: string[], operands: string[], cwd?: string): string[] {
  const places = gitPlaces(globals, cwd);
  return operands.flatMap(arg => {
    const word = stripQuotes(arg);
    const inside = word.startsWith('-') ? null : /^(?::\d)?[^:]*:([^/\\].*)$/.exec(word)?.[1];
    if (!inside) return [];
    return [path.resolve(/^\.\.?(?:[/\\]|$)/.test(inside) ? places.dir : places.top, inside)];
  });
}

function checkGitPathArguments(args: string[], subcommandIdx: number, cwd?: string): ValidationResult | null {
  const subcommand = subcommandIdx < 0 ? '' : bareToken(args[subcommandIdx]);
  const globals = (subcommandIdx < 0 ? args : args.slice(0, subcommandIdx)).filter(arg => !isGluedGitSetting(arg));
  const rest = subcommandIdx < 0 ? [] : args.slice(subcommandIdx + 1);
  const pathOnly = GIT_PATH_ONLY_SUBCOMMANDS.has(subcommand);
  const reached = pathOnly ? [...globals, ...gitReadOptionFiles(subcommand, rest)] : [...globals, ...rest];
  const objects = pathOnly ? [] : gitObjectFiles(globals, rest, cwd);
  const read = [...pathCandidatesOf(reached), ...objects].find(p => isReadDeniedOperand(p, cwd));
  if (read !== undefined) return readDenial(`git ${subcommand} would read the protected file '${read}' and is forbidden.`, 'DANGEROUS');
  const written = gitOutputFiles(subcommand, rest).find(p => isProtectedOperand(p, cwd));
  if (written === undefined) return null;
  return {
    allowed: false,
    reason: `git ${subcommand} would write the protected file '${written}' and is forbidden.`,
    trust_level: 'DANGEROUS',
  };
}

function validateGitArgs(args: string[], cwd?: string): ValidationResult {
  const subcommandIdx = findGitSubcommandIndex(args);
  const forceDenial = checkGitForceFlag(args, subcommandIdx, cwd);
  if (forceDenial) return forceDenial;

  const inlineOverrideDenial = checkInlineGitConfigOverrides(args, cwd);
  if (inlineOverrideDenial) return inlineOverrideDenial;

  const pathDenial = checkGitPathArguments(args, subcommandIdx, cwd);
  if (pathDenial) return pathDenial;

  if (subcommandIdx < 0) return { allowed: true, trust_level: 'SAFE_READONLY' };
  const subcommand = bareToken(args[subcommandIdx]);
  const rest = args.slice(subcommandIdx + 1);
  const fileDenial = checkGitFileOperands(subcommand, rest, cwd);
  if (fileDenial) return fileDenial;
  if (subcommand === 'config') {
    const configDenial = checkGitConfigWrite(args.slice(subcommandIdx), cwd);
    if (configDenial) return configDenial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

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

function validateGrepArgs(args: string[], cwd?: string): ValidationResult {
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

function validateCatArgs(args: string[], cwd?: string): ValidationResult {
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

function validateFindArgs(args: string[], cwd?: string): ValidationResult {
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
    if (!committedScript || findActionIsGrave(args, cwd) || !flagsInCommittedScript(denial)) return denial;
  }

  for (const p of findStartingPoints(args)) {
    const denial = isProtectedOperand(p, cwd) ? readDenial(`find over protected path '${p}' is forbidden`) : null;
    if (denial) return denial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

function validateReadOnlyPathArgs(baseCommand: string, args: string[], cwd?: string): ValidationResult {
  // These are read-only but we still block protected paths
  for (const arg of args) {
    const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
    const denial = candidate !== null && isReadDeniedOperand(candidate, cwd) ? readDenial(`${baseCommand} on protected path '${arg}' is forbidden`) : null;
    if (denial) return denial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

function validateDevToolArgs(baseCommand: string, args: string[], cwd?: string): ValidationResult {
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

export function validateCommandArgs(
  baseCommand: string,
  args: string[],
  cwd?: string,
): ValidationResult {
  switch (baseCommand) {
    case 'git': return validateGitArgs(args, cwd);
    case 'grep': return validateGrepArgs(args, cwd);
    case 'cat': return validateCatArgs(args, cwd);
    case 'find': return validateFindArgs(args, cwd);
    case 'head':
    case 'stat':
    case 'ls': return validateReadOnlyPathArgs(baseCommand, args, cwd);
    case 'npm':
    case 'npx':
    case 'node':
    case 'tsc':
    case 'egc':
    case 'gh':
      // egc and gh joined the safe list, so they need the protected-path
      // check the generic allowlist-miss path used to run for them, and the
      // trust level of the tier they are on.
      return validateDevToolArgs(baseCommand, args, cwd);
    default:
      return { allowed: true, trust_level: 'SAFE_READONLY' };
  }
}

export function validateCommand(command: string, cwd?: string): ValidationResult {
  const verdict = validateCommandVerdict(command, cwd);
  return { ...verdict, advisory: verdict.advisory === true };
}

// A command out of a script committed in git and unchanged since: a grave
// denial blocks it as usual; a rule it met that only exists to stop hiding
// flags it, unless something grave follows.
export function validateCommittedScriptCommand(command: string, cwd?: string, bound: Readonly<Record<string, readonly string[]>> = {}): ValidationResult {
  committedScript = true;
  committedFlag = null;
  committedBound = new Map(Object.entries(bound));
  try {
    const verdict = validateCommand(command, cwd);
    if (committedFlag === null || (!verdict.allowed && !verdict.advisory)) return verdict;
    return {
      ...committedFlag,
      advisory: true,
      reason: `${committedFlag.reason} (flagged, not blocked: it runs from a script committed in git and unchanged since)`,
    };
  } finally {
    committedScript = false;
    committedFlag = null;
    committedBound = new Map();
  }
}

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
function isGraveTarget(arg: string, cwd?: string): boolean {
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
    const values = committedBound.get(variable[1] ?? variable[2]) ?? [];
    if (values.length === 0 || (rest !== '' && !/^[\\/]/.test(rest)) || /[$`*?[]/.test(rest)) return false;
    return values.every(value => isNarrowValue(value + rest, cwd));
  }
  if (/[$`]/.test(candidate) || isProtectedOperand(candidate, cwd)) return false;
  const expanded = expandHome(withHomeSpelled(candidate));
  return path.isAbsolute(expanded) ? isNarrowAbsolute(path.resolve(expanded)) : isNarrowRelative(expanded);
}

// A value a committed script sets a variable to is narrow when it is a
// fresh temporary path (`$(mktemp ...)`), a narrow literal path, or ends in
// at least two literal components below whatever it starts from (a named
// file deep in some directory, as `$BASE/.mvn/wrapper/maven-wrapper.jar`).
function isNarrowValue(value: string, cwd?: string): boolean {
  if (/^(?:\$\(|`)mktemp\b/.test(value)) return true;
  if (!/[$`]/.test(value)) return isNarrowTarget(value, cwd);
  const parts = value.split(/[\\/]/);
  let literal = 0;
  while (literal < parts.length - 1 && /^[^$`*?[]+$/.test(parts[parts.length - 1 - literal]) && !['.', '..'].includes(parts[parts.length - 1 - literal])) literal += 1;
  return literal >= 2;
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

function evalOrDangerousVerdict(baseCommand: string, args: string[], cwd?: string): ValidationResult | null {
  // 2. `eval` executes its entire argument list as shell code, the same
  // risk class as `bash -c`, but with no separate flag to opt into eval mode
  // (the invocation itself IS the eval), so it is always denied rather than
  // matched via INLINE_EVAL_COMMANDS' flag detection below.
  if (baseCommand === 'eval' && args.length > 0) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `inline code execution via 'eval' is forbidden, write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
    if (!flagsInCommittedScript(denial)) return denial;
  }

  // 3. Dangerous commands: denied regardless of args, except in a committed
  // script, where only a protected or top-level target is grave.
  if (DANGEROUS.includes(baseCommand)) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `'${baseCommand}' is a destructive command and is always denied`,
      trust_level: 'DANGEROUS',
    };
    if (!committedScript || args.some(arg => isGraveTarget(arg, cwd)) || !flagsInCommittedScript(denial)) return denial;
  }
  return null;
}

function validateCommandVerdict(command: string, cwd?: string): ValidationResult {
  // A trailing `# comment` is inert text, not part of any command, so it is
  // removed before anything reads the line; a `#` in quotes or in a ${...}
  // expansion stays (stripTrailingComment walks those spans).
  command = stripTrailingComment(command);
  // 1. Tokenize quote-aware (so a quoted wrapper-flag value with embedded
  // whitespace can't misalign the unwrap below), then peel off leading
  // environment-variable assignments and known wrapper commands (sudo,
  // timeout, xargs, ...) recursively until the real command is reached. A
  // dangerous env assignment (GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH, ...)
  // hard-blocks here instead of being silently stripped.
  const rawTokens = tokenizeWords(command);
  if (rawTokens.length === 0) {
    return { allowed: true, trust_level: 'SAFE_READONLY' };
  }
  // Brace expansion runs on every word of the line, the command word and
  // the wrappers included, since `r{m,}` names `rm` to the shell; a word
  // with more expansions than this check reads refuses the command as a
  // whole, because a word the shell would hand over must never go unjudged.
  const expandedTokens = expandArguments(rawTokens);
  if (expandedTokens === null) {
    return {
      allowed: false,
      reason: `a word of the command carries more brace expansions than this check reads (${MAX_BRACE_EXPANSIONS}), so the command is refused; spell the words out`,
      trust_level: 'DANGEROUS',
    };
  }
  const unwrapped = unwrapLeadingConstructs(expandedTokens);
  if (unwrapped.blocked) return unwrapped.blocked as ValidationResult;
  const tokens = unwrapped.tokens;
  if (tokens.length === 0) {
    return { allowed: true, trust_level: 'SAFE_READONLY' };
  }

  // Judge the command by its final path segment. Spelling out an absolute or
  // relative path (/bin/rm, ./mv, /usr/bin/python3) must not sidestep the
  // name-based destructive and inline-eval denials below. bareToken() first
  // strips quotes/backslashes so `"rm"`, 'rm', and \rm all resolve the same
  // as a bare rm — without it, a quoted or escaped base command slips past
  // every check below and falls through to the advisory allowlist-miss path.
  const baseCommand = path.basename(bareToken(tokens[0]));
  // The checks below read each argument as the word the shell hands the
  // command (the brace expansions already made above), so a flag or a path
  // written between quotes is the flag or the path it is; the redirection
  // scan reads the raw line on its own.
  const args = tokens.slice(1).map(shellWord);

  // 2 and 3. `eval`, and the destructive commands.
  const evalOrDangerous = evalOrDangerousVerdict(baseCommand, args, cwd);
  if (evalOrDangerous) return evalOrDangerous;

  // 4. Inline code execution (python3 -c, bash -c, node -e, su -c, etc.) is a
  // hard deny, not an allowlist check. This runs before the allowlist-
  // membership check on purpose: the base command being outside
  // SAFE_READONLY/SAFE_DEV (e.g. 'python3', 'bash') is only advisory at the
  // enforcement hook layer, by design, so that legitimate commands outside
  // this tiny allowlist (docker, pytest, cargo, go...) don't get hard-blocked
  // wholesale. Inline eval is different: it lets ANY base command execute
  // arbitrary code that bypasses every other check in this file, so it must
  // hard-block regardless of allowlist status. Using DANGEROUS here (not
  // BLOCKED) keeps the reason string out of the hook's advisory-reason list.
  // A versioned interpreter binary (python3.11, perl5.36) carries the same
  // eval power as its bare name; fall back to the version-stripped name.
  // Args are bareToken()'d before matching so a quoted/glued flag (e.g.
  // "--eval=code" with the whole flag=value inside one pair of quotes)
  // can't dodge the exact/prefix comparisons in matchesEvalFlag.
  // The name the eval table answers to (bare, or version-stripped) is also
  // the name the cluster exclusion is keyed on, so `pwsh7 -NonInteractive`
  // is judged as PowerShell just like `pwsh`.
  const inlineEval = inlineEvalVerdict(baseCommand, args);
  if (inlineEval) return inlineEval;

  // 5. Destructive variants of common CLIs (docker prune/rm, gh delete,
  // prisma reset...) hard-block for the same reason inline eval does: the
  // allowlist miss below is advisory-only at the hook layer, so without this
  // check `docker system prune -af` would execute with nothing but a
  // warning. Non-destructive forms of these CLIs keep the advisory path,
  // and package runners (npx, yarn...) are unwrapped to the inner command.
  const destructiveDenial = destructiveVerdict(baseCommand, args);
  if (destructiveDenial) return destructiveDenial;

  // 5b. A redirection target is a file the shell opens for the command,
  // written (`>`, `>>`, `&>`) or read (`<`), and is judged against the
  // protected paths here, before the per-command checks, which only see
  // the argument the operator was glued to. The command line is read
  // whole, the way the shell reads it, since a redirection may stand
  // before the command, behind a wrapper or an environment assignment,
  // or inside a process substitution.
  const redirected = redirectionVerdict(command, cwd);
  if (redirected) return redirected;

  // 6. Per-command checks (protected paths, destructive git/find forms,
  // dev-tool targets) and the allowlist verdict, always. They used to sit
  // behind the metacharacter step below, so any `2>/dev/null`, pipe or `$`
  // in the command made that advisory-only step return first and the
  // protected-path denial for `cat ~/.ssh/id_rsa 2>/dev/null` never ran.
  const verdict = validateAgainstAllowlist(baseCommand, args, cwd, tokens.slice(1));
  if (!verdict.allowed && !isAllowlistMissVerdict(verdict)) return verdict;

  // 7. Shell metacharacters: an advisory-only signal (see ADVISORY_REASONS
  // in the enforcement hook), reported only once every hard check above has
  // had its say. Checking this first (as before) let a stray $/`/pipe
  // elsewhere in the command — routinely present in legitimate quoted
  // arguments, e.g. `git commit -m "fix: a && b"` — short-circuit the
  // function before the real denials ever ran.
  if (SHELL_META_REGEX.test(command)) {
    return {
      allowed: false,
      reason: 'Shell chaining/metacharacters are forbidden',
      trust_level: 'BLOCKED',
      advisory: true,
    };
  }

  return verdict;
}

const ALLOWLIST_MISS_MARKER = 'is not in the allowlist';

// The allowlist miss is the one denial the step above may look past, so that
// the metacharacter check still gets to speak. The verdict says so through
// its advisory field: a reason quotes the path, alias key or file name the
// command carried, and scanning that text for the marker let any of them
// impersonate the miss and walk out of the hard denial it had just earned.
function isAllowlistMissVerdict(verdict: ValidationResult): boolean {
  return !verdict.allowed && verdict.advisory === true;
}

// Filesystem targets an argument can carry: a bare operand (URIs excluded,
// they are download targets, not local paths), a --flag=value value, or a
// value glued to a short flag (`-o~/.bashrc`).
// file:///path and file://localhost/path name a local file, so the path
// inside gets the same protected-path check as a bare operand would; every
// other scheme is a download/read target with no local path in it.
const FILE_URI_RE = /^file:\/\/(?:localhost)?(?=\/)/i;

function unwrapFileUri(arg: string): string {
  const match = FILE_URI_RE.exec(arg);
  if (!match) return arg;
  // A query or fragment is not part of the file a client opens.
  const tail = arg.slice(match[0].length);
  const cut = tail.search(/[?#]/);
  const rest = cut === -1 ? tail : tail.slice(0, cut);
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A malformed escape keeps the raw text; the check still sees the path.
  }
  // file:///C:/Users/x carries a slash before the drive letter.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

// The spellings of an argument that may name a file: the word as the shell
// hands it (see shellWord) and, on Windows, the same word with its
// backslash escapes resolved as well, since a shell there may read them
// either way. Every path check judges an argument through these, so a
// quoted or escaped spelling of a protected path meets the same denial as
// the plain one.
function unquoteWord(token: string, keepBackslashes = false): string {
  let value = '';
  let i = 0;
  while (i < token.length) {
    const ch = token[i];
    if (ch === '$' && token[i + 1] === "'") {
      const ansi = readAnsiC(token, i + 1);
      value += ansi.value;
      i = ansi.end;
    } else if (ch === '"' || ch === "'") {
      const quoted = readQuoted(token, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\' && !keepBackslashes && token[i + 1] === '\n') {
      i += 2;
    } else if (ch === '\\' && !keepBackslashes && i + 1 < token.length) {
      value += token[i + 1];
      i += 2;
    } else {
      value += ch;
      i += 1;
    }
  }
  return value;
}

// ANSI-C quoting: bash resolves the escapes of `$'...'` with the C table
// (a simple escape, `\xHH`, `\NNN`, `\uHHHH`, `\UHHHHHHHH`) before it hands
// the word over, so a path written that way names the same file.
const ANSI_C_SIMPLE: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};
const ANSI_C_NUMERIC_RE = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/;

// The character an escape at `at` (the position after the backslash)
// stands for, and how many characters it spans.
function ansiCEscape(text: string, at: number): { value: string; length: number } {
  const next = text[at] ?? '';
  if (next in ANSI_C_SIMPLE) return { value: ANSI_C_SIMPLE[next], length: 1 };
  const numeric = ANSI_C_NUMERIC_RE.exec(text.slice(at));
  if (numeric === null) return { value: next, length: 1 };
  const digits = numeric[1] ?? numeric[2] ?? numeric[3] ?? numeric[4];
  const radix = numeric[4] === undefined ? 16 : 8;
  const codePoint = Number.parseInt(digits, radix);
  // A number past the Unicode range names no character; bash prints the
  // bytes as they are, and here the replacement character stands in.
  const value = codePoint > 0x10ffff ? '\ufffd' : String.fromCodePoint(codePoint);
  return { value, length: numeric[0].length };
}

// The `$'...'` span whose quote opens at `start`: its value with the escapes
// resolved, and the index past the closing quote.
function readAnsiC(token: string, start: number): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  while (i < token.length && token[i] !== "'") {
    if (token[i] !== '\\') {
      value += token[i];
      i += 1;
      continue;
    }
    const escape = ansiCEscape(token, i + 1);
    value += escape.value;
    i += 1 + escape.length;
  }
  return { value, end: Math.min(i + 1, token.length) };
}

// The word the shell hands the command: quotes removed and ANSI-C quoting
// decoded everywhere; outside Windows the backslash escapes are resolved
// as well, while on Windows a backslash separates path components, so it
// stays.
function shellWord(token: string): string {
  return unquoteWord(token, process.platform === 'win32');
}

// Brace expansion runs where the shell runs it, before quote removal, and
// turns one word into several (`~/.{ssh,aws}/x` is two arguments to the
// command), only where the braces and the comma stand outside quotes and
// unescaped; braces without a comma, and quoted or escaped ones, are
// characters of the name. The alternatives are capped, and a word past the
// cap refuses the whole command, since a path the shell would hand over
// must never go unjudged.
const MAX_BRACE_EXPANSIONS = 64;

// Position of the next `{` at or after `start` that the shell reads as one
// (outside quotes and unescaped), or -1.
function nextOpenBrace(word: string, start: number): number {
  let i = start;
  while (i < word.length) {
    const skipped = skipText(word, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (word[i] === '{') return i;
    i += 1;
  }
  return -1;
}

// The brace group that opens at `open`: the commas at its own depth and its
// closing brace, or null when it never closes.
function braceGroupAt(word: string, open: number): { commas: number[]; close: number } | null {
  const commas: number[] = [];
  let depth = 0;
  let i = open;
  while (i < word.length) {
    const skipped = skipText(word, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = word[i];
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return { commas, close: i };
    else if (ch === ',' && depth === 1) commas.push(i);
    i += 1;
  }
  return null;
}

// The first brace group of a word that the shell would expand (one with a
// comma at its own depth); a group without one is passed over and its
// inside read, and null means the word has no group to expand.
function findBraceGroup(word: string): { open: number; commas: number[]; close: number } | null {
  let open = nextOpenBrace(word, 0);
  while (open !== -1) {
    const group = braceGroupAt(word, open);
    if (group !== null && group.commas.length > 0) return { open, ...group };
    open = nextOpenBrace(word, open + 1);
  }
  return null;
}

function braceExpansions(word: string): string[] | null {
  const group = findBraceGroup(word);
  if (group === null) return [word];
  const bounds = [group.open, ...group.commas, group.close];
  const out: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const rewritten = word.slice(0, group.open) + word.slice(bounds[i] + 1, bounds[i + 1]) + word.slice(group.close + 1);
    const nested = braceExpansions(rewritten);
    if (nested === null || out.length + nested.length > MAX_BRACE_EXPANSIONS) return null;
    out.push(...nested);
  }
  return out;
}

function expandArguments(words: string[]): string[] | null {
  const out: string[] = [];
  for (const word of words) {
    const expansions = braceExpansions(word);
    if (expansions === null) return null;
    out.push(...expansions);
  }
  return out;
}

function pathSpellings(arg: string): string[] {
  return process.platform === 'win32' ? [arg, unquoteWord(arg)] : [arg];
}

function isProtectedOperand(arg: string, cwd?: string): boolean {
  return pathSpellings(arg).some(spelling => isProtectedPath(spelling, cwd));
}

function isReadDeniedOperand(arg: string, cwd?: string): boolean {
  return pathSpellings(arg).some(spelling => isReadDeniedPath(spelling, cwd));
}

// The filesystem targets one spelling of an argument can carry: a bare
// operand (URIs excluded, they are download targets, not local paths), a
// --flag=value value, or a value glued to a short flag (`-o~/.bashrc`).
function candidatesOfSpelling(cased: string): string[] {
  const arg = cased.toLowerCase();
  if (!arg.startsWith('-')) {
    const unwrapped = unwrapFileUri(cased);
    if (unwrapped !== cased) return [unwrapped];
    return /^[a-z][a-z\d+.-]*:\/\//i.test(arg) ? [] : [cased];
  }
  const eq = cased.indexOf('=');
  if (eq > 0) return [unwrapFileUri(cased.slice(eq + 1))];
  if (!arg.startsWith('--') && arg.length > 2) return [unwrapFileUri(cased.slice(2))];
  return [];
}

function pathCandidatesOf(args: string[]): string[] {
  return args.flatMap(rawArg => pathSpellings(rawArg).flatMap(candidatesOfSpelling));
}


// A redirection names a file the shell opens on the command's behalf:
// `> file` writes over it and `< file` reads it, whatever command stands in
// front, and the shell reads the operator glued to its target (`>file`,
// `word>file`) exactly as it reads it spaced (`> file`). The target is
// therefore a filesystem operand like any other and is judged against the
// same protected paths, before the per-command checks, which only see the
// argument the operator was glued to.
//
// The command line is read here the way the shell reads it, on its own and
// not through tokenizeWords: a backslash before a newline joins the two
// lines; single quotes take everything literally; inside double quotes a
// backslash escapes only a quote, a backslash, a dollar sign or a
// backquote; outside quotes it escapes the next character; a parameter
// expansion in braces (`${x:-y}`) is text up to its closing brace; an
// unquoted `#` opening a word starts a comment. A command substitution,
// `$(...)` or backquotes, inside double quotes too, is a command of its own
// and its redirections are read on their own. A heredoc or a here-string
// carries text, not a path; `<&` and a descriptor duplication (`2>&1`,
// `>&-`) name no file; the body of a heredoc, up to its terminator line,
// is data and is left out; a process substitution (`<(cmd)`) reads as an empty
// target and the scan goes on inside the parentheses.
const REDIRECTION_OPERATORS = ['<<<', '<<', '>>', '>|', '>&', '<>', '<&', '>', '<'];
const WORD_BREAKS = new Set([' ', '\t', '\n', '\r', '|', '&', ';', '(', ')', '<', '>']);
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`']);

interface ShellWord {
  raw: string;
  value: string;
  end: number;
}

interface Redirection {
  target: ShellWord;
  writes: boolean;
}

// The quoted span opening at `start`: its value once the quotes are gone,
// and the index past the closing quote (past the end when it never closes).
function readQuoted(command: string, start: number): { value: string; end: number } {
  const quote = command[start];
  let value = '';
  let i = start + 1;
  while (i < command.length && command[i] !== quote) {
    if (quote === '"' && command[i] === '\\' && command[i + 1] === '\n') {
      i += 2;
      continue;
    }
    // A `${...}`, `$(...)` or backquoted command inside double quotes is read
    // whole: a quote inside it opens a string of its own.
    const nested = quote === '"' && command[i] !== '\\' ? doubleQuotedSpanEnd(command, i) : i;
    if (nested !== i) {
      value += command.slice(i, nested);
      i = nested;
      continue;
    }
    if (quote === '"' && command[i] === '\\' && DOUBLE_QUOTE_ESCAPES.has(command[i + 1] ?? '')) i += 1;
    value += command[i];
    i += 1;
  }
  return { value, end: Math.min(i + 1, command.length) };
}

// The line with its backslash-newline continuations removed, everywhere
// but inside single quotes, where the shell keeps them.
function joinContinuations(command: string): string {
  let joined = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = readQuoted(command, i).end;
      joined += command.slice(i, end);
      i = end;
    } else if (ch === '\\') {
      if (command[i + 1] !== '\n') joined += command.slice(i, i + 2);
      i += 2;
    } else {
      joined += ch;
      i += 1;
    }
  }
  return joined;
}

// Index past the span at `i` the shell reads as text rather than as
// operators (a quoted span, an escaped character, a parameter expansion in
// braces); `i` itself when no such span starts there.
function skipText(command: string, i: number): number {
  const ch = command[i];
  if (ch === '$' && command[i + 1] === "'") return readAnsiC(command, i + 1).end;
  if (ch === '"' || ch === "'") return readQuoted(command, i).end;
  if (ch === '\\') return Math.min(i + 2, command.length);
  if (ch === '$' && command[i + 1] === '{') return parameterExpansionEnd(command, i + 2);
  return i;
}

// Index past the `}` that closes the `${` whose body starts at `start`. A
// nested `${...}`, a command or process substitution and a backquoted
// command are read whole, so a `}` of theirs does not close it, as bash
// reads it; the end of the line when it never closes.
function parameterExpansionEnd(command: string, start: number): number {
  let i = start;
  while (i < command.length) {
    const skipped = skipNested(command, i, false);
    if (skipped !== i) {
      i = skipped;
    } else if (command[i] === '}') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return command.length;
}

// Index past the command or process substitution (`$(...)`, `$((...))`,
// `<(...)`, `>(...)`) or backquoted command opening at `i`; `i` itself when
// none opens there.
function skipSubstitution(command: string, i: number): number {
  if (command[i] === '`') {
    let j = i + 1;
    while (j < command.length && command[j] !== '`') j += command[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, command.length);
  }
  if ('$<>'.includes(command[i]) && command[i + 1] === '(') return Math.min(closingParenthesis(command, i + 2) + 1, command.length);
  return i;
}

// Index of the newline that ends the comment a `#` opening a word starts at
// `i` (the end of the line when none follows); `i` itself when no comment
// starts there.
function skipComment(command: string, i: number): number {
  if (command[i] !== '#') return i;
  const prev = i === 0 ? -1 : precedingCharIndex(command, i - 1);
  if (prev >= 0 && !COMMENT_WORD_START.has(command[prev])) return i;
  const newline = command.indexOf('\n', i);
  return newline === -1 ? command.length : newline;
}

// Index past a span read whole at `i`: text (skipText), a substitution, and
// in a command body a comment up to its newline, which a `)` in it does not
// close; `i` itself when none starts there.
function skipNested(command: string, i: number, inCommand: boolean): number {
  const text = skipText(command, i);
  if (text !== i) return text;
  const substitution = skipSubstitution(command, i);
  if (substitution !== i || !inCommand) return substitution;
  return skipComment(command, i);
}

// Characters before an unquoted `#` that let it open a word, so the `#`
// starts a comment. Deliberately excludes `)`, `<` and `>`: `$(date)#c` is
// one word, and `>#x` redirects to a file named `#x` (matches shell-split.js
// and bash itself), so those do not begin a comment.
const COMMENT_WORD_START = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(']);

// The character before `i` that the shell reads as preceding it, walking back
// over backslash-newline line continuations: bash removes such a pair before
// tokenizing, so `foo\<newline>#bar` is the one word `foo#bar` and the `#` is
// mid-word, not a comment. A run of backslashes continues the line only when
// it is odd (each pair is an escaped literal backslash).
function precedingCharIndex(command: string, i: number): number {
  let j = i;
  while (j >= 0 && command[j] === '\n') {
    let backslashes = 0;
    let k = j - 1;
    while (k >= 0 && command[k] === '\\') { backslashes += 1; k -= 1; }
    if (backslashes % 2 === 0) break;
    j = k;
  }
  return j;
}

// The command line with the inert text of a trailing `# comment` removed, so
// a path or an operator that only sits in a comment is never judged. A `#`
// inside quotes, a `${...}` expansion, or mid-word is left in place (skipText
// walks those spans, and a line continuation before it keeps it mid-word);
// the comment runs to the end of its line.
function stripTrailingComment(command: string): string {
  let i = 0;
  while (i < command.length) {
    const skipped = skipText(command, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (command[i] === '#') {
      const prev = i === 0 ? -1 : precedingCharIndex(command, i - 1);
      if (prev < 0 || COMMENT_WORD_START.has(command[prev])) {
        const newline = command.indexOf('\n', i);
        return newline === -1 ? command.slice(0, i) : command.slice(0, i) + command.slice(newline);
      }
    }
    i += 1;
  }
  return command;
}

// The word at `start`, leading blanks skipped, up to the next unquoted blank
// or shell metacharacter: as typed, and as the shell would hand it over.
function readWord(command: string, start: number): ShellWord {
  let i = start;
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i += 1;
  const from = i;
  let value = '';
  while (i < command.length && !WORD_BREAKS.has(command[i])) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(command, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\') {
      value += command.slice(i + 1, i + 2);
      i += 2;
    } else if (ch === '$' && command[i + 1] === '{') {
      const end = skipText(command, i);
      value += command.slice(i, end);
      i = end;
    } else {
      value += ch;
      i += 1;
    }
  }
  return { raw: command.slice(from, i), value, end: i };
}

// Position of the next `<` or `>` at or after `start` that the shell reads
// as an operator, outside quotes and not escaped; -1 when there is none. A
// comment (an unquoted `#` that opens a word) runs to the end of its line
// and is skipped, since what follows the newline is read again.
function nextOperator(command: string, start: number): number {
  let i = start;
  while (i < command.length) {
    const skipped = skipText(command, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = command[i];
    if (ch === '#' && (i === 0 || WORD_BREAKS.has(command[i - 1]))) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    if (ch === '<' || ch === '>') return i;
    i += 1;
  }
  return -1;
}

// The redirection whose operator starts at `at`, null when it names no
// file; the delimiter of the heredoc it opens, if any; and the index the
// scan resumes from.
function redirectionAt(command: string, at: number): { redirection: Redirection | null; heredoc: string | null; next: number } {
  const operator = REDIRECTION_OPERATORS.find(op => command.startsWith(op, at)) ?? command[at];
  const target = readWord(command, at + operator.length);
  if (operator === '<<') return { redirection: null, heredoc: target.value.replace(/^-/, ''), next: target.end };
  const namesNoFile = operator === '<<<' || operator === '<&'
    || (operator === '>&' && /^(?:\d+|-)$/.test(target.value))
    || target.value.length === 0;
  if (namesNoFile) return { redirection: null, heredoc: null, next: target.end };
  return { redirection: { target, writes: operator !== '<' }, heredoc: null, next: target.end };
}

// Index of the newline ending the line that carries `delimiter` alone
// (leading tabs allowed, as `<<-` strips them), searched from `start`; the
// end of the command when that line never comes.
function terminatorLineEnd(command: string, start: number, delimiter: string): number {
  let lineStart = start;
  while (lineStart < command.length) {
    const newline = command.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? command.length : newline;
    if (command.slice(lineStart, lineEnd).replace(/^\t+/, '') === delimiter) return lineEnd;
    lineStart = lineEnd + 1;
  }
  return command.length;
}

// Index of the end of the last terminator line of the heredocs opened on
// the line that ends at `newline`: their bodies follow that line in order,
// carry data, and are left out of the scan.
function heredocBodiesEnd(command: string, newline: number, delimiters: string[]): number {
  let end = newline;
  for (const delimiter of delimiters) end = terminatorLineEnd(command, end + 1, delimiter);
  return end;
}

// Index of the parenthesis closing the substitution whose body starts at
// `start`, quoted spans, nested substitutions, backquoted commands and
// comments read whole (skipNested); the end of the line when it never
// closes.
function closingParenthesis(command: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < command.length) {
    const skipped = skipNested(command, i, true);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (command[i] === '(') depth += 1;
    if (command[i] === ')') depth -= 1;
    if (depth === 0) return i;
    i += 1;
  }
  return command.length;
}

// The bodies of the command substitutions of the line, `$(...)` and
// backquotes, inside double quotes too; a substitution nested in a body is
// found when that body is read in turn.
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" || ch === '\\') {
      i = ch === "'" ? readQuoted(command, i).end : i + 2;
    } else if (ch === '`') {
      const close = command.indexOf('`', i + 1);
      const end = close === -1 ? command.length : close;
      bodies.push(command.slice(i + 1, end));
      i = end + 1;
    } else if (ch === '$' && command[i + 1] === '(') {
      const end = closingParenthesis(command, i + 2);
      bodies.push(command.slice(i + 2, end));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return bodies;
}

function redirectionsOf(line: string): Redirection[] {
  const command = joinContinuations(line);
  const found: Redirection[] = [];
  const heredocs: string[] = [];
  let from = 0;
  let at = nextOperator(command, from);
  while (at !== -1) {
    const newline = command.indexOf('\n', from);
    if (heredocs.length > 0 && newline !== -1 && newline < at) {
      from = heredocBodiesEnd(command, newline, heredocs.splice(0));
      at = nextOperator(command, from);
      continue;
    }
    const { redirection, heredoc, next } = redirectionAt(command, at);
    if (heredoc !== null) heredocs.push(heredoc);
    if (redirection !== null) found.push(redirection);
    from = next;
    at = nextOperator(command, from);
  }
  for (const body of substitutionBodies(command)) found.push(...redirectionsOf(body));
  return found;
}

// The spellings of a target that may name the file: what the shell hands
// over and, on Windows, where a backslash separates path components rather
// than escaping the next character, the word as typed.
function targetSpellings(target: ShellWord): string[] {
  return process.platform === 'win32' ? [target.value, target.raw] : [target.value];
}

function redirectionVerdict(command: string, cwd?: string): ValidationResult | null {
  for (const { target, writes } of redirectionsOf(command)) {
    const denies = writes ? isProtectedPath : isReadDeniedPath;
    const denied = targetSpellings(target).find(spelling => denies(spelling, cwd));
    if (denied === undefined) continue;
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

// Catalogued commands (SAFE_READONLY/SAFE_DEV) get their own per-command
// checks in validateCommandArgs. Everything else is advisory-only at the
// hook layer (ADVISORY_REASONS in pre-bash-guardian-validate.js), UNLESS it
// targets a protected file, which hard-blocks here (EGC-494): without this,
// `wget -O ~/.bashrc <url>` had zero protected-path coverage because the
// generic allowlist-miss advisory swallowed every case.
// The words a command is handed, without the files it reads through `<`:
// redirectionVerdict judges those as the reads they are, before this check.
// Output redirections stay, so a write is caught here too.
const INPUT_REDIRECTION_RE = /^\d*<(?![<(&>])/;

// Read from the words as written (`raw`), so a quoted `'<'` stays the
// argument it is: only an unquoted `<` is a redirection.
function withoutInputRedirections(args: string[], raw: string[]): string[] {
  const kept: string[] = [];
  let skipNext = false;
  for (const [i, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const operator = INPUT_REDIRECTION_RE.exec(raw[i] ?? '');
    if (operator === null) kept.push(arg);
    else skipNext = operator[0].length === raw[i].length;
  }
  return kept;
}

// Builtins that only test or read the files they name: in a committed
// script, naming a protected file with them is flagged, not grave.
const COMMITTED_READ_BUILTINS = new Set(['[', '[[', 'test', '.', 'source']);

function validateAgainstAllowlist(baseCommand: string, args: string[], cwd?: string, rawArgs: string[] = args): ValidationResult {
  if (SAFE_READONLY.includes(baseCommand) || SAFE_DEV.includes(baseCommand)) {
    return validateCommandArgs(baseCommand, args, cwd);
  }
  // A committed script reads files through `<` as the reads they are.
  const candidates = committedScript ? withoutInputRedirections(args, rawArgs) : args;
  const protectedTarget = pathCandidatesOf(candidates).find(arg => isProtectedPath(arg, cwd));
  if (protectedTarget) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `'${baseCommand}' targets a protected file (${protectedTarget}) and is always denied, regardless of allowlist status`,
      trust_level: 'DANGEROUS',
    };
    if (!COMMITTED_READ_BUILTINS.has(baseCommand) || !flagsInCommittedScript(denial)) return denial;
  }
  return {
    allowed: false,
    // The marker phrase stays inside the sentence: an enforcement hook from
    // an older build still recognizes an advisory verdict by it.
    reason: `Command '${baseCommand}' ${ALLOWLIST_MISS_MARKER} of commands the Guardian knows, so it was flagged, not blocked. If it should be trusted here, ask the maintainer to add it.`,
    advisory: true,
    trust_level: 'BLOCKED',
  };
}

// A relative write target names a file under the directory the agent works
// in, which the caller passes as cwd; without it, this process's own
// working directory is the only one known.
function writeBaseDir(cwd?: string | null): string {
  const trimmed = cwd?.trim();
  return trimmed ? path.resolve(expandHome(trimmed)) : process.cwd();
}

export function resolveWriteTarget(filepath: string, cwd?: string | null): string {
  return path.resolve(writeBaseDir(cwd), expandHome(filepath.trim()));
}

// A cwd that is still relative once ~ is expanded would be read against this
// process's directory, not the agent's, so it is refused rather than guessed.
function relativeCwdOf(cwd?: string | null): string | null {
  const trimmed = cwd?.trim();
  return trimmed && !path.isAbsolute(expandHome(trimmed)) ? trimmed : null;
}

export function validateWrite(filepath: string, cwd?: string | null): ValidationResult {
  const relativeCwd = relativeCwdOf(cwd);
  if (relativeCwd !== null) {
    return {
      allowed: false,
      reason: `cwd '${relativeCwd}' is not an absolute path; pass the absolute directory the agent works in`,
      trust_level: 'BLOCKED',
    };
  }
  if (isProtectedPath(resolveWriteTarget(filepath, cwd))) {
    return {
      allowed: false,
      reason: `Path '${filepath}' is protected`,
      trust_level: 'BLOCKED',
    };
  }
  return { allowed: true };
}
