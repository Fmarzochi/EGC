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

// Secrets embedded inside free text such as a shell command. A value is a
// quoted run or a bare run of non-space characters; each pattern is
// anchored on a literal and short enough to read on its own.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'&;]+)`;
const IN_TEXT_SECRET_PATTERNS: RegExp[] = [
  // Authorization: Bearer|Basic|Token <value>
  new RegExp(String.raw`(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"']+`, 'gi'),
  // X-API-Key: <value>, Private-Token: <value>, X-Auth-Token: <value>, ...
  new RegExp(String.raw`((?:x-)?(?:api[-_]?key|api[-_]?secret|auth[-_]?token|access[-_]?token|secret[-_]?key|private[-_]?token)\s*:\s*)[^\s"']+`, 'gi'),
  // curl -u user:password, --user=user:password: the user stays, the password goes
  new RegExp(String.raw`(--?u(?:ser)?(?:=|\s+)["']?[^\s:"']+:)[^\s"']+`, 'gi'),
  // --token <value>, --password=<value>, -p<value> style flags
  new RegExp(String.raw`(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth|credentials?)(?:=|\s+))` + VALUE, 'gi'),
  // KEY=value assignments whose name says it holds a secret
  new RegExp(String.raw`\b((?:[a-z_]*(?:token|password|passwd|secret|api[-_]?key|apikey|private[-_]?key|access[-_]?key)[a-z_]*|auth|authorization|credentials?)\s*=\s*)` + VALUE, 'gi'),
  // scheme://user:password@host
  /(:\/\/[^\s/:@]+:)[^\s@]+(?=@)/g,
  // well-known token prefixes
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bsk-[\w-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bglpat-[\w-]{20,}\b/g,
  /\bAIza[\w-]{35}\b/g,
  // JWT
  /\bey[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];

/**
 * Replaces secret-looking runs inside free text (a shell command, a URL, a
 * header) with "[REDACTED]", keeping the surrounding text so the audit
 * entry still says what happened.
 */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const pattern of IN_TEXT_SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
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
