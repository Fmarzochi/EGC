// Trust level tiers
// `[`, `[[` and `test` only stat the files they name, as `stat` does, so they
// are judged as it is: a credential store is refused, .git is not.
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git', '[', '[[', 'test'];
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
