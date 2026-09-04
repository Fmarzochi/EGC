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

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(previous|all|prior)\s+instructions/i,       reason: 'prompt override attempt' },
  { pattern: /SYSTEM\s*:\s*(OVERRIDE|INSTRUCTION|PROMPT)/i,         reason: 'system prompt injection' },
  { pattern: /\[SYSTEM\]/i,                                          reason: 'system tag injection' },
  { pattern: /you\s+are\s+now\s+(a\s+)?(different|new|another)/i,   reason: 'persona override attempt' },
  { pattern: /new\s+instructions?\s*:/i,                             reason: 'instruction injection' },
  { pattern: /disregard\s+(all\s+)?(previous|prior)\s+/i,           reason: 'prompt override attempt' },
  // The propagation block is delimited by these markers; text carrying one
  // would break out of the block EGC manages and survive every later upsert.
  { pattern: /<!--\s*egc:(start|end)\s*-->/i,                         reason: 'EGC marker breakout attempt' },
];

// Patterns that indicate command injection payloads embedded in text
const COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /curl\s+https?:\/\/[^\s]+\s*\|\s*(ba)?sh/i,            reason: 'remote shell execution payload' },
  { pattern: /wget\s+https?:\/\/[^\s]+\s*[|>]/i,                    reason: 'remote download payload' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/,            reason: 'child_process injection' },
  { pattern: /execSync?\s*\(\s*[`'"]/,                               reason: 'execSync injection' },
  { pattern: /\beval\s*\(\s*[`'"]/,                                  reason: 'eval injection' },
  { pattern: /\bspawn\s*\(\s*[`'"]/,                                 reason: 'spawn injection' },
  { pattern: /process\.mainModule/,                                  reason: 'mainModule access attempt' },
  { pattern: /authorized_keys/i,                                     reason: 'SSH key manipulation payload' },
  { pattern: /\/etc\/passwd/i,                                       reason: 'sensitive file access payload' },
  { pattern: /\/etc\/shadow/i,                                       reason: 'shadow file access payload' },
];

const ALL_PATTERNS = [...INJECTION_PATTERNS, ...COMMAND_PATTERNS];

export function sanitize(input: string): SanitizeResult {
  if (typeof input !== 'string') return { value: input, flagged: false };

  for (const { pattern, reason } of ALL_PATTERNS) {
    if (pattern.test(input)) {
      return {
        value: '[BLOCKED: suspicious content detected]',
        flagged: true,
        reason,
      };
    }
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
// the offending field (decisions[2].why, next[0], ...) in each reason.
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

// Returns a copy of the fields with every flagged string replaced by the
// sanitizer's block marker, plus the reasons. Used on the merged state doc
// right before propagation: entries stored before the scan covered every
// field must not reach the instruction files either.
export function scrubStateFields(fields: StateTextFields): { fields: StateTextFields; reasons: string[] } {
  const reasons: string[] = [];
  const scrubbed = mapStateFields(fields, (label, value) => {
    const result = sanitize(value);
    if (result.flagged) reasons.push(`${label}: ${result.reason}`);
    return result.value;
  });
  return { fields: scrubbed, reasons };
}
