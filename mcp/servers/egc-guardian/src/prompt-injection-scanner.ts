// Heuristic prompt-injection detection for content the agent did not write
// itself (fetched web pages, third-party files, API responses, fork PR
// diffs). Regex-only by design: Guardian is a synchronous hook with no
// per-call LLM budget, so this mirrors the pattern-matching approach already
// shipped in mcp/servers/egc-memory/src/sanitize.ts rather than adding a
// semantic/LLM path to the hot validation flow.

export interface InjectionFinding {
  category: string;
  reason: string;
  snippet: string;
}

const MAX_SNIPPET_LEN = 80;

const PATTERNS: Array<{ category: string; pattern: RegExp; reason: string }> = [
  { category: 'instruction_override', pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|context|prompts?)/i, reason: 'attempt to override prior instructions' },
  { category: 'disregard_directive', pattern: /disregard\s+(all\s+|the\s+)?(system\s+)?(prompt|instructions?|rules?)/i, reason: 'attempt to discard system rules' },
  { category: 'disregard_directive', pattern: /forget\s+(everything|all)\s+(you\s+)?(were\s+told|know)/i, reason: 'attempt to reset prior context' },
  { category: 'fake_system_tag', pattern: /\[\s*SYSTEM\s*\]/i, reason: 'fake [SYSTEM] tag embedded in content' },
  { category: 'fake_system_tag', pattern: /<\s*system\s*>/i, reason: 'fake <system> tag embedded in content' },
  { category: 'fake_system_tag', pattern: /^\s*SYSTEM\s*:/im, reason: 'fake SYSTEM: line embedded in content' },
  { category: 'persona_hijack', pattern: /you\s+are\s+now\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|DAN)/i, reason: 'attempt to hijack assistant persona' },
  { category: 'new_instructions', pattern: /new\s+instructions?\s*:/i, reason: 'injected "new instructions" block' },
  { category: 'new_instructions', pattern: /^\s*#{1,3}\s*(new|updated)\s+(task|instructions?)/im, reason: 'injected heading claiming new task/instructions' },
  { category: 'exfiltration', pattern: /send\s+(this|the\s+above|it)\s+to\s+https?:\/\//i, reason: 'directive to exfiltrate content to a URL' },
  { category: 'exfiltration', pattern: /\bexfiltrate\b/i, reason: 'explicit exfiltration wording' },
  { category: 'exfiltration', pattern: /curl\s+https?:\/\/[^\s]+\s*\|\s*(ba)?sh/i, reason: 'remote shell execution payload' },
  { category: 'exfiltration', pattern: /wget\s+https?:\/\/[^\s]+\s*[|>]/i, reason: 'remote download payload' },
  { category: 'exfiltration', pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, reason: 'child_process injection' },
  { category: 'exfiltration', pattern: /exec(?:Sync)?\s*\(\s*[`'"]/, reason: 'exec/execSync injection' },
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

const ZERO_WIDTH_CHARS = '\u200B\u200C\u200D\uFEFF';
const ZERO_WIDTH_RE = new RegExp(`[${ZERO_WIDTH_CHARS}]`);
const ZERO_WIDTH_NEAR_KEYWORD_RE = new RegExp(
  `[${ZERO_WIDTH_CHARS}][\\s\\S]{0,40}(?:ignore|system|instructions?)|(?:ignore|system|instructions?)[\\s\\S]{0,40}[${ZERO_WIDTH_CHARS}]`,
  'i',
);

/** Collects every matching pattern; does not short-circuit on the first hit,
 * so a caller can see (and log) the full extent of a suspicious payload. */
export function scanForInjection(text: string): InjectionFinding[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const findings: InjectionFinding[] = [];
  for (const { category, pattern, reason } of PATTERNS) {
    const match = text.match(pattern);
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
