// GNU parallel reads its options with Perl's Getopt::Long ("bundling",
// "require_order"), not with getopt: long names ignore letter case and may be
// cut to any prefix that names one option, a single letter may be any name
// written after `--`, and an option whose value is optional takes the next
// word when it could be that value (":s" when it does not start with a dash,
// ":f" and ":i" when it is a number). The table is parallel's own
// options_completion_hash (src/parallel 20260922), spec strings as written
// there, so it can be compared line by line.
export const PARALLEL_SPECS = [
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

type OptionKind = 'flag' | 'value' | 'optionalString' | 'optionalNumber';

interface ParallelOption {
  id: number;
  kind: OptionKind;
}

function kindOf(type: string): OptionKind {
  if (type.startsWith('=')) return 'value';
  if (type === ':s') return 'optionalString';
  if (type.startsWith(':')) return 'optionalNumber';
  return 'flag';
}

const OPTIONS = new Map<string, ParallelOption>();
PARALLEL_SPECS.forEach((spec, id) => {
  const typeAt = spec.search(/[=:]/);
  const names = typeAt < 0 ? spec : spec.slice(0, typeAt);
  const kind = kindOf(typeAt < 0 ? '' : spec.slice(typeAt));
  for (const name of names.split('|')) OPTIONS.set(name, { id, kind });
});

// Getopt::Long's PAT_FLOAT: `.5`, `5.`, `1e3` and a sign are all numbers.
const NUMBER_RE = /^[-+]?(?=\.?\d)[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?[\d_]+)?$/;

// A name written after `--` is lowered first and then matched as it is
// stored: whole, or as a prefix that every match shares with one option.
// Single letters keep their case in the table, so `--U` is the flag `u` and
// `--B`, having no `b`, is only a prefix, and an ambiguous one. Anything
// that is not one option is an error parallel stops on.
function longOption(name: string): ParallelOption | null {
  const lower = name.toLowerCase();
  const exact = OPTIONS.get(lower);
  if (exact) return exact;
  const matches = new Map<number, ParallelOption>();
  for (const [key, option] of OPTIONS) {
    if (key.startsWith(lower)) matches.set(option.id, option);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function takesNextWord(kind: OptionKind, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (kind === 'value') return true;
  if (kind === 'optionalString') return !next.startsWith('-');
  if (kind === 'optionalNumber') return NUMBER_RE.test(next);
  return false;
}

// How many words one of parallel's option words spans, `word` and `next`
// already stripped of quotes. A bundle of single letters (`-kj4`) is read up
// to the first letter that takes a value, which is the rest of the word or,
// when nothing is left, the next word when it could be that value; an
// unknown letter ends the bundle, as it ends parallel.
export function readParallelOption(word: string, next: string | undefined): { names: string[]; width: number } {
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    const name = eq > 0 ? word.slice(2, eq) : word.slice(2);
    const option = longOption(name);
    const takes = option !== null && eq < 0 && takesNextWord(option.kind, next);
    return { names: [], width: takes ? 2 : 1 };
  }
  for (let k = 1; k < word.length; k++) {
    const option = OPTIONS.get(word[k]);
    if (!option) break;
    if (option.kind === 'flag') continue;
    const attached = k < word.length - 1;
    return { names: [], width: !attached && takesNextWord(option.kind, next) ? 2 : 1 };
  }
  return { names: [], width: 1 };
}
