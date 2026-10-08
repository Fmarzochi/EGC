/**
 * Secret redaction for the egc-guardian audit log: key names, free text and
 * whole payloads. Shell command lines are read by audit-redact-shell.ts.
 */
import { REDACTED, redactCurlBasicAuth } from './audit-redact-shell.js';

// Keys whose values are always redacted, matched by the words the key is
// made of (token, apiToken, x-api-key, client_secret, sessionCookie, ...),
// not by an exact spelling. A key is split at case changes and at
// separators, and its words are read one by one and in adjacent pairs.
const REDACTED_KEY_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'authorization', 'auth', 'cookie',
  'apikey', 'privatekey', 'accesskey', 'secretkey', 'signingkey', 'sessionid', 'sessionkey',
  'session id', 'session key', 'private key', 'api key', 'access key', 'secret key', 'signing key',
]);

function keyWords(key: string): string[] {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(word => word !== '');
}

// The spellings a word is tried under: as written and, when it ends in s,
// without that s (tokens, secrets, apikeys, sessionids, api keys). Only a
// spelling that is a secret word counts, so `access` never turns into
// `acces`.
function spellings(word: string): string[] {
  return word.endsWith('s') && word.length > 2 ? [word, word.slice(0, -1)] : [word];
}

function isRedactedKey(key: string): boolean {
  const words = keyWords(key);
  return words.some((word, index) => spellings(word).some(spelling => (
    REDACTED_KEY_WORDS.has(spelling) || (index > 0 && REDACTED_KEY_WORDS.has(`${words[index - 1]} ${spelling}`))
  )));
}

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
  // A name whose part is pass or passphrase (DBPASS, DB_PASS, DBPASS2), not
  // a word that only ends that way (BYPASS, COMPASS), nor PASSPORT.
  /\b[\w-]*(?<!by|com|sur|tres|over|under|encom)pass(?:phrase)?\d*(?:[_-][\w-]*)?\s*=\s*/gi,
  // pwd after a name (MYSQL_PWD, DB_OLDPWD), never the shell's own PWD or
  // OLDPWD.
  /\b(?!(?:old)?pwd\s*=)[\w-]*pwd\d*(?:[_-][\w-]*)?\s*=\s*/gi,
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

// A PEM private key block anywhere in the text, header to footer (or to the
// end of the text when the footer is missing), found with a linear scan:
// each header is visited once, so a text full of headers costs one pass.
const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_FOOTER = /-----END [A-Z ]*PRIVATE KEY-----/g;

function redactPemBlocks(text: string): string {
  let out = '';
  let from = 0;
  PEM_HEADER.lastIndex = 0;
  let header = PEM_HEADER.exec(text);
  while (header) {
    out += text.slice(from, header.index) + REDACTED;
    PEM_FOOTER.lastIndex = header.index + header[0].length;
    const footer = PEM_FOOTER.exec(text);
    from = footer ? footer.index + footer[0].length : text.length;
    PEM_HEADER.lastIndex = from;
    header = from < text.length ? PEM_HEADER.exec(text) : null;
  }
  return out + text.slice(from);
}



// The end (exclusive) of a secret value starting at `start`: a quoted value
// runs to its closing quote, a bare one to the next blank or shell
// delimiter. After a space-separated option a bare run starting with '-'
// is the next flag, not a value; a value attached with '=' or ':' is taken
// as is.
const BARE_VALUE_END = /[\s"'&;]/;

function secretValueEnd(text: string, start: number, attached: boolean): number {
  const first = text[start];
  if (!attached && first === '-') return start;
  if (first === '"' || first === "'") {
    const close = text.indexOf(first, start + 1);
    return close < 0 ? text.length : close + 1;
  }
  const stop = text.slice(start).search(BARE_VALUE_END);
  return stop < 0 ? text.length : start + stop;
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
  out = redactPemBlocks(out);
  for (const prefix of SECRET_VALUE_PREFIXES) out = redactValuesAfter(out, prefix);

  try {
    out = redactCurlBasicAuth(out);
  } catch { // NOSONAR: a command the reader cannot parse is logged whole as redacted, never dropped
    return REDACTED;
  }

  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, keep?: string) => (typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED));
  return out;
}

// Pattern for values that look like secrets (long hex/base64 strings, JWTs).
// A value that is a secret by shape alone: a JWT, a long hex or base64
// run, a PEM block, or a vendor token, even under an innocent key. One
// short pattern per shape, each anchored to the whole value.
const SECRET_VALUE_SHAPES: RegExp[] = [
  /^ey[\w-]{20,}\.[\w-]{20,}\.[\w-]+$/,
  /^[A-Fa-f0-9]{32,}$/,
  // A base64 run that carries at least one digit or symbol: a long plain
  // word (an identifier, a slug) keeps its audit context.
  /^(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{40,}={0,2}$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,

  /^(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}$/,
  /^github_pat_\w{20,}$/,
  /^sk-[\w-]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/,
  /^glpat-[\w-]{20,}$/,
  /^AIza[\w-]{35}$/,
];

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_SHAPES.some(shape => shape.test(value));
}



/**
 * Returns a shallow copy of `payload` with secret-looking values replaced by
 * the string "[REDACTED]". Nested objects and arrays are walked recursively.
 */
function redactArrayItem(item: unknown): unknown {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    return redactPayload(item as Record<string, unknown>);
  }
  if (typeof item === 'string') {
    return isSecretValue(item) ? '[REDACTED]' : redactSecretsInText(item);
  }
  return item;
}

export function redactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (isRedactedKey(k)) {

      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = isSecretValue(v) ? '[REDACTED]' : redactSecretsInText(v);
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
