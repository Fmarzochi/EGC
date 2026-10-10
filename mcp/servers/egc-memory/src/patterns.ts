import crypto from 'node:crypto';

export interface RuntimeEvent {
  id: string;
  sessionId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  timestamp: string;
}

export interface DetectedPattern {
  type: 'repeated_command' | 'recurring_error';
  description: string;
  occurrences: number;
  suggestion: string;
  key: string;
  frequency: number;
  lastSeen: string;
  firstSeen: string;
  suggestedAutomation: string | null;
}

export interface PatternStoreEntry {
  id: string;
  patternType: string;
  key: string;
  description: string;
  occurrences: number;
  frequency: number;
  lastSeen: string;
  suggestedAutomation: string | null;
  firstSeen: string;
  windowDays: number;
}

function extractCommand(event: RuntimeEvent): string | null {
  const p = event.payload;
  if (!p || typeof p !== 'object') return null;

  if (event.eventType === 'PreToolUse') {
    const tool = p['tool'];
    if (typeof tool === 'string' && tool) return tool;
    const toolName = p['tool_name'];
    if (typeof toolName === 'string' && toolName) return toolName;
  }

  if (event.eventType === 'BashCommand' || event.eventType === 'command') {
    const cmd = p['command'];
    if (typeof cmd === 'string' && cmd) {
      return cmd.split(' ')[0].trim();
    }
  }

  const cmd = p['command'];
  if (typeof cmd === 'string' && cmd) {
    return cmd.split(' ')[0].trim();
  }

  return null;
}

const ERROR_EVENT_TYPES = new Set(['error', 'Error', 'ToolError']);

function errorCodeOf(p: Record<string, unknown>): unknown {
  return p['error_code'] ?? p['errorCode'] ?? p['code'];
}

function errorMessageOf(p: Record<string, unknown>): unknown {
  return p['error'] ?? p['message'] ?? p['errorMessage'];
}

// An error event by its type, or a PostToolUse that carries an error code
// or message.
function isErrorEvent(event: RuntimeEvent, p: Record<string, unknown>): boolean {
  if (ERROR_EVENT_TYPES.has(event.eventType)) return true;
  return event.eventType === 'PostToolUse'
    && (typeof errorCodeOf(p) === 'string' || typeof errorMessageOf(p) === 'string');
}

// A token is a path when it starts like one (absolute, home, relative or
// drive letter) or carries separators between name parts, a trailing :line
// or :line:column included; quotes and punctuation around it are ignored.
const PATH_START = /^(?:[A-Za-z]:)?[\\/]|^~[\\/]|^\.{1,2}[\\/]/;
const LEADING_PUNCTUATION = new Set(['\'', '"', '(']);
const TRAILING_PUNCTUATION = new Set([',', '.', ';', ':', ')', '\'', '"']);

// The token without the quotes and punctuation around it, walked from both
// ends so the cost stays linear in its length.
function bareToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start])) start += 1;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

function isPathToken(token: string): boolean {
  const bare = bareToken(token);
  if (PATH_START.test(bare)) return true;
  const separators = bare.split(/[\\/]/).length - 1;
  return separators >= 2 || (separators === 1 && /\.\w+(?::\d+)*$/.test(bare));
}

// The same error from two files is one pattern: every path in the message
// becomes <path> before the key is taken.
function normalizePaths(message: string): string {
  return message.replace(/\S+/g, token => (isPathToken(token) ? '<path>' : token));
}

// A TypeScript error code in the message, or its first six words, paths
// normalized.
function messageKey(message: string): string | null {
  const tsMatch = /TS\d+/.exec(message);
  if (tsMatch) return tsMatch[0];
  return normalizePaths(message).trim().split(/\s+/).slice(0, 6).join(' ') || null;
}

function extractErrorKey(event: RuntimeEvent): string | null {
  const p = event.payload;
  if (!p || typeof p !== 'object' || !isErrorEvent(event, p)) return null;

  const errorCode = errorCodeOf(p);
  if (typeof errorCode === 'string' && errorCode) return errorCode;

  const message = errorMessageOf(p);
  return typeof message === 'string' && message ? messageKey(message) : null;
}

function buildCommandSuggestion(cmd: string, count: number): string {
  const lower = cmd.toLowerCase();

  if (lower === 'npm' || lower === 'yarn' || lower === 'pnpm') {
    return `Consider adding a pre-session dependency check to avoid running ${cmd} manually each time`;
  }
  if (lower === 'git') {
    return `Consider automating the repeated git workflow with a script or alias`;
  }
  if (lower === 'make' || lower === 'rake' || lower === 'cargo') {
    return `Consider adding a build watcher or CI step to replace ${count} manual ${cmd} invocations`;
  }
  if (lower === 'docker' || lower === 'docker-compose' || lower === 'kubectl') {
    return `Consider scripting the repeated ${cmd} invocations into a startup helper`;
  }
  if (lower === 'edit' || lower === 'bash' || lower === 'read') {
    return `Tool "${cmd}" is used very frequently; verify it is not being called redundantly`;
  }

  return `Command "${cmd}" appears ${count} times; consider automating or scripting it`;
}

function buildErrorSuggestion(errorKey: string, _count: number): string {
  if (/^TS\d+/.test(errorKey)) {
    return `Review type definitions related to the recurring TypeScript error ${errorKey}`;
  }
  if (/permission|EACCES|EPERM/i.test(errorKey)) {
    return `Persistent permission errors may indicate a misconfigured environment or missing setup step`;
  }
  if (/not found|ENOENT|MODULE_NOT_FOUND/i.test(errorKey)) {
    return `Recurring not-found errors often point to a missing install step or wrong working directory`;
  }
  if (/timeout|ETIMEDOUT/i.test(errorKey)) {
    return `Recurring timeout errors may require increasing limits or fixing a slow dependency`;
  }

  return `Recurring error "${errorKey}" should be investigated; it may indicate a structural issue`;
}

interface CountBucket {
  count: number;
  timestamps: string[];
}

function buildCommandPattern(cmd: string, bucket: CountBucket, windowDays: number): DetectedPattern {
  const sorted = bucket.timestamps.slice().sort((a, b) => a.localeCompare(b));
  const firstSeen = sorted[0];
  const lastSeen = sorted.at(-1) ?? sorted[0];
  const frequency = windowDays > 0 ? bucket.count / windowDays : bucket.count;
  return {
    type: 'repeated_command',
    description: `Command "${cmd}" invoked ${bucket.count} times in ${windowDays} days`,
    occurrences: bucket.count,
    suggestion: buildCommandSuggestion(cmd, bucket.count),
    key: `command:${cmd}`,
    frequency,
    firstSeen,
    lastSeen,
    suggestedAutomation: null,
  };
}

function buildErrorPattern(errKey: string, bucket: CountBucket, windowDays: number): DetectedPattern {
  const sorted = bucket.timestamps.slice().sort((a, b) => a.localeCompare(b));
  const firstSeen = sorted[0];
  const lastSeen = sorted.at(-1) ?? sorted[0];
  const frequency = windowDays > 0 ? bucket.count / windowDays : bucket.count;
  return {
    type: 'recurring_error',
    description: `Error "${errKey}" occurred ${bucket.count} times in ${windowDays} days`,
    occurrences: bucket.count,
    suggestion: buildErrorSuggestion(errKey, bucket.count),
    key: `error:${errKey}`,
    frequency,
    firstSeen,
    lastSeen,
    suggestedAutomation: null,
  };
}

export function detectPatternsFromEvents(
  events: RuntimeEvent[],
  windowDays: number,
  minOccurrences: number
): DetectedPattern[] {
  const commandCounts = new Map<string, CountBucket>();
  const errorCounts = new Map<string, CountBucket>();

  for (const event of events) {
    const cmd = extractCommand(event);
    if (cmd) {
      const bucket = commandCounts.get(cmd) ?? { count: 0, timestamps: [] };
      bucket.count += 1;
      bucket.timestamps.push(event.timestamp);
      commandCounts.set(cmd, bucket);
    }

    const errKey = extractErrorKey(event);
    if (errKey) {
      const bucket = errorCounts.get(errKey) ?? { count: 0, timestamps: [] };
      bucket.count += 1;
      bucket.timestamps.push(event.timestamp);
      errorCounts.set(errKey, bucket);
    }
  }

  const patterns: DetectedPattern[] = [];

  for (const [cmd, bucket] of commandCounts.entries()) {
    if (bucket.count < minOccurrences) continue;
    patterns.push(buildCommandPattern(cmd, bucket, windowDays));
  }

  for (const [errKey, bucket] of errorCounts.entries()) {
    if (bucket.count < minOccurrences) continue;
    patterns.push(buildErrorPattern(errKey, bucket, windowDays));
  }

  patterns.sort((a, b) => b.occurrences - a.occurrences);
  return patterns;
}

export function patternToStoreEntry(
  p: DetectedPattern,
  windowDays: number
): PatternStoreEntry {
  const id = crypto.createHash('sha256').update(p.key).digest('hex').slice(0, 16);
  return {
    id,
    patternType: p.type,
    key: p.key,
    description: p.description,
    occurrences: p.occurrences,
    frequency: p.frequency,
    lastSeen: p.lastSeen,
    suggestedAutomation: p.suggestedAutomation,
    firstSeen: p.firstSeen,
    windowDays,
  };
}
