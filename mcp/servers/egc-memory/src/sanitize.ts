// Prompt injection and command injection detection for EGC state inputs.
// Applied to every free-text field of the write paths: update_state
// (context, decisions, avoid, preferences, next), working_memory_set and
// store_decision. What passes here is later written into the instruction
// files every AI tool loads as trusted context, so a miss is permanent.

export interface SanitizeResult {
  value: string;
  flagged: boolean;
  reason?: string;
}

// Patterns that indicate prompt injection attempts. The list matches the
// Guardian's content scanner (mcp/servers/egc-guardian/src/prompt-injection-
// scanner.ts) pattern for pattern: what the Guardian refuses in fetched
// content, the memory refuses in state, which every tool later loads as
// trusted instructions. Change the two together.
const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // The last gap also accepts a colon, comma or newline: a decision is stored
  // as `what: why`, and a directive split over that seam still reads whole.
  { pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)[\s:,;]+(instructions?|context|prompts?)/i, reason: 'prompt override attempt' },

  { pattern: /disregard\s+(all\s+|the\s+)?(system[\s:,;]+)?(prompt|instructions?|rules?)/i, reason: 'prompt override attempt' },

  { pattern: /disregard\s+(all\s+)?(previous|prior)\s+/i,           reason: 'prompt override attempt' },
  { pattern: /forget\s+(everything|all)\s+(you\s+)?(were\s+told|know)/i, reason: 'context reset attempt' },
  { pattern: /SYSTEM\s*:\s*(OVERRIDE|INSTRUCTION|PROMPT)/i,         reason: 'system prompt injection' },
  { pattern: /^\s{0,20}SYSTEM\s*:/im,                               reason: 'system prompt injection' },
  { pattern: /\[\s*SYSTEM\s*\]/i,                                    reason: 'system tag injection' },
  { pattern: /<\s*system\s*>/i,                                      reason: 'system tag injection' },
  { pattern: /you\s+are\s+now\s+(a\s+|an\s+)?(different|new|another|unrestricted|jailbroken|DAN)/i, reason: 'persona override attempt' },
  { pattern: /new\s+instructions?\s*:/i,                             reason: 'instruction injection' },
  { pattern: /^\s{0,20}#{1,3}\s{0,20}(new|updated)\s+(task|instructions?)/im, reason: 'instruction injection' },
  { pattern: /send\s+(this|the\s+above|it)\s+to\s+https?:\/\//i,   reason: 'exfiltration directive' },
  { pattern: /\bexfiltrate\b/i,                                      reason: 'exfiltration directive' },
  { pattern: /<\|im_start\|>/i,                                      reason: 'chat template spoofing' },
  { pattern: /<\/?(function_results|tool_use|tool_result)>/i,        reason: 'tool boundary spoofing' },
  // {0,200} is a deliberate bound: an unbounded run over long text is the
  // classic catastrophic-backtracking shape.
  { pattern: /<!--\s*(ignore|system|instructions?)[\s\S]{0,200}-->/i, reason: 'hidden comment directive' },
  // The propagation block is delimited by these markers; text carrying one
  // would break out of the block EGC manages and survive every later upsert.
  { pattern: /<!--\s*egc:(start|end)\s*-->/i,                         reason: 'EGC marker breakout attempt' },
];

// Patterns that indicate command injection payloads embedded in text
const COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /curl\s+https?:\/\/[^\s]+\s*\|\s*(ba)?sh/i,            reason: 'remote shell execution payload' },
  { pattern: /wget\s+https?:\/\/[^\s]+\s*[|>]/i,                    reason: 'remote download payload' },
  { pattern: /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/,  reason: 'child_process injection' },
  { pattern: /import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/, reason: 'child_process injection' },
  { pattern: /\bchild_process\s*\.\s*exec(?:Sync)?\s*\(/,           reason: 'child_process injection' },
  { pattern: /execSync?\s*\(\s*[`'"]/,                               reason: 'execSync injection' },
  { pattern: /\beval\s*\(\s*[`'"]/,                                  reason: 'eval injection' },
  { pattern: /\bspawn\s*\(\s*[`'"]/,                                 reason: 'spawn injection' },
  { pattern: /process\.mainModule/,                                  reason: 'mainModule access attempt' },
  { pattern: /authorized_keys/i,                                     reason: 'SSH key manipulation payload' },
  { pattern: /\/etc\/passwd/i,                                       reason: 'sensitive file access payload' },
  { pattern: /\/etc\/shadow/i,                                       reason: 'shadow file access payload' },
];

// Four distinct zero-width code points (ZWSP, ZWNJ, ZWJ, BOM): invisible
// characters clustered near an injection keyword hide a directive from a
// reader while the model still sees it.
const ZERO_WIDTH_CHARS = '\u200B\u200C\u200D\uFEFF';
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_RE = new RegExp(`[${ZERO_WIDTH_CHARS}]`);
const ZERO_WIDTH_NEAR_KEYWORD_RE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class
  String.raw`[${ZERO_WIDTH_CHARS}][\s\S]{0,40}(?:ignore|system|instructions?)|(?:ignore|system|instructions?)[\s\S]{0,40}[${ZERO_WIDTH_CHARS}]`,
  'i',
);

const ALL_PATTERNS = [...INJECTION_PATTERNS, ...COMMAND_PATTERNS];

// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_ALL_RE = new RegExp(`[${ZERO_WIDTH_CHARS}]`, 'g');

// The reason a text is refused, or null when it is clean. The patterns run
// over the text with its zero-width characters removed, so a keyword split
// by invisible characters is read the way the model reads it.
function injectionReason(input: string): string | null {
  const visible = input.replace(ZERO_WIDTH_ALL_RE, '');
  for (const { pattern, reason } of ALL_PATTERNS) {
    if (pattern.test(visible)) return reason;
  }
  if (ZERO_WIDTH_RE.test(input) && ZERO_WIDTH_NEAR_KEYWORD_RE.test(input)) return 'invisible characters near injection keyword';
  return null;
}


export function sanitize(input: string): SanitizeResult {
  if (typeof input !== 'string') return { value: input, flagged: false };
  const reason = injectionReason(input);
  if (reason !== null) {
    return {
      value: '[BLOCKED: suspicious content detected]',
      flagged: true,
      reason,
    };
  }
  return { value: input, flagged: false };
}

export function sanitizeStrings(fields: Record<string, string | undefined>): {
  sanitized: Record<string, string>;
  flagged: boolean;
  reasons: string[];
} {
  const sanitized: Record<string, string> = {};
  const reasons: string[] = [];
  let flagged = false;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const result = sanitize(value);
    sanitized[key] = result.value;
    if (result.flagged) {
      flagged = true;
      reasons.push(`${key}: ${result.reason}`);
    }
  }

  return { sanitized, flagged, reasons };
}

export interface StateTextFields {
  context?: string;
  decisions?: Array<{ what: string; why?: string }>;
  avoid?: Array<{ what: string; why?: string }>;
  preferences?: string[];
  next?: string[];
}

// Runs sanitize() over every free-text field update_state accepts and names
// the offending field (decisions[2].why, next[0], ...) in each reason. The
// fields are also read the way the instruction files will present them,
// one after another: a directive split across adjacent fields ("ignore
// previous" in one, "instructions" in the next) is refused as a whole.
export function sanitizeStateFields(fields: StateTextFields): { flagged: boolean; reasons: string[] } {
  const { reasons } = scrubStateFields(fields);
  return { flagged: reasons.length > 0, reasons };
}

type StateEntry = { what: string; why?: string };
type TextVisitor = (label: string, value: string) => string;

function mapEntries(name: string, entries: StateEntry[] | undefined, visit: TextVisitor): StateEntry[] | undefined {
  return entries?.map((entry, i) => ({
    what: visit(`${name}[${i}].what`, entry.what),
    ...(entry.why === undefined ? {} : { why: visit(`${name}[${i}].why`, entry.why) }),
  }));
}

// One walk over every free-text field, shared by the scan and the scrub so
// the two cannot drift when a field is added or renamed.
function mapStateFields(fields: StateTextFields, visit: TextVisitor): StateTextFields {
  const out: StateTextFields = {};
  if (fields.context !== undefined) out.context = visit('context', fields.context);
  const decisions = mapEntries('decisions', fields.decisions, visit);
  if (decisions) out.decisions = decisions;
  const avoid = mapEntries('avoid', fields.avoid, visit);
  if (avoid) out.avoid = avoid;
  if (fields.preferences) out.preferences = fields.preferences.map((v, i) => visit(`preferences[${i}]`, v));
  if (fields.next) out.next = fields.next.map((v, i) => visit(`next[${i}]`, v));
  return out;
}

// The fields the instruction files present, in their order and spelling:
// the context, each decision as the state file stores it (`what: why` on
// one line, which the propagation then reads back whole), and the next
// steps. A directive assembled across those boundaries is seen whole; an
// `avoid` entry or a preference never reaches the files, so it is not part
// of the document.
function presentedDocument(fields: StateTextFields): string {
  const lines: string[] = [];
  if (fields.context !== undefined) lines.push(fields.context);
  for (const decision of fields.decisions ?? []) lines.push(decision.why === undefined ? decision.what : `${decision.what}: ${decision.why}`);
  for (const step of fields.next ?? []) lines.push(step);
  return lines.join('\n');
}


// Returns a copy of the fields with every flagged string replaced by the
// sanitizer's block marker, plus the reasons. Used on the merged state doc
// right before propagation: entries stored before the scan covered every
// field must not reach the instruction files either. When the presented
// fields only read as an injection together, those fields are withheld:
// the instruction files would otherwise reassemble the directive.
export function scrubStateFields(fields: StateTextFields): { fields: StateTextFields; reasons: string[] } {
  const reasons: string[] = [];
  const scrubbed = mapStateFields(fields, (label, value) => {
    const result = sanitize(value);
    if (result.flagged) reasons.push(`${label}: ${result.reason}`);
    return result.value;
  });
  if (reasons.length === 0) {
    const assembled = injectionReason(presentedDocument(fields));
    if (assembled !== null) {
      reasons.push(`fields together: ${assembled}`);
      const withheld = { ...scrubbed };
      if (withheld.context !== undefined) withheld.context = '[BLOCKED: suspicious content detected]';
      if (withheld.decisions) withheld.decisions = withheld.decisions.map(decision => ({ what: '[BLOCKED: suspicious content detected]', ...(decision.why === undefined ? {} : { why: '[BLOCKED: suspicious content detected]' }) }));

      if (withheld.next) withheld.next = withheld.next.map(() => '[BLOCKED: suspicious content detected]');
      return { fields: withheld, reasons };
    }
  }
  return { fields: scrubbed, reasons };
}

