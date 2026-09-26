import type { WrapperSpec } from './validator.js';

// Local wrappers that run the command following their own options, with the
// option tables of their own sources: util-linux 2.41 and master (setsid,
// taskset, chrt, unshare, nsenter, runuser, prlimit), coreutils chroot,
// numactl, polkit pkexec, busybox and bubblewrap. Options that exist only
// in master are listed too; an older build refuses them and runs nothing.

// bwrap reads exact option names, each followed by a fixed number of
// values, up to the first word that is not an option or a `--`.
const BWRAP_ARITY: Record<string, number> = {
  '--args': 1, '--userns': 1, '--userns-block-fd': 1, '--pidns': 1, '--uid': 1, '--gid': 1,
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

export function readBwrapOption(word: string): { names: string[]; width: number } {
  return { names: [word], width: 1 + (BWRAP_ARITY[word] ?? 0) };
}

const set = (values: string[]): Set<string> => new Set(values);

export const LOCAL_WRAPPER_SPECS: Record<string, WrapperSpec> = {
  setsid: { valueFlags: set([]) },
  taskset: { valueFlags: set([]), leadingPositionals: 1 },
  // chrt takes a priority before the command; master lets it be left out,
  // and then only an all-digit word is read as one.
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
    exactLongFlags: set(['--net']),
  },
  // runuser runs the command after its options only with -u/--user; without
  // it, it behaves like su and is judged as such.
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
  bwrap: { valueFlags: set([]), readOption: readBwrapOption },
};
