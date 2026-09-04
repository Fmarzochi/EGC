/**
 * Security audit log for egc-guardian.
 *
 * Writes append-only NDJSON entries to ~/.egc/audit.log for every
 * blocked/denied call. Rotates at MAX_SIZE_BYTES. Redacts values that
 * look like secrets before persisting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUDIT_LOG_DIR = path.join(os.homedir(), '.egc');
export const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'audit.log');
export const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Keys whose values are always redacted regardless of content.
const REDACTED_KEYS = new Set([
  'token', 'secret', 'password', 'api_key', 'apikey',
  'authorization', 'auth', 'credential', 'private_key', 'privatekey',
]);

// Secrets embedded inside free text such as a shell command. Each prefix
// pattern stops exactly where the secret value starts; the value itself
// (quoted, or a bare run up to whitespace) is consumed in code, which keeps
// every pattern short. scripts/hooks/post-bash-command-log.js carries the
// same list for the Bash command log: change both together.
const SECRET_VALUE_PREFIXES: RegExp[] = [
  /authorization\s*:\s*(?:bearer|basic|token)\s+/gi,
  /(?:x-)?(?:api|secret|access|private|auth)[-_]?(?:key|secret|token)\s*:\s*/gi,
  // basic auth: --user=name:password anywhere; -u name:password only inside
  // a curl invocation, since -u is an ordinary flag for rsync, sudo and others
  /--user(?:=|\s+)["']?[^\s:"']+:/gi,
  /\bcurl\b[^;&|\n]*?\s-u(?:=|\s*)["']?[^\s:"']+:/gi,
  /--?(?:token|password|passwd|secret|auth|credentials?)(?:=|\s+)/gi,
  /--?(?:api|access|private)[-_]?(?:key|secret)(?:=|\s+)/gi,
  /\b[\w-]*(?:token|password|passwd|secret|apikey)[\w-]*\s*=\s*/gi,
  /\b[\w-]*(?:api|access|private)[-_]?key[\w-]*\s*=\s*/gi,
  /\b(?:auth|authorization|credentials?)\s*=\s*/gi,
];
const SECRET_SHAPES: RegExp[] = [
  /(:\/\/[^\s/:@]+:)[^\s@]+(?=@)/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bsk-[\w-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bglpat-[\w-]{20,}\b/g,
  /\bAIza[\w-]{35}\b/g,
  /\bey[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];
const REDACTED = '[REDACTED]';

function secretValueEnd(text: string, start: number, attached: boolean): number {
  const quote = text[start];
  // After a space-separated option a bare run that starts with '-' is the
  // next flag, not a value; a value attached with '=' or ':' is taken as is.
  if (!attached && quote === '-') return start;
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, start + 1);
    return close === -1 ? text.length : close + 1;
  }
  let end = start;
  while (end < text.length && !/[\s"'&;]/.test(text[end])) end += 1;
  return end;
}

function redactValuesAfter(text: string, prefixPattern: RegExp): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(prefixPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    if (start < last) continue;
    const end = secretValueEnd(text, start, /[=:]$/.test(match[0]));
    if (end === start) continue;
    out += `${text.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return out + text.slice(last);
}

/**
 * Replaces secret-looking runs inside free text (a shell command, a URL, a
 * header) with "[REDACTED]", keeping the surrounding text so the audit
 * entry still says what happened.
 */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const prefix of SECRET_VALUE_PREFIXES) out = redactValuesAfter(out, prefix);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, keep?: string) => (typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED));
  return out;
}

// Pattern for values that look like secrets (long hex/base64 strings, JWTs).
const SECRET_VALUE_RE = /^(ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})$/;

/**
 * Returns a shallow copy of `payload` with secret-looking values replaced by
 * the string "[REDACTED]". Nested objects and arrays are walked recursively.
 */
function redactArrayItem(item: unknown): unknown {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    return redactPayload(item as Record<string, unknown>);
  }
  if (typeof item === 'string') {
    return SECRET_VALUE_RE.test(item) ? '[REDACTED]' : redactSecretsInText(item);
  }
  return item;
}

export function redactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const lk = k.toLowerCase();
    if (REDACTED_KEYS.has(lk)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = SECRET_VALUE_RE.test(v) ? '[REDACTED]' : redactSecretsInText(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map(redactArrayItem);
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactPayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Append one NDJSON audit entry to ~/.egc/audit.log.
 *
 * @param action   Short identifier, e.g. "COMMAND_EXECUTION"
 * @param status   "DENIED" | "BLOCKED" | "RATE_LIMITED" | ...
 * @param details  Tool / filepath / reason / ... (will be redacted)
 */
export function writeAuditEntry(
  action: string,
  status: string,
  details: Record<string, unknown> = {},
  logDir: string = AUDIT_LOG_DIR,
  logPath: string = AUDIT_LOG_PATH,
  maxSizeBytes: number = MAX_SIZE_BYTES,
): void {
  let entry: string;
  try {
    entry =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        action,
        status,
        ...redactPayload(details),
      }) + '\n';
  } catch {
    // best-effort: non-serializable payload should not crash the guardian
    return;
  }

  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }

  try { fs.chmodSync(logDir, 0o700); } catch { /* non-critical */ }

  // Rotate if needed
  try {
    const stats = fs.statSync(logPath);
    if (stats.size >= maxSizeBytes) {
      fs.renameSync(logPath, `${logPath}.${Date.now()}.bak`);
    }
  } catch { /* file may not exist yet */ }

  try {
    fs.appendFileSync(logPath, entry, { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
  } catch {
    // best-effort: never let a log write crash the guardian
  }
}
