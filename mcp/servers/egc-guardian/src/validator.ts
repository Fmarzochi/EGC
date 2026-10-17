import path from 'node:path';
import { programCommandOf, type ProgramRead } from './pattern-operands.js';
import { programRefs } from './program-refs.js';
import { session, flagsInCommittedScript, type ValidationResult } from './validator-session.js';
import { SAFE_READONLY, SAFE_DEV, DANGEROUS, SHELL_META_REGEX } from './validator-allowlists.js';
import { commandName } from './validator-tokens.js';
import { tokenizeWords, expandArguments, MAX_BRACE_EXPANSIONS, shellWord, stripTrailingComment } from './validator-shell-text.js';
import { expandHome, writeBaseDir } from './validator-path-utils.js';
import { isToolHookSurface } from './validator-hook-surfaces.js';
import { isProtectedPath } from './validator-protected-paths.js';
import { inlineEvalVerdict, isInlineProgram } from './validator-eval.js';
import { unwrapLeadingConstructs, runnerVerdict } from './validator-unwrap.js';
import { destructiveVerdict } from './validator-destructive.js';
import { validateGitArgs } from './validator-git-args.js';
import { validateGrepArgs, validateCatArgs, validateFindArgs, validateReadOnlyPathArgs, validateDevToolArgs, testedFiles } from './validator-tool-args.js';
import { isGraveTarget } from './validator-narrow-target.js';
import { LINE_OVERFLOW_VERDICT, pathCandidatesOf } from './validator-line-values.js';
import { redirectionVerdict, scriptWriteVerdict, schedulerVerdict } from './validator-script-writes.js';

// The public surface of the validator, as it was when it was one file: the
// server, the CLI, the file ranker and the hook libraries import from here.
export { RUNNER_SPECS } from './runner-wrappers.js';
export { SAFE_READONLY, SAFE_DEV, DANGEROUS, SHELL_META_REGEX, FIND_ACTION_FLAGS } from './validator-allowlists.js';
export type { ValidationResult } from './validator-session.js';
export { commandName } from './validator-tokens.js';
export { type WrapperSpec, WRAPPER_SPECS, readWrapperOption, permutedOptions, runnerCommandStart } from './validator-wrappers.js';
export { SHELL_KEYWORDS } from './validator-unwrap.js';
export { resolveRealOrLexical } from './validator-path-utils.js';
export { isToolHookSurface } from './validator-hook-surfaces.js';
export { PROTECTED_FILE_PATTERNS, buildDeniedPaths, DENIED_PATHS, isProtectedPath, secretPathChecker, READ_SAFE_PATHS, isReadDeniedPath } from './validator-protected-paths.js';

/**
 * Validate arguments for a specific allowed command.
 * Returns { allowed: false, reason } if the args are unsafe.
 */

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
    case '[':
    case '[[':
    case 'test': return validateReadOnlyPathArgs(baseCommand, testedFiles(args), cwd);
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

export function validateCommand(command: string, cwd?: string, bound: Readonly<Record<string, readonly string[]>> = {}): ValidationResult {
  const outer = session.lineBound;
  const outerOverflow = session.lineOverflow;
  session.lineBound = new Map(Object.entries(bound));
  session.lineOverflow = false;
  try {
    const verdict = validateCommandVerdict(command, cwd);
    if (session.lineOverflow && (verdict.allowed || verdict.advisory === true)) return LINE_OVERFLOW_VERDICT;
    return { ...verdict, advisory: verdict.advisory === true };
  } finally {
    session.lineBound = outer;
    session.lineOverflow = outerOverflow;
  }
}

// A command out of a script committed in git and unchanged since: a grave
// denial blocks it as usual; a rule it met that only exists to stop hiding
// flags it, unless something grave follows.
export function validateCommittedScriptCommand(command: string, cwd?: string, bound: Readonly<Record<string, readonly string[]>> = {}, lineVariables: Readonly<Record<string, readonly string[]>> = {}): ValidationResult {
  session.committedScript = true;
  session.committedFlag = null;
  session.committedBound = new Map(Object.entries(bound));
  try {
    const verdict = validateCommand(command, cwd, lineVariables);
    if (session.committedFlag === null || (!verdict.allowed && !verdict.advisory)) return verdict;
    return {
      ...session.committedFlag,
      advisory: true,
      reason: `${session.committedFlag.reason} (flagged, not blocked: it runs from a script committed in git and unchanged since)`,
    };
  } finally {
    session.committedScript = false;
    session.committedFlag = null;
    session.committedBound = new Map();
  }
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
    if (!session.committedScript || args.some(arg => isGraveTarget(arg, cwd)) || !flagsInCommittedScript(denial)) return denial;
  }
  return null;
}

export function validateCommandVerdict(command: string, cwd?: string): ValidationResult {
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
  const unwrapped = unwrapLeadingConstructs(expandedTokens, cwd);
  if (unwrapped.blocked) return unwrapped.blocked;
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
  const runnerDenial = runnerVerdict(tokens, cwd);
  if (runnerDenial) return runnerDenial;

  const baseCommand = commandName(tokens[0]);
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

  // 5c. What would run later without being judged: a shell script written
  // through the shell, and a job handed to a scheduler.
  const runsLater = scriptWriteVerdict(baseCommand, args, cwd) ?? schedulerVerdict(baseCommand, args);
  if (runsLater) return runsLater;

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

// Builtins that read the files they name: in a committed script, naming a
// protected file with them is flagged, not grave. (`[`, `[[` and `test` are
// judged with the read-only commands.)
const COMMITTED_READ_BUILTINS = new Set(['.', 'source']);

// A command a sed e, an ag --pager or an rg --pre runs: inline code (see
// isInlineProgram) is refused as sh -c is; a plain one is judged as the
// command it is.
function embeddedCommandDenial(baseCommand: string, inner: string): ValidationResult | null {
  if (isInlineProgram(inner)) {
    return { allowed: false, reason: `'${baseCommand}' hands '${inner}' to a shell or an interpreter, which is inline code; write it to a script and name the script`, trust_level: 'DANGEROUS' };
  }
  const verdict = validateCommand(inner);
  if (verdict.allowed !== false || verdict.advisory) return null;
  return { allowed: false, reason: `'${baseCommand}' runs '${inner}': ${verdict.reason}`, trust_level: 'DANGEROUS' };
}

// What a sed, awk, jq, yq, rg or ag command names beyond its words: the files
// its program text names, judged with those words; the commands its program
// or its options run, judged as commands; what the program builds from the
// data it reads, which is refused.
function programTextVerdict(baseCommand: string, read: ProgramRead): { files: string[]; denial: ValidationResult | null } {
  const files: string[] = [];
  const commands = [...read.commands];
  for (const text of read.programs) {
    const refs = programRefs(read.language, text);
    if (refs.opaque) {
      return { files, denial: { allowed: false, reason: `'${baseCommand}' ${refs.opaque}, which cannot be judged before it runs; write that part in the shell instead, where it is judged`, trust_level: 'DANGEROUS' } };
    }
    commands.push(...refs.commands);
    files.push(...refs.files);
  }
  for (const inner of commands) {
    const denial = embeddedCommandDenial(baseCommand, inner);
    if (denial) return { files, denial };
  }
  return { files, denial: null };
}

function validateAgainstAllowlist(baseCommand: string, args: string[], cwd?: string, rawArgs: string[] = args): ValidationResult {
  if (SAFE_READONLY.includes(baseCommand) || SAFE_DEV.includes(baseCommand)) {
    return validateCommandArgs(baseCommand, args, cwd);
  }
  // A committed script reads files through `<` as the reads they are.
  const candidates = session.committedScript ? withoutInputRedirections(args, rawArgs) : args;
  // The program, pattern or filter of sed, awk, jq and the like is text; the
  // files and the commands its own text names are judged.
  const read = programCommandOf(baseCommand, candidates);
  const program = read ? programTextVerdict(baseCommand, read) : { files: [], denial: null };
  if (program.denial) return program.denial;
  const named = read ? [...read.files, ...program.files] : candidates;
  const protectedTarget = pathCandidatesOf(named).find(arg => isProtectedPath(arg, cwd));
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
  const target = resolveWriteTarget(filepath, cwd);
  const baseDir = writeBaseDir(cwd);
  if (isProtectedPath(target, baseDir)) {
    const reason = isToolHookSurface(target, baseDir)
      ? `Path '${filepath}' is a hook surface of a tool: the person or the installer writes it, the agent does not`
      : `Path '${filepath}' is protected`;
    return {
      allowed: false,
      reason,
      trust_level: 'BLOCKED',
    };
  }
  return { allowed: true };
}
