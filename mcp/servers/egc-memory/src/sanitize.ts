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
  const reasons: string[] = [];
  const check = (label: string, value: string | undefined) => {
    if (value === undefined) return;
    const result = sanitize(value);
    if (result.flagged) reasons.push(`${label}: ${result.reason}`);
  };
  check('context', fields.context);
  fields.decisions?.forEach((d, i) => { check(`decisions[${i}].what`, d.what); check(`decisions[${i}].why`, d.why); });
  fields.avoid?.forEach((d, i) => { check(`avoid[${i}].what`, d.what); check(`avoid[${i}].why`, d.why); });
  fields.preferences?.forEach((p, i) => check(`preferences[${i}]`, p));
  fields.next?.forEach((n, i) => check(`next[${i}]`, n));
  return { flagged: reasons.length > 0, reasons };
}
