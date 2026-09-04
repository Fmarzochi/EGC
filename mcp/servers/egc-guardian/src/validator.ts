import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Trust level tiers
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git'];
export const SAFE_DEV = ['npm', 'npx', 'node', 'tsc'];
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
export const FIND_ACTION_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fls'];

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
// wrapper's -e vs -E are two different flags with different arities) —
// lowercasing before the membership check would make an unrecognized
// uppercase flag collide with an unrelated lowercase entry in valueFlags,
// silently consuming (or failing to consume) the wrong number of tokens and
// misidentifying the real wrapped command.
function stripQuotes(a: string): string {
  return a.replaceAll('\\', '').replaceAll(/["']/g, '');
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

  if (state.quote) {
    state.current += ch;
    state.hasToken = true;
    if (ch === state.quote) state.quote = null;
    return i + 1;
  }

  if (ch === '\\' && i + 1 < command.length) {
    state.current += ch + command[i + 1];
    state.hasToken = true;
    return i + 2;
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
// -I{} rm -rf {}`) instead of stopping after a single layer. Bundled short
// flags (-Hu instead of -H -u) are not decomposed, same simplification the
// docker checks above already accept — not exhaustive, covers the common
// spelled-out forms.
interface WrapperSpec {
  valueFlags: Set<string>;
  leadingPositionals?: number;
}

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  sudo: { valueFlags: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-h', '--host', '-C', '--close-from', '-r', '--role', '-t', '--type', '-R', '--chroot', '-D', '--chdir']) },
  doas: { valueFlags: new Set(['-u', '-C']) },
  env: { valueFlags: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']) },
  nohup: { valueFlags: new Set() },
  time: { valueFlags: new Set(['-o', '--output', '-f', '--format']) },
  command: { valueFlags: new Set() },
  exec: { valueFlags: new Set() },
  nice: { valueFlags: new Set(['-n', '--adjustment']) },
  ionice: { valueFlags: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid']) },
  timeout: { valueFlags: new Set(['-s', '--signal', '-k', '--kill-after']), leadingPositionals: 1 },
  stdbuf: { valueFlags: new Set(['-i', '--input', '-o', '--output', '-e', '--error']) },
  xargs: { valueFlags: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-i', '-L', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']) },
  flock: { valueFlags: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']), leadingPositionals: 1 },
  watch: { valueFlags: new Set(['-n', '--interval']) },
  strace: { valueFlags: new Set(['-e', '-o', '--output', '-s', '-p', '-P', '-b', '-U']) },
  'systemd-run': { valueFlags: new Set(['-p', '--property', '-u', '--unit', '--slice', '--uid', '--gid', '--nice', '-E', '--setenv', '--working-directory', '-M', '--machine', '-H', '--host', '--description']) },
  parallel: { valueFlags: new Set(['-j', '--jobs', '-N', '--delay', '--retries', '--timeout', '--joblog', '--results', '-S', '--sshlogin']) },
};

const ENV_ASSIGNMENT_RE = /^([A-Za-z_]\w*)=/;

// Environment variables that let a command persist or override git's hook
// and execution config the same way `-c core.hooksPath=`/`git config` does
// (see DANGEROUS_GIT_CONFIG_KEYS below), but via `VAR=value git ...` on the
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

// Unwraps a known wrapper command (sudo, timeout, xargs, ...), skipping its
// flags and any mandatory leading positionals to reach the wrapped command.
function tryUnwrapWrapper(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  const spec = WRAPPER_SPECS[head];
  if (!spec) return null;

  // env -S/--split-string re-splits its value into a new argv and execs the
  // first word of that split — the same "string becomes code" shape as
  // eval, just via env(1) instead of a shell builtin. The value isn't a
  // simple opaque flag argument to skip past; it can itself be a full
  // destructive command, so this is a hard deny rather than an unwrap.
  if (head === 'env') {
    const hasSplitString = current.slice(1).some(t => {
      const bare = stripQuotes(t);
      return bare === '-S' || bare === '--split-string' || bare.startsWith('--split-string=');
    });
    if (hasSplitString) {
      return {
        blocked: {
          allowed: false,
          reason: `'env -S/--split-string' re-splits and executes its value and is forbidden`,
          trust_level: 'DANGEROUS',
        },
      };
    }
  }

  let i = 1;
  while (i < current.length && stripQuotes(current[i]).startsWith('-')) {
    const flag = stripQuotes(current[i]);
    const eq = flag.indexOf('=');
    const flagName = eq > 0 ? flag.slice(0, eq) : flag;
    if (eq < 0 && spec.valueFlags.has(flagName)) i += 2;
    else i += 1;
  }
  let skip = spec.leadingPositionals ?? 0;
  while (skip > 0 && i < current.length) { i += 1; skip -= 1; }
  return { remaining: current.slice(i) };
}

// Peels leading environment-variable assignments and known wrapper commands
// off the front of a token list until the real command is reached, looping
// so stacked wrappers (`sudo timeout 5 xargs rm -rf`) all get unwrapped
// rather than just the outermost one.
function unwrapLeadingConstructs(tokens: string[]): UnwrapResult {
  let current = tokens;
  let changed = true;
  while (changed && current.length > 0) {
    changed = false;

    const step = tryUnwrapEnvAssignment(current) ?? tryUnwrapExport(current) ?? tryUnwrapWrapper(current);
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

function checkGhDestructive(args: string[]): ValidationResult | null {
  const tokens = args.map(bareToken);
  const positionals = positionalsOf(tokens);
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
  su: ['-c', '--command'],
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
// resolving just the parent directory (then the lexical path unchanged) when
// the target doesn't exist yet. A denied entry resolved once at DENIED_PATHS'
// module-load time would go stale for a directory that becomes a symlink (or
// whose symlink target starts existing) after the guardian process starts --
// the same shape as the macOS /etc bug, just materializing later instead of
// always being present (cubic review, PR #1129). Resolving both sides fresh
// on every isProtectedPath() call removes that staleness window entirely.
export function resolveRealOrLexical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
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

export function isProtectedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Trim first: a trailing newline (routine for anything piped through
  // `echo`) or stray whitespace survives path.resolve() into the final
  // string, and every pattern in PROTECTED_FILE_PATTERNS is anchored with
  // `$`, so an untrimmed ".env\n" silently failed to match ".env" and was
  // allowed through (audit EGC-533).
  p = p.trim();

  // Expand ~ at the start
  const expanded = p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;

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
  const expanded = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
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
}

/**
 * Validate arguments for a specific allowed command.
 * Returns { allowed: false, reason } if the args are unsafe.
 */
// Config keys that persist a hook-bypass or arbitrary-execution mechanism:
// once set, they take effect on every future git invocation in this repo/
// environment, not just the one that set them (unlike the inline `-c
// core.hooksPath=` form, already blocked separately in
// scripts/hooks/block-no-verify.js). core.hooksPath repoints where git looks
// for hooks (including the DCO/commit hooks this project relies on);
// core.pager/core.editor/diff.external run an arbitrary command on ordinary
// read operations; credential.helper receives every credential request;
// include.path loads another config file wholesale.
const DANGEROUS_GIT_CONFIG_KEYS = new Set([
  'core.hookspath',
  'core.pager',
  'core.editor',
  'core.sshcommand',
  'core.fsmonitor',
  'credential.helper',
  'diff.external',
  'include.path',
]);
// A merge driver runs an arbitrary command on every merge that touches a
// matching path, by design of the merge.<name>.driver mechanism itself —
// any write to one is dangerous regardless of the command it names. filter
// clean/smudge/process drivers and a named diff driver's own command run the
// same way, on every checkout/diff of a matching path.
const GIT_CONFIG_MERGE_DRIVER_KEY_RE = /^merge\..+\.driver$/;
const GIT_CONFIG_FILTER_KEY_RE = /^filter\..+\.(clean|smudge|process)$/;
const GIT_CONFIG_DIFF_COMMAND_KEY_RE = /^diff\..+\.command$/;
// includeIf.<condition>.path loads another config file wholesale, exactly
// like include.path above -- git's conditional-include syntax, not covered
// by the exact-match DANGEROUS_GIT_CONFIG_KEYS set (audit EGC-533).
const GIT_CONFIG_INCLUDEIF_KEY_RE = /^includeif\..+\.path$/i;
// An alias is only a shell-escape risk when its value starts with '!' (git's
// own syntax for "run this as a shell command" instead of a git subcommand);
// alias.co = checkout is ordinary and harmless.
const GIT_CONFIG_ALIAS_KEY_RE = /^alias\..+$/;

// Flags that make `git config` strictly a read or a removal — never a write
// — and so must never trip the dangerous-key check below. Output-annotation
// flags (--show-scope, --show-origin, --name-only) are deliberately NOT
// here: nothing stops one of them from appearing in argv alongside a real
// key+value SET, so treating their mere presence as proof of "this is a
// read" would let a set slip through unchecked (e.g. `git config
// --show-scope core.hooksPath /tmp/evil`). --edit/-e is excluded for the
// opposite reason — it IS a write (opens an editor over the config file)
// and gets its own unconditional deny below instead of an exemption.
const GIT_CONFIG_READONLY_FLAGS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l',
  '--unset', '--unset-all',
]);
const GIT_CONFIG_VALUE_FLAGS = new Set(['-f', '--file', '--blob', '--type', '--default']);

// Called only once the 'config' subcommand itself has been identified;
// `args` is everything after 'git' (so args[0] === 'config'). Detects a
// SET (a key positional followed by a value positional, or --add/
// --replace-all) of one of the dangerous keys above and hard-blocks it —
// reading or unsetting the same key is left untouched. Also hard-denies
// --edit/-e outright, since an editor session's eventual changes cannot be
// inspected the way a plain key/value pair can.
interface GitConfigArgScan {
  readOnly: boolean;
  positionals: string[];
  editDenial: ValidationResult | null;
}

// Walks the arguments after 'config': collects the positionals (key, value),
// notes read-only flags, skips the value of value-taking flags, and denies
// --edit/-e outright.
function scanGitConfigArgs(rest: string[]): GitConfigArgScan {
  let readOnly = false;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const flag = bareToken(rest[i]);
    if (flag === '--') { positionals.push(...rest.slice(i + 1).map(bareToken)); break; }
    if (!flag.startsWith('-')) { positionals.push(flag); continue; }
    if (flag === '--edit' || flag === '-e') {
      const editDenial: ValidationResult = {
        allowed: false,
        reason: `git config --edit opens an editable session over the config file and is forbidden`,
        trust_level: 'DANGEROUS',
      };
      return { readOnly, positionals, editDenial };
    }
    const eq = flag.indexOf('=');
    const flagName = eq > 0 ? flag.slice(0, eq) : flag;
    if (GIT_CONFIG_READONLY_FLAGS.has(flagName)) readOnly = true;
    if (eq < 0 && GIT_CONFIG_VALUE_FLAGS.has(flagName)) i += 1;
  }

  return { readOnly, positionals, editDenial: null };
}

function isDangerousGitConfigWrite(key: string, value: string): boolean {
  return DANGEROUS_GIT_CONFIG_KEYS.has(key)
    || GIT_CONFIG_MERGE_DRIVER_KEY_RE.test(key)
    || GIT_CONFIG_FILTER_KEY_RE.test(key)
    || GIT_CONFIG_DIFF_COMMAND_KEY_RE.test(key)
    || GIT_CONFIG_INCLUDEIF_KEY_RE.test(key)
    || (GIT_CONFIG_ALIAS_KEY_RE.test(key) && value.startsWith('!'));
}

function checkGitConfigWrite(args: string[]): ValidationResult | null {
  const scan = scanGitConfigArgs(args.slice(1));
  if (scan.editDenial) return scan.editDenial;
  if (scan.readOnly || scan.positionals.length < 2) return null;

  const [key, value] = scan.positionals;
  if (!isDangerousGitConfigWrite(key, value)) return null;
  return {
    allowed: false,
    reason: `git config write to '${key}' persists a hook/execution-bypass override and is forbidden`,
    trust_level: 'DANGEROUS',
  };
}

// Global git flags that take a value and can appear BEFORE the subcommand
// (`git -c foo=bar config ...`, `git -C /path config ...`), mirroring the
// same set block-no-verify.js already trusts for this exact purpose. Without
// skipping these (and their values), a global flag in front of `config`
// shifts the subcommand out of args[0] and the dangerous-key check below is
// never reached at all.
const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix']);

// Returns the index of the actual subcommand token (skipping global flags
// and their values), not just its name — reusing this same index to slice
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

function validateGitArgs(args: string[]): ValidationResult {
  // Block force pushes, including --force-with-lease/--force-if-includes
  // (startsWith, not includes, so these are caught even though their
  // second character is '-' and they carry a value after '=').
  const hasForceFlag = args.some(
a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes'),
  );
  if (hasForceFlag) {
return { allowed: false, reason: 'git force-push is forbidden', trust_level: 'SAFE_READONLY' };
  }
  // Additional check for combined short flags like -fu used destructively
  if (args.includes('push') && args.some(a => /^-[a-zA-Z]*f/.test(a))) {
return { allowed: false, reason: 'git push with force flag is forbidden', trust_level: 'SAFE_READONLY' };
  }
  const subcommandIdx = findGitSubcommandIndex(args);
  if (subcommandIdx >= 0 && bareToken(args[subcommandIdx]) === 'config') {
    const configDenial = checkGitConfigWrite(args.slice(subcommandIdx));
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

function denyGrepTarget(reason: string): ValidationResult {
  return { allowed: false, reason, trust_level: 'SAFE_READONLY' };
}

function checkRecursiveGrepPaths(pathArgs: string[], positionalArgs: string[], cwd?: string): ValidationResult | null {
  const home = os.homedir();
  for (const p of pathArgs) {
    if (p === '/' || p === home || isProtectedPath(p, cwd)) {
      return denyGrepTarget(`grep recursive over protected path '${p}' is forbidden`);
    }
  }
  // If no explicit path args, grep defaults to '.', which is fine.
  // But if the only non-flag positional IS '/' (i.e., pattern was empty), still block.
  if (positionalArgs.length === 1 && (positionalArgs[0] === '/' || isProtectedPath(positionalArgs[0], cwd))) {
    return denyGrepTarget(`grep over protected path '${positionalArgs[0]}' is forbidden`);
  }
  return null;
}

function validateGrepArgs(args: string[], cwd?: string): ValidationResult {
  const { fileFlagValues, patternViaFlag } = collectGrepPatternFlags(args);
  for (const p of fileFlagValues) {
    if (isReadDeniedPath(p, cwd)) return denyGrepTarget(`grep pattern file '${p}' is a protected path`);
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
    if (isReadDeniedPath(p, cwd)) return denyGrepTarget(`grep over protected path '${p}' is forbidden`);
  }

  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

function validateCatArgs(args: string[], cwd?: string): ValidationResult {
  for (const arg of args) {
const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
if (candidate !== null && isReadDeniedPath(candidate, cwd)) {
  return {
    allowed: false,
    reason: `cat of protected path '${arg}' is forbidden`,
    trust_level: 'SAFE_READONLY',
  };
}
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

function validateFindArgs(args: string[], cwd?: string): ValidationResult {
  // -delete/-exec/etc. make find perform an action instead of just
  // filtering, which reproduces 'rm -rf' through a base command that
  // isn't in the DANGEROUS list. Deny regardless of path.
  const actionFlag = args.find(a => FIND_ACTION_FLAGS.includes(a));
  if (actionFlag) {
return {
  allowed: false,
  reason: `find with action flag '${actionFlag}' is forbidden (use a read-only find, then a separate reviewed command)`,
  trust_level: 'DANGEROUS',
};
  }

  // First non-flag arg is typically the search root; also surface paths
  // handed over inside --flag=value forms.
  const pathArgs = args
    .map(a => (a.startsWith('-') ? embeddedPathCandidate(a) : a))
    .filter((a): a is string => a !== null);
  for (const p of pathArgs) {
if (isProtectedPath(p, cwd)) {
  return {
    allowed: false,
    reason: `find over protected path '${p}' is forbidden`,
    trust_level: 'SAFE_READONLY',
  };
}
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

function validateReadOnlyPathArgs(baseCommand: string, args: string[], cwd?: string): ValidationResult {
  // These are read-only but we still block protected paths
  for (const arg of args) {
const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
if (candidate !== null && isReadDeniedPath(candidate, cwd)) {
  return {
    allowed: false,
    reason: `${baseCommand} on protected path '${arg}' is forbidden`,
    trust_level: 'SAFE_READONLY',
  };
}
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
return {
  allowed: false,
  reason: `inline code execution via '${baseCommand}' eval flag is forbidden`,
  trust_level: 'DANGEROUS',
};
  }

  // Any argument that resolves to a protected path (a script path, a
  // require target, etc.) is denied the same way 'cat'/'find' deny it —
  // being in SAFE_DEV means "safe to run", not "exempt from path checks".
  for (const arg of args) {
const candidate = arg.startsWith('-') ? embeddedPathCandidate(arg) : arg;
if (candidate !== null && isProtectedPath(candidate, cwd)) {
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
    case 'git': return validateGitArgs(args);
    case 'grep': return validateGrepArgs(args, cwd);
    case 'cat': return validateCatArgs(args, cwd);
    case 'find': return validateFindArgs(args, cwd);
    case 'head':
    case 'stat':
    case 'ls': return validateReadOnlyPathArgs(baseCommand, args, cwd);
    case 'npm':
    case 'npx':
    case 'node':
    case 'tsc': return validateDevToolArgs(baseCommand, args, cwd);
    default:
      return { allowed: true, trust_level: 'SAFE_READONLY' };
  }
}

export function validateCommand(command: string, cwd?: string): ValidationResult {
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
  const unwrapped = unwrapLeadingConstructs(rawTokens);
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
  const args = tokens.slice(1);

  // 2. `eval` executes its entire argument list as shell code — the same
  // risk class as `bash -c`, but with no separate flag to opt into eval mode
  // (the invocation itself IS the eval), so it is always denied rather than
  // matched via INLINE_EVAL_COMMANDS' flag detection below.
  if (baseCommand === 'eval' && args.length > 0) {
    return {
      allowed: false,
      reason: `inline code execution via 'eval' is forbidden — write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
  }

  // 3. Dangerous commands: denied regardless of args
  if (DANGEROUS.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `'${baseCommand}' is a destructive command and is always denied`,
      trust_level: 'DANGEROUS',
    };
  }

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
  const evalName = INLINE_EVAL_COMMANDS[baseCommand] ? baseCommand : bareInterpreterName(baseCommand);
  const evalFlagsForBase = INLINE_EVAL_COMMANDS[evalName];
  const clusters = !NO_SHORT_FLAG_CLUSTERS.has(evalName);
  if (evalFlagsForBase && args.some(a => matchesEvalFlag(bareToken(a), evalFlagsForBase, clusters ? stripQuotes(a) : null))) {
    return {
      allowed: false,
      reason: `inline code execution via '${baseCommand}' eval flag is forbidden — write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
  }

  // 5. Destructive variants of common CLIs (docker prune/rm, gh delete,
  // prisma reset...) hard-block for the same reason inline eval does: the
  // allowlist miss below is advisory-only at the hook layer, so without this
  // check `docker system prune -af` would execute with nothing but a
  // warning. Non-destructive forms of these CLIs keep the advisory path,
  // and package runners (npx, yarn...) are unwrapped to the inner command.
  const destructiveDenial = destructiveVerdict(baseCommand, args);
  if (destructiveDenial) return destructiveDenial;

  // 6. Per-command checks (protected paths, destructive git/find forms,
  // dev-tool targets) and the allowlist verdict, always. They used to sit
  // behind the metacharacter step below, so any `2>/dev/null`, pipe or `$`
  // in the command made that advisory-only step return first and the
  // protected-path denial for `cat ~/.ssh/id_rsa 2>/dev/null` never ran.
  const verdict = validateAgainstAllowlist(baseCommand, args, cwd);
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
    };
  }

  return verdict;
}

const ALLOWLIST_MISS_MARKER = 'is not in the allowlist';

// Verdicts the hooks only warn about; everything else blocks. The Bash hook
// keeps its own copy of this list because it is installed on its own.
export const ADVISORY_REASON_MARKERS = ['Shell chaining/metacharacters are forbidden', ALLOWLIST_MISS_MARKER];

export function isAdvisoryVerdict(verdict: ValidationResult): boolean {
  const reason = verdict.reason ?? '';
  return ADVISORY_REASON_MARKERS.some(marker => reason.includes(marker));
}

// Splits one script line into the commands a shell would run: unquoted
// ;, |, || and && boundaries. Quotes are honored; nothing else is parsed.
export function splitShellLine(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ';' || ch === '|' || ch === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function isAllowlistMissVerdict(verdict: ValidationResult): boolean {
  return !verdict.allowed && String(verdict.reason ?? '').includes(ALLOWLIST_MISS_MARKER);
}

// Filesystem targets an argument can carry: a bare operand (URIs excluded,
// they are download targets, not local paths), a --flag=value value, or a
// value glued to a short flag (`-o~/.bashrc`).
function pathCandidatesOf(args: string[]): string[] {
  return args.flatMap(rawArg => {
    const arg = bareToken(rawArg);
    if (!arg.startsWith('-')) {
      return /^[a-z][a-z\d+.-]*:\/\//i.test(arg) ? [] : [arg];
    }
    const eq = arg.indexOf('=');
    if (eq > 0) return [arg.slice(eq + 1)];
    if (!arg.startsWith('--') && arg.length > 2) return [arg.slice(2)];
    return [];
  });
}

// Catalogued commands (SAFE_READONLY/SAFE_DEV) get their own per-command
// checks in validateCommandArgs. Everything else is advisory-only at the
// hook layer (ADVISORY_REASONS in pre-bash-guardian-validate.js), UNLESS it
// targets a protected file, which hard-blocks here (EGC-494): without this,
// `wget -O ~/.bashrc <url>` had zero protected-path coverage because the
// generic allowlist-miss advisory swallowed every case.
function validateAgainstAllowlist(baseCommand: string, args: string[], cwd?: string): ValidationResult {
  if (SAFE_READONLY.includes(baseCommand) || SAFE_DEV.includes(baseCommand)) {
    return validateCommandArgs(baseCommand, args, cwd);
  }
  const protectedTarget = pathCandidatesOf(args).find(arg => isProtectedPath(arg, cwd));
  if (protectedTarget) {
    return {
      allowed: false,
      reason: `'${baseCommand}' targets a protected file (${protectedTarget}) and is always denied, regardless of allowlist status`,
      trust_level: 'DANGEROUS',
    };
  }
  return {
    allowed: false,
    reason: `Command '${baseCommand}' ${ALLOWLIST_MISS_MARKER}`,
    trust_level: 'BLOCKED',
  };
}

export function validateWrite(filepath: string): ValidationResult {
  if (isProtectedPath(filepath)) {
    return {
      allowed: false,
      reason: `Path '${filepath}' is protected`,
      trust_level: 'BLOCKED',
    };
  }
  return { allowed: true };
}
