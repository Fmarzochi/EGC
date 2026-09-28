// Heuristic prompt-injection detection for content the agent did not write
// itself (fetched web pages, third-party files, API responses, fork PR
// diffs). Pattern matching only by design: Guardian is a synchronous hook with no
// per-call LLM budget, so this mirrors the pattern-matching approach already
// shipped in mcp/servers/egc-memory/src/sanitize.ts rather than adding a
// semantic/LLM path to the hot validation flow.

export interface InjectionFinding {
  category: string;
  reason: string;
  snippet: string;
}

const MAX_SNIPPET_LEN = 80;

// A curl or wget whose output goes into a pipe, and the programs that run
// what they read there. Each command line (a line, or lines joined by a
// pipe or a backslash that ends one) is read in one pass with no bound on
// the URL or the options: every pipe after the fetch counts, quoted or not,
// since a pipe in a quoted option value and one inside `sh -c "..."` look
// the same here. What the pipe feeds is read past the commands that run the
// next word (sudo, env, doas, nice, nohup...), their options and the values
// those take, and variable assignments, up to a shell or an interpreter,
// named by its path or quoted.
const FETCH_WORD = /\b(?:curl|wget)\b/i;
const FETCH_RUNNER = /^(?:(?:ba|z|da|k)?sh|python[\d.]{0,5}|perl|ruby|node)\b/i;
const NEXT_WORD = /\s*(\S+)/y;
const ASSIGNMENT = /^\w+=/;
const MAX_WORDS_BEFORE_RUNNER = 32;
// The commands that run the next word, with their options that take the
// next word as their value when nothing follows them in their own word
// (sudo -u root, sudo -Eu root, sudo --user root, env -u HOME, nice -n 5).
const WRAPPERS = new Map<string, { letters: string; long: Set<string> }>([
  ['sudo', { letters: 'CDRTUcgprtu', long: new Set(['--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--chroot', '--role', '--type', '--command-timeout', '--other-user', '--login-class']) }],
  ['doas', { letters: 'Cu', long: new Set() }],
  ['env', { letters: 'CSu', long: new Set(['--chdir', '--split-string', '--unset']) }],
  ['nice', { letters: 'n', long: new Set(['--adjustment']) }],
  ['nohup', { letters: '', long: new Set() }],
  ['exec', { letters: 'a', long: new Set() }],
  ['command', { letters: '', long: new Set() }],
  ['time', { letters: 'fo', long: new Set(['--format', '--output']) }],
  ['stdbuf', { letters: 'ieo', long: new Set(['--input', '--output', '--error']) }],
]);
const WGET_WORD = /\bwget\b/i;
const URL_START = /https?:\/\//gi;

// Whether a line goes on in the next one, as the shell reads it: it ends
// with a pipe or a backslash, trailing blanks aside.
function continues(line: string): boolean {
  let end = line.length;
  while (end > 0 && ' \t\r'.includes(line[end - 1])) end--;
  return end > 0 && (line[end - 1] === '|' || line[end - 1] === '\\');
}

function commandLines(text: string): string[] {
  const lines: string[] = [];
  let pending: string[] = [];
  for (const line of text.split('\n')) {
    pending.push(line);
    if (continues(line)) continue;
    lines.push(pending.join('\n'));
    pending = [];
  }
  if (pending.length > 0) lines.push(pending.join('\n'));
  return lines;
}

function optionTakesNextWord(word: string, wrapper: { letters: string; long: Set<string> }): boolean {
  if (word.startsWith('--')) return wrapper.long.has(word);
  for (let k = 1; k < word.length; k++) {
    if (wrapper.letters.includes(word[k])) return k === word.length - 1;
  }
  return false;
}

function runnerEndAfterPipe(line: string, from: number): number {
  NEXT_WORD.lastIndex = from;
  let wrapper: { letters: string; long: Set<string> } | undefined;
  for (let count = 0; count < MAX_WORDS_BEFORE_RUNNER; count++) {
    const match = NEXT_WORD.exec(line);
    if (!match) return -1;
    const word = match[1].replaceAll(/['"]/g, '');
    const name = word.slice(word.lastIndexOf('/') + 1);
    if (FETCH_RUNNER.test(name)) return NEXT_WORD.lastIndex;
    const runs = WRAPPERS.get(name.toLowerCase());
    if (runs) {
      wrapper = runs;
    } else if (wrapper && word.startsWith('-')) {
      if (optionTakesNextWord(word, wrapper) && !NEXT_WORD.exec(line)) return -1;
    } else if (!ASSIGNMENT.test(word)) {
      return -1;
    }
  }
  return -1;
}

function fetchPipedIntoRunner(text: string): string[] | null {
  for (const line of commandLines(text)) {
    const fetch = FETCH_WORD.exec(line);
    if (!fetch) continue;
    let pipe = line.indexOf('|', fetch.index);
    while (pipe !== -1) {
      const next = line[pipe + 1];
      if (next === '|') {
        pipe = line.indexOf('|', pipe + 2);
        continue;
      }
      const end = runnerEndAfterPipe(line, next === '&' ? pipe + 2 : pipe + 1);
      if (end !== -1) return [line.slice(fetch.index, end)];
      pipe = line.indexOf('|', pipe + 1);
    }
  }
  return null;
}

function wgetOutputRedirected(text: string): string[] | null {
  for (const line of commandLines(text)) {
    const wget = WGET_WORD.exec(line);
    if (!wget) continue;
    URL_START.lastIndex = wget.index;
    const url = URL_START.exec(line);
    if (!url) continue;
    const after = url.index + url[0].length;
    const outputs = [line.indexOf('|', after), line.indexOf('>', after)].filter(at => at !== -1);
    if (outputs.length > 0) return [line.slice(wget.index, Math.min(...outputs) + 1)];
  }
  return null;
}

const PATTERNS: Array<{ category: string; pattern: { exec(text: string): readonly string[] | null }; reason: string }> = [
  { category: 'instruction_override', pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|context|prompts?)/i, reason: 'attempt to override prior instructions' },
  { category: 'disregard_directive', pattern: /disregard\s+(all\s+|the\s+)?(system\s+)?(prompt|instructions?|rules?)/i, reason: 'attempt to discard system rules' },
  { category: 'disregard_directive', pattern: /forget\s+(everything|all)\s+(you\s+)?(were\s+told|know)/i, reason: 'attempt to reset prior context' },
  { category: 'fake_system_tag', pattern: /\[\s*SYSTEM\s*\]/i, reason: 'fake [SYSTEM] tag embedded in content' },
  { category: 'fake_system_tag', pattern: /<\s*system\s*>/i, reason: 'fake <system> tag embedded in content' },
  { category: 'fake_system_tag', pattern: /^\s{0,20}SYSTEM\s*:/im, reason: 'fake SYSTEM: line embedded in content' },
  { category: 'persona_hijack', pattern: /you\s+are\s+now\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|DAN)/i, reason: 'attempt to hijack assistant persona' },
  { category: 'new_instructions', pattern: /new\s+instructions?\s*:/i, reason: 'injected "new instructions" block' },
  { category: 'new_instructions', pattern: /^\s{0,20}#{1,3}\s{0,20}(new|updated)\s+(task|instructions?)/im, reason: 'injected heading claiming new task/instructions' },
  { category: 'exfiltration', pattern: /send\s+(this|the\s+above|it)\s+to\s+https?:\/\//i, reason: 'directive to exfiltrate content to a URL' },
  { category: 'exfiltration', pattern: /\bexfiltrate\b/i, reason: 'explicit exfiltration wording' },
  // A fetch piped into a shell or an interpreter, on one line, whatever
  // options stand before the URL (curl -fsSL, wget -qO-, sudo -u root bash).
  { category: 'exfiltration', pattern: { exec: fetchPipedIntoRunner }, reason: 'remote shell execution payload' },
  { category: 'exfiltration', pattern: { exec: wgetOutputRedirected }, reason: 'remote download payload' },
  { category: 'exfiltration', pattern: /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/, reason: 'child_process injection' },
  { category: 'exfiltration', pattern: /import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/, reason: 'child_process injection' },
  { category: 'exfiltration', pattern: /\bexecSync\s*\(\s*[`'"]/, reason: 'execSync injection' },
  { category: 'exfiltration', pattern: /\bchild_process\s*\.\s*exec(?:Sync)?\s*\(/, reason: 'child_process.exec/execSync injection' },
  { category: 'exfiltration', pattern: /\beval\s*\(\s*[`'"]/, reason: 'eval injection' },
  { category: 'exfiltration', pattern: /authorized_keys/i, reason: 'SSH key manipulation payload' },
  { category: 'exfiltration', pattern: /\/etc\/passwd/i, reason: 'sensitive file access payload' },
  { category: 'exfiltration', pattern: /\/etc\/shadow/i, reason: 'shadow file access payload' },
  { category: 'protocol_spoofing', pattern: /<\|im_start\|>/i, reason: 'chat-template control token spoofing' },
  { category: 'protocol_spoofing', pattern: /<\/?(function_results|tool_use|tool_result)>/i, reason: 'fake tool-call boundary tag' },
  // {0,200} is a deliberate bound, not stylistic: an unbounded [\s\S]* here
  // over long fetched content is the classic catastrophic-backtracking shape.
  { category: 'hidden_comment_directive', pattern: /<!--\s*(ignore|system|instructions?)[\s\S]{0,200}-->/i, reason: 'directive hidden inside an HTML comment' },
];

// These are 4 deliberately distinct zero-width codepoints (ZWSP/ZWNJ/ZWJ/BOM),
// not an accidental combining sequence; the rule can't tell the two apart.
const ZERO_WIDTH_CHARS = '\u200B\u200C\u200D\uFEFF';
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_RE = new RegExp(`[${ZERO_WIDTH_CHARS}]`);
const ZERO_WIDTH_NEAR_KEYWORD_RE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class
  String.raw`[${ZERO_WIDTH_CHARS}][\s\S]{0,40}(?:ignore|system|instructions?)|(?:ignore|system|instructions?)[\s\S]{0,40}[${ZERO_WIDTH_CHARS}]`,
  'i',
);

/** Collects every matching pattern; does not short-circuit on the first hit,
 * so a caller can see (and log) the full extent of a suspicious payload. */
export function scanForInjection(text: string): InjectionFinding[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const findings: InjectionFinding[] = [];
  for (const { category, pattern, reason } of PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      findings.push({ category, reason, snippet: match[0].slice(0, MAX_SNIPPET_LEN) });
    }
  }

  if (ZERO_WIDTH_RE.test(text) && ZERO_WIDTH_NEAR_KEYWORD_RE.test(text)) {
    findings.push({
      category: 'invisible_characters',
      reason: 'zero-width/invisible characters clustered near injection keywords',
      snippet: '[zero-width characters near injection keyword]',
    });
  }

  return findings;
}
