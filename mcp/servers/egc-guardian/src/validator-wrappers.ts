import { readParallelOption } from './parallel-options.js';
import { LOCAL_WRAPPER_SPECS } from './local-wrappers.js';
import { RUNNER_SPECS, type RunnerSpec } from './runner-wrappers.js';
import { stripQuotes, commandName } from './validator-tokens.js';

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

export function readWrapperOptions(current: string[], spec: WrapperSpec): WrapperOptions {
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

// A runner's options from `from`, up to the first operand or past `--`.
function readRunnerOptions(values: string[], from: number, spec: RunnerSpec): { names: string[]; end: number } {
  const names: string[] = [];
  let i = from;
  while (i < values.length && values[i].startsWith('-') && values[i] !== '-') {
    if (values[i] === '--') return { names, end: i + 1 };
    const option = readWrapperOption(values[i], spec);
    names.push(...option.names);
    i += option.width;
  }
  return { names, end: i };
}

// Where the command a runner runs starts among `values` (the runner first,
// quotes stripped), and the option that hands it to a shell as one string
// instead; null when the runner runs no command here (`uv pip install`,
// `pnpm install`).
export function runnerCommandStart(values: string[]): { start: number; shellFlag: string | null } | null {
  const spec = RUNNER_SPECS[commandName(values[0] ?? '')];
  if (!spec) return null;
  const first = readRunnerOptions(values, 1, spec);
  let names = first.names;
  let start = first.end;
  if (spec.subcommands) {
    const subcommandAt = (at: number) => spec.subcommands?.find(words => words.every((word, k) => values[at + k] === word));
    let match = subcommandAt(start);
    // An option the table does not know may take a value (`npm --loglevel
    // info exec`): a word after an option that is not a subcommand is read
    // as its value, and the options go on.
    while (!match && start > 1 && start < values.length && values[start - 1].startsWith('-')) {
      const more = readRunnerOptions(values, start + 1, spec);
      names = [...names, ...more.names];
      start = more.end;
      match = subcommandAt(start);
    }
    if (!match) return null;
    const after = start + match.length;
    if (spec.keepsSubcommand?.includes(match.at(-1) ?? '')) return { start: after - 1, shellFlag: null };
    const again = readRunnerOptions(values, after, spec);
    names = [...names, ...again.names];
    start = again.end;
  }
  const shellFlag = names.find(name => spec.shellFlags?.has(name)) ?? null;
  return start < values.length || shellFlag !== null ? { start, shellFlag } : null;
}
