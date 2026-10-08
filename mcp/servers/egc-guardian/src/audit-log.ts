/**
 * Security audit log for egc-guardian.
 *
 * Writes append-only NDJSON entries to ~/.egc/audit.log for every
 * blocked/denied call. Rotates at MAX_SIZE_BYTES. Redacts values that
 * look like secrets before persisting (see audit-redact.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactPayload } from './audit-redact.js';

export { redactPayload, redactSecretsInText } from './audit-redact.js';

export const AUDIT_LOG_DIR = path.join(os.homedir(), '.egc');
export const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'audit.log');
export const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

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
