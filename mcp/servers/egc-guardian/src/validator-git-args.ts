import fs from 'node:fs';
import path from 'node:path';
import { gitWordsNamingFiles } from './pattern-operands.js';
import { readDenial, type ValidationResult } from './validator-session.js';
import { bareToken, stripQuotes, commandName } from './validator-tokens.js';
import { isInlineProgram, GIT_VALUE_SHELLS } from './validator-eval.js';
import { expandHome } from './validator-path-utils.js';
import { isTrustedGitDirectory } from './validator-hook-surfaces.js';
import { pathValue, pathReadings, pathCandidatesOf, isProtectedOperand, isReadDeniedOperand } from './validator-line-values.js';
import { parseGitConfigCall, isDangerousGitConfigWrite, checkGitConfigWrite, findGitSubcommandIndex, checkInlineGitConfigOverrides } from './validator-git-config.js';
import { validateCommandVerdict } from './validator.js';

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
    const at = isLong ? option.indexOf('=') + 1 : shortFlag?.length ?? 0;
    const glued = isLong && at === 0 ? '' : option.slice(at);
    if (option.includes('=') || (!isLong && glued !== '')) files.push(pathValue(rest[i], option, at));
    else if (rest[i + 1] !== undefined) files.push(rest[i + 1]);
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
function gitPlaces(globals: string[], cwd?: string, reading = 0): { dir: string; top: string } {
  let dir = path.resolve(cwd ?? process.cwd());
  let top: string | null = null;
  for (let i = 0; i < globals.length; i++) {
    const option = stripQuotes(globals[i]);
    const next = globals[i + 1] === undefined ? undefined : expandHome(pathValue(globals[i + 1], '', 0, reading));
    if (option === '-C' && next !== undefined) dir = path.resolve(dir, next);
    else if (option === '--work-tree' && next !== undefined) top = path.resolve(dir, next);
    else if (option.startsWith('--work-tree=')) top = path.resolve(dir, expandHome(pathValue(globals[i], option, '--work-tree='.length, reading)));
  }
  return { dir, top: top ?? nearestGitTop(dir) };
}

// Whether `dir` is a git directory as git recognizes one: HEAD, objects and
// refs. A git directory made by hand, its config written first, counts.
function isGitDirectory(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile()
      && fs.statSync(path.join(dir, 'objects')).isDirectory()
      && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

// The directory a `.git` file names, relative to the file: git reads it
// only when the file starts with `gitdir: `, and refuses any other.
const GITFILE_PREFIX = 'gitdir: ';

function gitfileTarget(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    const [first] = fs.readFileSync(file, 'utf8').split('\n');
    if (!first.startsWith(GITFILE_PREFIX)) return null;
    return path.resolve(path.dirname(file), first.slice(GITFILE_PREFIX.length).trim());
  } catch {
    return null;
  }
}

// A git directory named outright (--git-dir, GIT_DIR) that is a file git
// reads as a .git file, following its gitdir: line to the directory it uses.
export function followedGitDirectory(dir: string): string {
  return gitfileTarget(dir) ?? dir;
}

// The git directory git finds up from `dir`, in git's order at each level:
// a `.git` directory it recognizes, a `.git` file's gitdir:, then the
// level itself as a bare repository. null when there is none.
function discoveredGitDirectory(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const dotGit = path.join(current, '.git');
    if (isGitDirectory(dotGit)) return dotGit;
    const linked = gitfileTarget(dotGit);
    if (linked !== null) return linked;
    if (isGitDirectory(current)) return current;
    if (path.dirname(current) === current) return null;
  }
}

// The last --git-dir among git's global options, in one reading of its path.
function namedGitDirectory(globals: string[], reading = 0): string | undefined {
  let named: string | undefined;
  for (let i = 0; i < globals.length; i++) {
    const option = stripQuotes(globals[i]);
    if (option === '--git-dir' && globals[i + 1] !== undefined) named = pathValue(globals[i + 1], '', 0, reading);
    else if (option.startsWith('--git-dir=')) named = pathValue(globals[i], option, '--git-dir='.length, reading);
  }
  return named;
}

// The git directory git uses in one reading of the paths its options name:
// the one --git-dir names, or the one found up from where it runs.
function usedGitDirectory(globals: string[], cwd: string | undefined, reading: number): string | null {
  const { dir } = gitPlaces(globals, cwd, reading);
  const named = namedGitDirectory(globals, reading);
  return named === undefined ? discoveredGitDirectory(dir) : followedGitDirectory(path.resolve(dir, expandHome(named)));
}

// git loads the config and runs the hooks of the git directory it uses,
// named by --git-dir or found up from where it runs. One outside the .git
// convention has neither protected from a write, so what was planted there
// would run: git is refused it, in every reading of the paths it is handed.
function checkGitDirectory(globals: string[], cwd?: string): ValidationResult | null {
  const gitDir = pathReadings().map(reading => usedGitDirectory(globals, cwd, reading)).find(found => found !== null && !isTrustedGitDirectory(found));
  if (gitDir === undefined || gitDir === null) return null;
  return {
    allowed: false,
    reason: `git would load the config and run the hooks of '${gitDir}', a git directory not named .git or <name>.git, where nothing protects them from a write, and is forbidden`,
    trust_level: 'DANGEROUS',
  };
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
  // A message, a search or a grep pattern is text, not a file it names.
  const named = pathOnly ? [] : gitWordsNamingFiles(subcommand, rest);
  const reached = pathOnly ? [...globals, ...gitReadOptionFiles(subcommand, rest)] : [...globals, ...named];
  const objects = pathOnly ? [] : gitObjectFiles(globals, named, cwd);
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

// Options whose value git runs as a command, by subcommand, from the manual
// pages of git 2.51: long names (`--exec=cmd`, `--exec cmd`) and short
// letters (`-xcmd`, `-x cmd`, or the last letter of a cluster such as -ix);
// grep's -O takes its value glued only. submodule foreach and bisect run
// are read apart. `valued` holds every short letter of the subcommand that
// takes a value: a cluster ends at the first of them, so the letters after
// `-e` in `-eOx` are its pattern, not an -O. `valuedLong` names the long
// options that take a value and run nothing; like a value letter left last
// in a cluster, they take the next word, so `-b --template` names a branch.
interface GitCommandOptions {
  long: string[];
  short?: string;
  valued?: string;
  valuedLong?: string[];
  gluedOnly?: boolean;
}

// The options of git clone and git init that take a value, from their
// manual pages: init has only -b of these letters, and any other one stops
// it before anything runs.
const NEW_REPO_VALUED_SHORT = 'obucj';
const NEW_REPO_VALUED_LONG = [
  '--origin', '--branch', '--revision', '--upload-pack', '--template', '--reference', '--reference-if-able', '--separate-git-dir',
  '--depth', '--shallow-since', '--shallow-exclude', '--jobs', '--config', '--server-option', '--filter', '--bundle-uri',
  '--ref-format', '--object-format', '--initial-branch',
];

const GIT_COMMAND_OPTIONS: Record<string, GitCommandOptions> = {
  difftool: { long: ['--extcmd'], short: 'x', valued: 'tx' },
  rebase: { long: ['--exec'], short: 'x', valued: 'xsXCS' },
  'filter-branch': { long: ['--env-filter', '--tree-filter', '--index-filter', '--parent-filter', '--msg-filter', '--commit-filter', '--tag-name-filter'] },
  'send-email': { long: ['--sendmail-cmd', '--to-cmd', '--cc-cmd', '--header-cmd'] },
  archive: { long: ['--exec'] },
  fetch: { long: ['--upload-pack'] },
  pull: { long: ['--upload-pack'] },
  'ls-remote': { long: ['--upload-pack', '--exec'] },
  clone: { long: ['--upload-pack'], short: 'u', valued: NEW_REPO_VALUED_SHORT, valuedLong: NEW_REPO_VALUED_LONG },
  push: { long: ['--receive-pack', '--exec'] },
  instaweb: { long: ['--httpd', '--browser'], short: 'db', valued: 'dbpm' },
  grep: { long: ['--open-files-in-pager'], short: 'O', valued: 'efABCmO', gluedOnly: true },
};

interface GitCommandValue {
  option: string;
  value: string;
}

// One option read at a word: the command value it carries, when it is a
// command option, and how many words it took.
interface GitCommandOptionRead {
  found?: GitCommandValue;
  width: number;
}

// git takes a long option by any prefix that names it alone (`--exe` for
// --exec) and refuses one two options share, which then runs nothing, so a
// prefix of one of these options is read as that option.
const MIN_LONG_OPTION_PREFIX = 3;

// A long option of `spec` in the word `raw` (`word` without quotes), its
// value glued after `=` or the next word.
function longCommandOption(spec: GitCommandOptions, raw: string, word: string, next: string | undefined): GitCommandOptionRead | null {
  if (!word.startsWith('--')) return null;
  const eq = word.indexOf('=');
  const key = eq < 0 ? word : word.slice(0, eq);
  if (key.length < MIN_LONG_OPTION_PREFIX) return null;
  const option = spec.long.find(name => name.startsWith(key));
  if (option === undefined) return eq < 0 && spec.valuedLong?.some(name => name.startsWith(key)) ? { width: 2 } : null;
  if (eq < 0) return { found: { option, value: next ?? '' }, width: 2 };
  return { found: { option, value: raw.slice(raw.indexOf('=') + 1) }, width: 1 };
}

// A short option of `spec` in the cluster `raw`: what follows its letter,
// or the next word when nothing does and the option may take one. The
// cluster ends at its first letter that takes a value; when that letter is
// no command option, the rest of the cluster, or the next word when nothing
// follows it, is its value and runs nothing.
function shortCommandOption(spec: GitCommandOptions, raw: string, word: string, next: string | undefined): GitCommandOptionRead | null {
  const letters = spec.short ?? '';
  const valued = spec.valued ?? letters;
  if (valued === '' || !/^-[A-Za-z]/.test(word)) return null;
  const letterAt = [...word].findIndex((letter, at) => at > 0 && valued.includes(letter));
  if (letterAt < 0) return null;
  const glued = raw.slice(raw.indexOf(word[letterAt], 1) + 1);
  if (!letters.includes(word[letterAt])) return glued === '' ? { width: 2 } : null;
  const option = `-${word[letterAt]}`;
  if (glued !== '') return { found: { option, value: glued }, width: 1 };
  return spec.gluedOnly ? null : { found: { option, value: next ?? '' }, width: 2 };
}

// The command values the options of `spec` carry among `rest`.
function gitCommandOptionValues(spec: GitCommandOptions | undefined, rest: string[]): GitCommandValue[] {
  const found: GitCommandValue[] = [];
  let i = 0;
  while (spec && i < rest.length) {
    const word = stripQuotes(rest[i]);
    if (word === '--') break;
    const read = longCommandOption(spec, rest[i], word, rest[i + 1]) ?? shortCommandOption(spec, rest[i], word, rest[i + 1]);
    if (read?.found) found.push(read.found);
    i += read?.width ?? 1;
  }
  return found;
}

// `git submodule [options] foreach [--recursive] [--] <command>`: the words
// after foreach are the command, which git evaluates in a shell.
function submoduleForeachCommand(rest: string[]): GitCommandValue[] {
  let i = 0;
  while (i < rest.length && stripQuotes(rest[i]).startsWith('-')) i += 1;
  if (stripQuotes(rest[i] ?? '') !== 'foreach') return [];
  i += 1;
  // foreach's own options (--recursive, --quiet), which git takes by any
  // prefix; one it does not know stops it before anything runs.
  while (i < rest.length && stripQuotes(rest[i]).startsWith('-') && stripQuotes(rest[i]) !== '--') i += 1;
  if (stripQuotes(rest[i] ?? '') === '--') i += 1;
  const words = rest.slice(i);
  return words.length === 0 ? [] : [{ option: 'foreach', value: words.join(' ') }];
}

function gitInlineCommandDenial(subcommand: string, option: string): ValidationResult {
  return {
    allowed: false,
    reason: `git ${subcommand} runs the value of ${option} as a command, and shell code or a shell there is inline code, which is forbidden: write it to a script and name the script`,
    trust_level: 'DANGEROUS',
  };
}

// A value git runs as a command: shell code in it, or a shell that reads a
// script, is inline code and is denied as `sh -c` is; a plain command is
// judged like a typed one and keeps its hard denials.
// `value` is the word as git receives it, the line's own quotes already
// removed (shellWord); the quotes left in it are the ones the shell git
// hands it to reads.
function gitCommandValueDenial(subcommand: string, option: string, value: string, cwd?: string): ValidationResult | null {
  if (isInlineProgram(value)) return gitInlineCommandDenial(subcommand, option);
  const verdict = validateCommandVerdict(value, cwd);
  return verdict.allowed || verdict.advisory ? null : verdict;
}

// `git bisect [--] run <cmd> [<arg>...]`: git runs the command as given,
// with no shell between, so its words are judged as a typed command; a
// shell named there reads a script and is inline code as above.
function bisectRunDenial(rest: string[], cwd?: string): ValidationResult | null {
  let i = 0;
  while (i < rest.length && stripQuotes(rest[i]).startsWith('-')) i += 1;
  if (stripQuotes(rest[i] ?? '') !== 'run') return null;
  const words = rest.slice(i + 1);
  if (GIT_VALUE_SHELLS.has(commandName(stripQuotes(words[0] ?? '')))) return gitInlineCommandDenial('bisect', 'run');
  const verdict = validateCommandVerdict(words.join(' '), cwd);
  return verdict.allowed || verdict.advisory ? null : verdict;
}

// Settings git applies to the repository clone or init makes before
// anything in it runs: clone's -c/--config key=value, written into the new
// repository before the fetch, and the --template of both, whose hooks the
// new repository gets (post-checkout runs on the clone itself). They take
// effect in that very call, as `git -c` does, and are judged by its rules.
const GIT_NEW_REPO_CONFIG: GitCommandOptions = { long: ['--config'], short: 'c', valued: NEW_REPO_VALUED_SHORT, valuedLong: NEW_REPO_VALUED_LONG };
const GIT_TEMPLATE_OPTION: GitCommandOptions = { long: ['--template'], valued: NEW_REPO_VALUED_SHORT, valuedLong: NEW_REPO_VALUED_LONG };

function checkNewRepositorySettings(subcommand: string, rest: string[], cwd?: string): ValidationResult | null {
  if (subcommand !== 'clone' && subcommand !== 'init') return null;
  if (gitCommandOptionValues(GIT_TEMPLATE_OPTION, rest).length > 0) {
    return {
      allowed: false,
      reason: `git ${subcommand} --template copies the hooks of that directory into the new repository, where they run as init.templateDir's would, and is forbidden`,
      trust_level: 'DANGEROUS',
    };
  }
  if (subcommand !== 'clone') return null;
  for (const { value } of gitCommandOptionValues(GIT_NEW_REPO_CONFIG, rest)) {
    const eq = value.indexOf('=');
    const key = (eq > 0 ? value.slice(0, eq) : value).toLowerCase();
    if (!isDangerousGitConfigWrite(key, eq > 0 ? value.slice(eq + 1) : '', cwd)) continue;
    return {
      allowed: false,
      reason: `git clone config for '${key}' is set in the new repository before it is fetched and persists a hook/execution-bypass override, and is forbidden`,
      trust_level: 'DANGEROUS',
    };
  }
  return null;
}

function checkGitCommandOptions(subcommand: string, rest: string[], cwd?: string): ValidationResult | null {
  if (subcommand === 'bisect') return bisectRunDenial(rest, cwd);
  const values = subcommand === 'submodule' ? submoduleForeachCommand(rest) : gitCommandOptionValues(GIT_COMMAND_OPTIONS[subcommand], rest);
  for (const { option, value } of values) {
    const denial = gitCommandValueDenial(subcommand, option, value, cwd);
    if (denial) return denial;
  }
  return null;
}

export function validateGitArgs(args: string[], cwd?: string): ValidationResult {
  const subcommandIdx = findGitSubcommandIndex(args);
  const forceDenial = checkGitForceFlag(args, subcommandIdx, cwd);
  if (forceDenial) return forceDenial;

  const inlineOverrideDenial = checkInlineGitConfigOverrides(args, cwd);
  if (inlineOverrideDenial) return inlineOverrideDenial;

  const pathDenial = checkGitPathArguments(args, subcommandIdx, cwd);
  if (pathDenial) return pathDenial;

  if (subcommandIdx < 0) return { allowed: true, trust_level: 'SAFE_READONLY' };
  const directoryDenial = checkGitDirectory(args.slice(0, subcommandIdx), cwd);
  if (directoryDenial) return directoryDenial;
  const subcommand = bareToken(args[subcommandIdx]);
  const rest = args.slice(subcommandIdx + 1);
  const fileDenial = checkGitFileOperands(subcommand, rest, cwd);
  if (fileDenial) return fileDenial;
  const commandDenial = checkGitCommandOptions(subcommand, rest, cwd) ?? checkNewRepositorySettings(subcommand, rest, cwd);
  if (commandDenial) return commandDenial;
  if (subcommand === 'config') {
    const configDenial = checkGitConfigWrite(args.slice(subcommandIdx), cwd);
    if (configDenial) return configDenial;
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}
