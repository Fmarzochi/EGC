import crypto from 'crypto';

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

function extractErrorKey(event: RuntimeEvent): string | null {
  const p = event.payload;
  if (!p || typeof p !== 'object') return null;

  const hasErrorSignal =
    typeof (p['error_code'] ?? p['errorCode'] ?? p['code']) === 'string' ||
    typeof (p['error'] ?? p['message'] ?? p['errorMessage']) === 'string';

  const isErrorEvent =
    event.eventType === 'error' ||
    event.eventType === 'Error' ||
    event.eventType === 'ToolError' ||
    (event.eventType === 'PostToolUse' && hasErrorSignal);

  if (!isErrorEvent) return null;

  const errorCode = p['error_code'] ?? p['errorCode'] ?? p['code'];
  if (typeof errorCode === 'string' && errorCode) return errorCode;

  const message = p['error'] ?? p['message'] ?? p['errorMessage'];
  if (typeof message === 'string' && message) {
    const tsMatch = message.match(/TS\d+/);
    if (tsMatch) return tsMatch[0];

    const words = message.trim().split(/\s+/).slice(0, 6).join(' ');
    return words || null;
  }

  return null;
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
