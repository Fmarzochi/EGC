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
// "$(curl -u ...)", sh -c 'curl -u ...'), redacted in one left-to-right pass
// over shell words read the way the shell reads them; a separator (;, |, &,
// newline) starts a new command, a substitution is redacted as a command
// line of its own, and a value is touched only after curl appeared in that
// command. -u is an ordinary flag for rsync, sudo and others, so those keep
// theirs.
const COMMAND_SEPARATORS = new Set([';', '|', '&', '\n']);
const BACKSLASH_ESCAPES = process.platform !== 'win32';

type ShellWord = { raw: string; value: string; code: string; end: number };

// A character that came from a quoted run, an escape or a substitution:
// literal text the outer command never treats as syntax.
const LITERAL = '\u0001';
const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const ANSI_DIGITS: Record<string, [RegExp, number]> = { x: [/^[0-9a-fA-F]{1,2}/, 16], u: [/^[0-9a-fA-F]{1,4}/, 16], U: [/^[0-9a-fA-F]{1,8}/, 16] };

// One ANSI-C escape starting at the backslash inside $'...': the named ones,
// octal (\NNN), hex (\xHH), unicode (\uHHHH, \UHHHHHHHH) and control (\cX).
function ansiEscape(text: string, at: number): { value: string; end: number } {
  const next = text[at + 1];
  const digits = ANSI_DIGITS[next];
  if (digits) {
    const run = digits[0].exec(text.slice(at + 2));
    if (run) return { value: String.fromCodePoint(Number.parseInt(run[0], digits[1])), end: at + 2 + run[0].length };
  }
  const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1));
  if (octal) return { value: String.fromCharCode(Number.parseInt(octal[0], 8)), end: at + 1 + octal[0].length };
  if (next === 'c' && text[at + 2] !== undefined) return { value: String.fromCharCode(text[at + 2].toUpperCase().charCodeAt(0) ^ 0x40), end: at + 3 };
  if (Object.hasOwn(ANSI_ESCAPES, next)) return { value: ANSI_ESCAPES[next], end: at + 2 };
  return { value: `\\${next}`, end: at + 2 };
}

function isQuoteOpener(text: string, at: number): boolean {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

function isSubstitutionOpener(text: string, at: number): boolean {
  return text[at] === '`' || ((text[at] === '$' || text[at] === '<' || text[at] === '>') && text[at + 1] === '(');
}

// The end (exclusive) of a $(...), <(...), >(...) or `...` substitution starting at `at`,
// balanced across nested substitutions and quotes; the text length when it
// never closes.
function substitutionEnd(text: string, at: number): number {
  if (text[at] === '`') {
    const close = text.indexOf('`', at + 1);
    return close === -1 ? text.length : close + 1;
  }
  let depth = 0;
  let quote: string | null = null;
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') {
      i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes keep their
// escapes for \ " $ and `, drop a backslash-newline and still run the
// substitutions inside them, $'...' decodes the ANSI-C escapes. `raw` is
// the run as it will be logged, with any substitution inside redacted.
function readQuoted(text: string, start: number): { value: string; raw: string; end: number } {
  const ansi = text[start] === '$';
  const quote = ansi ? text[start + 1] : text[start];
  const decodes = quote === '"' || ansi;
  let value = '';
  let raw = text.slice(start, start + (ansi ? 2 : 1));
  let i = start + (ansi ? 2 : 1);
  while (i < text.length && text[i] !== quote) {
    const next = text[i + 1];
    if (quote === '"' && isSubstitutionOpener(text, i)) {
      const end = substitutionEnd(text, i);
      const inner = text.slice(i, end);
      value += inner;
      raw += redactSubstitution(inner);
      i = end;
      continue;
    }
    if (text[i] === '\\' && decodes && next !== undefined) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (quote === "'") {
        const decoded = ansiEscape(text, i);
        value += decoded.value;
        raw += text.slice(i, decoded.end);
        i = decoded.end;
        continue;
      }
      if ('"\\$`'.includes(next)) {
        value += next;
        raw += text.slice(i, i + 2);
        i += 2;
        continue;
      }
    }
    value += text[i];
    raw += text[i];
    i += 1;
  }
  const end = Math.min(i + 1, text.length);
  raw += text.slice(i, end);
  return { value, raw, end };
}

// A substitution is a command line of its own: its inside is redacted on
// its own terms and the outer command never sees it as syntax.
function redactSubstitution(inner: string): string {
  if (inner.startsWith('`')) {
    const closed = inner.endsWith('`') && inner.length > 1;
    const body = closed ? inner.slice(1, -1) : inner.slice(1);
    return `\`${redactCurlBasicAuth(body)}${closed ? '`' : ''}`;
  }
  const closed = inner.endsWith(')');
  const body = inner.slice(2, closed ? -1 : undefined);
  return `${inner.slice(0, 2)}${redactCurlBasicAuth(body)}${closed ? ')' : ''}`;
}

// One shell word starting at `start`, read the way the shell reads it: a
// backslash-newline is a continuation, a backslash outside quotes escapes
// the next character (on Windows it is a path separator instead), a
// substitution is one literal unit. `raw` is the word as it will be logged,
// `value` the word the program receives, `code` the same word with every
// literal character masked so syntax is only looked for where the shell
// would see it.
function readShellWord(text: string, start: number): ShellWord {
  let value = '';
  let code = '';
  let raw = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (isSubstitutionOpener(text, i)) {
      const end = substitutionEnd(text, i);
      const inner = text.slice(i, end);
      value += inner;
      code += LITERAL.repeat(inner.length);
      raw += redactSubstitution(inner);
      i = end;
    } else if (isQuoteOpener(text, i)) {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      code += LITERAL.repeat(quoted.value.length);
      raw += quoted.raw;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      code += LITERAL;
      raw += text.slice(i, i + 2);
      i += 2;
    } else if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      break;
    } else {
      value += ch;
      code += ch;
      raw += ch;
      i += 1;
    }
  }
  return { raw, value, code, end: i };
}

// curl by basename, with or without a Windows executable suffix, also
// behind a group opener the shell would execute ({curl, (curl); a
// substitution is a unit of its own and never names the outer command.
function isCurlWord(word: ShellWord): boolean {
  const group = /^[({]+/.exec(word.code);
  const command = word.value.slice(group ? group[0].length : 0);
  return /^curl(?:\.exe|\.cmd|\.bat)?$/i.test(command.split(/[\\/]/).pop() ?? '');
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);

function isShellWord(word: ShellWord): boolean {
  return SHELL_NAMES.has((word.value.split(/[\\/]/).pop() ?? '').toLowerCase());
}

// A quoted word that a shell runs as a command line (the operand of sh -c,
// bash -lc and the like) is redacted inside its quotes.
function redactQuotedBody(raw: string): string {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) return raw;
  return `${quote}${redactCurlBasicAuth(raw.slice(1, -1))}${quote}`;
}

function redactCredentialWord(word: string): string {
  const colon = word.indexOf(':');
  if (colon === -1) return word;
  const quoteAt = word[0] === '$' ? 1 : 0;
  const quote = word[quoteAt] === '"' || word[quoteAt] === "'" ? word[quoteAt] : '';
  const closingQuote = quote && word.length > quoteAt + 1 && word.endsWith(quote) ? quote : '';
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

type CurlState = { sawCurl: boolean; sawShell: boolean; valueNext: boolean; bodyNext: boolean };

function freshCurlState(): CurlState {
  return { sawCurl: false, sawShell: false, valueNext: false, bodyNext: false };
}

// One word of a command, with the state of the command it belongs to.
function redactWord(word: ShellWord, state: CurlState): string {
  if (state.bodyNext) {
    state.bodyNext = false;
    return redactQuotedBody(word.raw);
  }
  if (state.valueNext) {
    state.valueNext = false;
    return redactCredentialWord(word.raw);
  }
  if (isShellWord(word)) {
    state.sawShell = true;
  } else if (state.sawShell && /^-[a-z]*c[a-z]*$/i.test(word.value)) {
    state.bodyNext = true;
  } else if (isCurlWord(word)) {
    state.sawCurl = true;
  } else if (state.sawCurl && (word.value === '-u' || word.value === '--user')) {
    state.valueNext = true;
  } else if (state.sawCurl) {
    const glued = gluedUserFlagLength(word.raw);
    if (glued) return `${word.raw.slice(0, glued)}${redactCredentialWord(word.raw.slice(glued))}`;
  }
  return word.raw;
}

function redactCurlBasicAuth(text: string): string {
  let out = '';
  let i = 0;
  let state = freshCurlState();
  while (i < text.length) {
    const ch = text[i];
    if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      if (COMMAND_SEPARATORS.has(ch)) state = freshCurlState();
      out += ch;
      i += 1;
      continue;
    }
    const word = readShellWord(text, i);
    i = word.end;
    out += redactWord(word, state);
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
