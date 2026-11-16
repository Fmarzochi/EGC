'use strict';

// The shapes of a credential that must not enter a memory document through
// egc import (#2138): the match names the shape, never the value. The memory
// server has the same idea in TypeScript (sanitize.ts) for what it writes;
// this is the CLI's own list, kept short and about shapes, not words.

// A credential assignment is one of these names, `=` or `:`, and a value of
// eight characters or more inside quotes or twelve or more bare: the contract
// the memory server applies to what it writes. The name list is joined at
// load, so adding a name is one line.
const CREDENTIAL_NAMES = ['password', 'passwd', 'secret', 'token', 'api[_-]?key', 'access[_-]?token', 'private[_-]?key', 'client[_-]?secret'];
const CREDENTIAL_ASSIGNMENT = new RegExp(`\\b(?:${CREDENTIAL_NAMES.join('|')})\\b\\s*[:=]\\s*`, 'gi');
const QUOTED_VALUE = /^"[^"\n]{8,}"|^'[^'\n]{8,}'/;
const BARE_VALUE = /^[^\s"']{12,}/;

function hasCredentialAssignment(text) {
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const value = text.slice(match.index + match[0].length);
    if (QUOTED_VALUE.test(value) || BARE_VALUE.test(value)) return true;
  }
  return false;
}

const SECRET_SHAPES = [
  { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Long-lived (AKIA) and temporary (ASIA) key ids alike.
  { name: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_\w{22,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'an API key of the sk- form', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'an authorization header value', pattern: /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/i },
  { name: 'a credential assignment', detect: hasCredentialAssignment },
];

/** The names of the credential shapes found in the text, in list order. */
function findSecretShapes(text) {
  return SECRET_SHAPES
    .filter(shape => (shape.detect ? shape.detect(text) : shape.pattern.test(text)))
    .map(shape => shape.name);
}

module.exports = { SECRET_SHAPES, CREDENTIAL_NAMES, findSecretShapes, hasCredentialAssignment };
