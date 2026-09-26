'use strict';

/**
 * How a wrapper (sudo, env, timeout, xargs, parallel, ...) reads its own
 * options, for the hooks that must find the command behind it: the same
 * tables and rules as the egc-guardian validator (validator.ts,
 * local-wrappers.ts and parallel-options.ts), which cannot be required from
 * here.
 * tests/lib/wrapper-options.test.js keeps the two in step.
 */

const set = values => new Set(values);

// Options that take a value, short and long; optional values attached only;
// exact no-value long names that are a prefix of a value option; leading
// positional operands before the wrapped command, and the pattern a leading
// positional the wrapper may leave out must match to be read as one.
const WRAPPER_SPECS = {
  sudo: {
    valueFlags: set(['-a', '--auth-type', '-u', '--user', '-g', '--group', '-p', '--prompt', '-h', '--host', '-C', '--close-from', '-c', '--login-class', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-R', '--chroot', '-D', '--chdir']),
    exactLongFlags: set(['--login']),
  },
  doas: { valueFlags: set(['-a', '-u', '-C']) },
  env: { valueFlags: set(['-a', '--argv0', '-u', '--unset', '-C', '--chdir', '-f', '--file', '-S', '--split-string']) },
  nohup: { valueFlags: set([]) },
  time: { valueFlags: set(['-o', '--output', '-f', '--format']) },
  command: { valueFlags: set([]) },
  exec: { valueFlags: set(['-a']) },
  nice: { valueFlags: set(['-n', '--adjustment']) },
  ionice: { valueFlags: set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']) },
  timeout: { valueFlags: set(['-s', '--signal', '-k', '--kill-after']), leadingPositionals: 1 },
  stdbuf: { valueFlags: set(['-i', '--input', '-o', '--output', '-e', '--error']) },
  xargs: {
    valueFlags: set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
    optionalValueFlags: set(['-e', '-i', '-l']),
  },
  flock: { valueFlags: set(['-w', '--timeout', '--wait', '-E', '--conflict-exit-code']), leadingPositionals: 1 },
  watch: { valueFlags: set(['-n', '--interval', '-q', '--equexit']), optionalValueFlags: set(['-d']) },
  strace: {
    valueFlags: set([
      '-a', '-b', '-e', '-E', '-I', '-o', '-O', '-p', '-P', '-s', '-S', '-u', '-U', '-X',
      '--abbrev', '--argv0', '--attach', '--columns', '--const-print-style', '--decode-pids', '--detach-on',
      '--env', '--fault', '--inject', '--interruptible', '--kvm', '--output', '--raw', '--read', '--signal',
      '--status', '--string-limit', '--summary-columns', '--summary-sort-by', '--summary-syscall-overhead',
      '--syscall-limit', '--trace', '--trace-fds', '--trace-path', '--user', '--verbose', '--write',
      '--stack-trace-frame-limit',
    ]),
    exactLongFlags: set(['--stack-trace']),
  },
  'systemd-run': {
    valueFlags: set([
      '-p', '--property', '-u', '--unit', '--slice', '--uid', '--gid', '--nice', '-E', '--setenv',
      '--working-directory', '-M', '--machine', '-H', '--host', '--description', '--background',
      '--expand-environment', '--on-active', '--on-boot', '--on-calendar', '--on-startup', '--on-unit-active',
      '--on-unit-inactive', '--path-property', '--service-type', '--socket-property', '--timer-property',
      '--json',
    ]),
  },
  parallel: { valueFlags: set([]), reader: 'parallel' },
  setsid: { valueFlags: set([]) },
  taskset: { valueFlags: set([]), leadingPositionals: 1 },
  chrt: {
    valueFlags: set(['-D', '-P', '-T', '-U', '-X', '--sched-runtime', '--sched-period', '--sched-deadline', '--clamp-min', '--clamp-max']),
    leadingPositionals: 1,
    positionalWhen: /^\d+$/,
  },
  unshare: {
    valueFlags: set([
      '-R', '-w', '-S', '-G', '-l', '--root', '--wd', '--setuid', '--setgid', '--load-interp',
      '--map-user', '--map-users', '--map-group', '--map-groups', '--propagation', '--setgroups',
      '--monotonic', '--boottime', '--owner', '--whitelist-env',
    ]),
  },
  nsenter: {
    valueFlags: set(['-t', '-N', '-S', '-G', '--target', '--net-socket', '--setuid', '--setgid']),
    optionalValueFlags: set(['-m', '-u', '-i', '-n', '-p', '-C', '-U', '-T', '-r', '-w', '-W']),
    exactLongFlags: set([
      '--all', '--help', '--version', '--mount', '--uts', '--ipc', '--net', '--pid', '--user', '--cgroup', '--time',
      '--root', '--wd', '--wdns', '--env', '--no-fork', '--join-cgroup', '--preserve-credentials', '--keep-caps',
      '--user-parent', '--follow-context',
    ]),
  },
  runuser: {
    valueFlags: set([
      '-c', '-g', '-G', '-s', '-u', '-w', '--command', '--session-command', '--group', '--supp-group',
      '--shell', '--user', '--whitelist-environment',
    ]),
  },
  prlimit: {
    valueFlags: set(['-p', '-o', '--pid', '--output']),
    optionalValueFlags: set(['-c', '-d', '-e', '-f', '-i', '-l', '-m', '-n', '-q', '-r', '-s', '-t', '-u', '-v', '-x', '-y']),
  },
  chroot: { valueFlags: set(['--groups', '--userspec']), exactLongFlags: set(['--skip-chdir']), leadingPositionals: 1 },
  numactl: {
    valueFlags: set([
      '-i', '-w', '-p', '-P', '-c', '-N', '-C', '-m', '-S', '-f', '-o', '-L', '-M', '-I',
      '--interleave', '--weighted-interleave', '--preferred', '--preferred-many', '--cpubind', '--cpunodebind',
      '--physcpubind', '--membind', '--shm', '--file', '--offset', '--length', '--shmmode', '--shmid',
    ]),
  },
  pkexec: { valueFlags: set(['-u', '--user']) },
  busybox: { valueFlags: set([]) },
  bwrap: { valueFlags: set([]), reader: 'bwrap' },
};

// bwrap reads exact option names, each followed by a fixed number of
// values, up to the first word that is not an option or a `--`.
const BWRAP_ARITY = {
  '--args': 1, '--argv0': 1, '--userns': 1, '--userns2': 1, '--userns-block-fd': 1, '--pidns': 1, '--uid': 1, '--gid': 1,
  '--hostname': 1, '--chdir': 1, '--unsetenv': 1, '--lock-file': 1, '--sync-fd': 1, '--block-fd': 1,
  '--info-fd': 1, '--json-status-fd': 1, '--seccomp': 1, '--add-seccomp-fd': 1, '--exec-label': 1,
  '--file-label': 1, '--proc': 1, '--dev': 1, '--tmpfs': 1, '--mqueue': 1, '--dir': 1,
  '--remount-ro': 1, '--overlay-src': 1, '--tmp-overlay': 1, '--ro-overlay': 1, '--cap-add': 1,
  '--cap-drop': 1, '--perms': 1, '--size': 1,
  '--bind': 2, '--bind-try': 2, '--ro-bind': 2, '--ro-bind-try': 2, '--dev-bind': 2,
  '--dev-bind-try': 2, '--bind-fd': 2, '--ro-bind-fd': 2, '--bind-data': 2, '--ro-bind-data': 2,
  '--file': 2, '--symlink': 2, '--chmod': 2, '--setenv': 2,
  '--overlay': 3,
};

// The first value of a bwrap option is the one the hook moves by (--chdir).
function readBwrapOption(word, next) {
  const arity = Object.hasOwn(BWRAP_ARITY, word) ? BWRAP_ARITY[word] : 0;
  if (arity === 0) return noValue([word], 1);
  return { names: [word], width: 1 + arity, valueName: word, value: next };
}

// getopt_long takes an exact long name as itself and a prefix that names a
// single option as that option; a prefix that fits several is an error that
// stops the wrapper, so it is left as written.
function resolveLongOption(name, spec) {
  if (name.length <= 2) return name;
  const known = [...spec.valueFlags, ...(spec.exactLongFlags || [])];
  const matches = known.filter(flag => flag.startsWith(name));
  return matches.length === 1 ? matches[0] : name;
}

const noValue = (names, width) => ({ names, width, valueName: null, value: undefined });

// One option word read the way getopt reads it: how many words it spans and,
// for an option that takes a value, which option and what value.
function readLongGetoptOption(word, spec, next) {
  const eq = word.indexOf('=');
  const name = resolveLongOption(eq > 0 ? word.slice(0, eq) : word, spec);
  if (!spec.valueFlags.has(name)) return noValue([name], 1);
  if (eq > 0) return { names: [name], width: 1, valueName: name, value: word.slice(eq + 1) };
  return { names: [name], width: 2, valueName: name, value: next };
}

// A bundle of short options ends at the first one that takes a value: an
// optional value only attached, a required one attached or in the next word.
function readShortGetoptBundle(word, spec, next) {
  const names = [];
  for (let k = 1; k < word.length; k++) {
    const name = `-${word[k]}`;
    names.push(name);
    const rest = word.slice(k + 1);
    if (spec.optionalValueFlags?.has(name)) return { names, width: 1, valueName: name, value: rest || undefined };
    if (!spec.valueFlags.has(name)) continue;
    if (rest) return { names, width: 1, valueName: name, value: rest };
    return { names, width: 2, valueName: name, value: next };
  }
  return noValue(names, 1);
}

function readGetoptOption(word, spec, next) {
  return word.startsWith('--') ? readLongGetoptOption(word, spec, next) : readShortGetoptBundle(word, spec, next);
}

// GNU parallel's own options_completion_hash (src/parallel 20260922), read
// with Perl's Getopt::Long ("bundling", "require_order") as parallel does.
const PARALLEL_SPECS = [
  'debug|D=s', 'xargs', 'm', 'X', 'v', 'sql=s', 'sql-master|sqlmaster=s', 'sql-worker|sqlworker=s',
  'sql-and-worker|sqlandworker=s', 'joblog|jl=s', 'results|result|res=s', 'resume', 'resume-failed|resumefailed',
  'retry-failed|retryfailed', 'silent', 'keep-order|keeporder|k', 'no-keep-order|nokeeporder|nok|no-k', 'group', 'g',
  'ungroup|u', 'latest-line|latestline|ll', 'line-buffer|line-buffered|linebuffer|linebuffered|lb', 'tmux',
  'tmux-pane|tmuxpane', 'null|0', 'quote|q', 'parens=s', 'rpl=s', 'plus', 'I=s', 'extensionreplace|er=s', 'U=s',
  'basenamereplace|bnr=s', 'dirnamereplace|dnr=s', 'basenameextensionreplace|bner=s', 'seqreplace=s',
  'slotreplace=s', 'delay=s', 'ssh-delay|sshdelay=f', 'load=s', 'noswap',
  'max-line-length-allowed|maxlinelengthallowed', 'number-of-cpus|numberofcpus', 'number-of-sockets|numberofsockets',
  'number-of-cores|numberofcores', 'number-of-threads|numberofthreads',
  'use-sockets-instead-of-threads|usesocketsinsteadofthreads',
  'use-cores-instead-of-threads|usecoresinsteadofthreads', 'use-cpus-instead-of-cores|usecpusinsteadofcores',
  'shell-quote|shellquote|shell_quote', 'nice=i', 'tag', 'tag-string|tagstring=s', 'ctag',
  'ctag-string|ctagstring=s', 'color|colour',
  'color-failed|colour-failed|colorfailed|colourfailed|color-fail|colour-fail|colorfail|colourfail|cf', 'onall',
  'nonall', 'filter-hosts|filterhosts|filter-host', 'sshlogin|S=s', 'sshloginfile|slf=s', 'controlmaster|M', 'ssh=s',
  'transfer-file|transferfile|transfer-files|transferfiles|tf=s', 'return=s', 'trc=s', 'transfer', 'cleanup',
  'basefile|bf=s', 'template|tmpl=s', 'B=s', 'ctrl-c|ctrlc', 'no-ctrl-c|no-ctrlc|noctrlc', 'work-dir|workdir|wd=s',
  'W=s', 'rsync-opts|rsyncopts=s', 'tmpdir|tempdir=s',
  'use-compress-program|compress-program|usecompressprogram|compressprogram=s',
  'use-decompress-program|decompress-program|usedecompressprogram|decompressprogram=s', 'compress', 'open-tty|o',
  'tty', 'T', 'H=i', 'dry-run|dryrun|dr', 'progress', 'eta', 'bar', 'total-jobs|totaljobs|total=s', 'shuf',
  'milestone|ms=s', 'arg-sep|argsep=s', 'arg-file-sep|argfilesep=s', 'trim=s', 'env=s', 'recordenv|record-env',
  'session', 'plain', 'profile|J=s', 'tollef', 'gnu', 'link|xapply', 'linkinputsource|xapplyinputsource=i',
  'bibtex|citation', 'will-cite|willcite|nn|nonotice|no-notice', 'halt-on-error|haltonerror|halt=s', 'limit=s',
  'memfree=s', 'memsuspend=s', 'retries=s', 'timeout=s', 'term-seq|termseq=s', 'max-procs|maxprocs|P|jobs|j=s',
  'delimiter|d=s', 'max-chars|maxchars|s=s', 'arg-file|argfile|a=s', 'no-run-if-empty|norunifempty|r', 'replace|i:s',
  'E=s', 'eof|e:s', 'process-slot-var|processslotvar=s', 'max-args|maxargs|n=s',
  'max-replace-args|maxreplaceargs|N=s', 'col-sep|colsep|C=s', 'match=s', 'csv', 'help|h', 'L=s',
  'max-lines|maxlines|l:f', 'interactive|p', 'verbose|t', 'version|V', 'min-version|minversion=i',
  'show-limits|showlimits', 'exit|x', 'semaphore', 'semaphore-timeout|semaphoretimeout|st=s',
  'semaphore-name|semaphorename|id=s', 'fg', 'bg', 'wait', 'shebang|hashbang', '_pipe-means-argfiles', 'Y',
  'skip-first-line|skipfirstline', 'unsafe', '_bug', 'pipe|spreadstdin', 'round-robin|roundrobin|round',
  'recstart=s', 'recend=s', 'regexp|regex', 'remove-rec-sep|removerecsep|rrs', 'output-as-files|outputasfiles|files',
  'output-as-files0|outputasfiles0|files0', 'block-size|blocksize|block=s', 'block-timeout|blocktimeout|bt=s',
  'header=s', 'cat', 'fifo', 'pipe-part|pipepart', 'tee', 'shard=s', 'bin=s', 'group-by|groupby=s',
  'hgrp|hostgrp|hostgroup|hostgroups', 'embed', 'filter=s',
  'combineexec|combine-exec|combineexecutable|combine-executable=s', 'fast', '_parset=s', '_pipe_block=i',
  '_buf_start=i', '_buf_growth=f', '_buf_cap=i', '_no_blocksize_warning', 'shell-completion|shellcompletion=s',
];

function kindOf(type) {
  if (type.startsWith('=')) return 'value';
  if (type === ':s') return 'optionalString';
  if (type.startsWith(':')) return 'optionalNumber';
  return 'flag';
}

const PARALLEL_OPTIONS = new Map();
PARALLEL_SPECS.forEach((entry, id) => {
  const typeAt = entry.search(/[=:]/);
  const names = typeAt < 0 ? entry : entry.slice(0, typeAt);
  const kind = kindOf(typeAt < 0 ? '' : entry.slice(typeAt));
  for (const name of names.split('|')) PARALLEL_OPTIONS.set(name, { id, kind });
});

// Getopt::Long's PAT_FLOAT: `.5`, `5.`, `1e3` and a sign are all numbers.
const NUMBER_RE = /^[-+]?(?=\.?\d)[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?[\d_]+)?$/;

function parallelLongOption(name) {
  const lower = name.toLowerCase();
  const exact = PARALLEL_OPTIONS.get(lower);
  if (exact) return exact;
  const matches = new Map();
  for (const [key, option] of PARALLEL_OPTIONS) {
    if (key.startsWith(lower)) matches.set(option.id, option);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function takesNextWord(kind, next) {
  if (next === undefined) return false;
  if (kind === 'value') return true;
  if (kind === 'optionalString') return !next.startsWith('-');
  if (kind === 'optionalNumber') return NUMBER_RE.test(next);
  return false;
}

function readParallelOption(word, next) {
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    const option = parallelLongOption(eq > 0 ? word.slice(2, eq) : word.slice(2));
    const takes = option !== null && eq < 0 && takesNextWord(option.kind, next);
    return noValue([], takes ? 2 : 1);
  }
  for (let k = 1; k < word.length; k++) {
    const option = PARALLEL_OPTIONS.get(word[k]);
    if (!option) break;
    if (option.kind === 'flag') continue;
    const attached = k < word.length - 1;
    return noValue([], !attached && takesNextWord(option.kind, next) ? 2 : 1);
  }
  return noValue([], 1);
}

// One option word of the wrapper `name`, `word` and `next` already stripped
// of quotes; null when `name` is not a known wrapper.
function readWrapperOption(name, word, next) {
  const spec = WRAPPER_SPECS[name];
  if (!spec) return null;
  if (spec.reader === 'parallel') return readParallelOption(word, next);
  if (spec.reader === 'bwrap') return readBwrapOption(word, next);
  return readGetoptOption(word, spec, next);
}

module.exports = { WRAPPER_SPECS, PARALLEL_SPECS, readWrapperOption, readParallelOption, readBwrapOption };
