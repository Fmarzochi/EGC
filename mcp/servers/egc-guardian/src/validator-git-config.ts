import type { ValidationResult } from './validator-session.js';
import { bareToken, stripQuotes, stripEnclosingQuotes } from './validator-tokens.js';
import { tokenizeWords, shellWord } from './validator-shell-text.js';
import { pathValue } from './validator-line-values.js';
import { validateGitArgs } from './validator-git-args.js';

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
export const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix', '--config-env']);

function isDangerousAliasValue(value: string, cwd?: string): boolean {
  const trimmed = stripEnclosingQuotes(value);
  if (stripQuotes(trimmed).startsWith('!')) return true;
  const words = tokenizeWords(trimmed);
  // An alias is judged by the git command it expands to: one that hides
  // a refused force or a clean is as dangerous as typing it.
  if (!validateGitArgs(words.map(shellWord), cwd).allowed) return true;

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
const GIT_CONFIG_VALUE_OPTIONS = new Set(['--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
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

// The file the -f of an option cluster names: glued after it, read as the
// shell hands it, or the next word.
function clusterFile(rest: string[], i: number, cluster: string, at: number): string | undefined {
  return at < cluster.length ? pathValue(rest[i], cluster, at) : rest[i + 1];
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
    const file = kind === 'file' ? clusterFile(rest, i, cluster, j + 1) : undefined;
    if (file !== undefined) call.files.push(file);
    return j + 1 < cluster.length ? i : i + 1;
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
  return full !== null && (eq < 0 || GIT_CONFIG_VALUE_OPTIONS.has(full)) ? full : null;
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
  const value = glued ? pathValue(rest[i], option, option.indexOf('=') + 1) : rest[i + 1];
  if ((valued === '--file' || valued === '--blob') && value !== undefined) call.files.push(value);
  return glued ? i : i + 1;
}

// `rest` is everything after 'config'.
export function parseGitConfigCall(rest: string[]): GitConfigCall {
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
export function isDangerousGitConfigWrite(key: string, value: string | undefined, cwd?: string): boolean {
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
export function checkGitConfigWrite(args: string[], cwd?: string): ValidationResult | null {
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
export function findGitSubcommandIndex(args: string[]): number {
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

export function checkInlineGitConfigOverrides(args: string[], cwd?: string): ValidationResult | null {
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
