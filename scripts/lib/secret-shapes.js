'use strict';

// The shapes of a credential that must not enter a memory document through
// egc import (#2138): the match names the shape, never the value. The memory
// server has the same idea in TypeScript (sanitize.ts) for what it writes;
// this is the CLI's own list, kept short and about shapes, not words.

const SECRET_SHAPES = [
  { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_\w{22,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'an API key of the sk- form', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'an authorization header value', pattern: /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/i },
  // The value is anything of eight characters or more without a blank; a
  // quoted value counts its quotes, which only makes the shape match sooner.
  { name: 'a credential assignment', pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*\S{8,}/i },
];

/** The names of the credential shapes found in the text, in list order. */
function findSecretShapes(text) {
  return SECRET_SHAPES.filter(shape => shape.pattern.test(text)).map(shape => shape.name);
}

module.exports = { SECRET_SHAPES, findSecretShapes };
