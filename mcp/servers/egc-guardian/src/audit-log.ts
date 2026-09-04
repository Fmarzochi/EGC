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

// curl's -u name:password in any spelling (-u name:pw, -uname:pw, -u=name:pw,
// --user name:pw, --user=name:pw, -u ":pw", -u 'a b:c', $(curl -u ...),
// sh -c 'curl -u ...'), redacted in one left-to-right pass over shell words
// read the way the shell reads them; a separator (;, |, &, newline) starts a
// new command, and a value is touched only after curl appeared in that
// command. -u is an ordinary flag for rsync, sudo and others, so those keep
// theirs.
const COMMAND_SEPARATORS = new Set([';', '|', '&', '\n']);
const BACKSLASH_ESCAPES = process.platform !== 'win32';

type ShellWord = { raw: string; value: string; end: number };

// The body of a quoted run starting at its opening quote: single quotes are
// literal, double quotes keep their escapes for \ " $ and `.
function readQuoted(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (quote === '"' && text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) i += 1;
    value += text[i];
    i += 1;
  }
  return { value, end: Math.min(i + 1, text.length) };
}

// One shell word starting at `start`, read the way the shell reads it; a
// backslash outside quotes escapes the next character (on Windows it is a
// path separator instead). `raw` is the text as typed, `value` the word the
// program receives.
function readShellWord(text: string, start: number): ShellWord {
  let value = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
    } else if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      break;
    } else {
      value += ch;
      i += 1;
    }
  }
  return { raw: text.slice(start, i), value, end: i };
}

// curl by basename, with or without a Windows executable suffix, also when
// the word opens a substitution anywhere in it (`$(curl`, `pre$(curl`,
// `x=$(curl`, `<(curl`, `\`curl`) or a group ({curl).
function isCurlWord(value: string): boolean {
  const command = value.replace(/^.*(?:\$\(|<\(|>\(|`)/, '').replace(/^[({]+/, '');
  return /^curl(?:\.exe|\.cmd|\.bat)?$/i.test(command.split(/[\\/]/).pop() ?? '');
}

// A quoted word that holds a whole command line (sh -c '...') is redacted
// inside its quotes.
function redactQuotedBody(raw: string): string | null {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) return null;
  const body = raw.slice(1, -1);
  return /\s/.test(body) ? `${quote}${redactCurlBasicAuth(body)}${quote}` : null;
}

function redactCredentialWord(word: string): string {
  const colon = word.indexOf(':');
  if (colon === -1) return word;
  const quote = word[0] === '"' || word[0] === "'" ? word[0] : '';
  const closingQuote = quote && word.length > 1 && word.endsWith(quote) ? quote : '';
  const tail = closingQuote || (/[)`]+$/.exec(word) ?? [''])[0];
  return `${word.slice(0, colon + 1)}${REDACTED}${tail}`;
}

// The length of the flag glued in front of a credential (-u, -u=, --user=),
// or 0 when the word is not such a flag.
function gluedUserFlagLength(word: string): number {
  if (word.startsWith('--user=')) return '--user='.length;
  if (word.startsWith('-u=')) return 3;
  if (word.startsWith('-u') && word.length > 2) return 2;
  return 0;
}

function redactCurlBasicAuth(text: string): string {
  let out = '';
  let i = 0;
  let sawCurl = false;
  let valueNext = false;
  while (i < text.length) {
    const ch = text[i];
    if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      if (COMMAND_SEPARATORS.has(ch)) {
        sawCurl = false;
        valueNext = false;
      }
      out += ch;
      i += 1;
      continue;
    }
    const word = readShellWord(text, i);
    i = word.end;
    const nested = valueNext ? null : redactQuotedBody(word.raw);
    if (nested !== null) {
      out += nested;
    } else if (valueNext) {
      valueNext = false;
      out += redactCredentialWord(word.raw);
    } else if (isCurlWord(word.value)) {
      sawCurl = true;
      out += word.raw;
    } else if (!sawCurl) {
      out += word.raw;
    } else if (word.value === '-u' || word.value === '--user') {
      valueNext = true;
      out += word.raw;
    } else {
      const glued = gluedUserFlagLength(word.raw);
      out += glued ? `${word.raw.slice(0, glued)}${redactCredentialWord(word.raw.slice(glued))}` : word.raw;
    }
  }
  return out;
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
  out = redactCurlBasicAuth(out);
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
