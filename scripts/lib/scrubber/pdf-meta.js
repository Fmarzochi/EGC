'use strict';

// Scrubber PDF metadata: redact the Document Information Dictionary metadata
// (Title, Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate)
// by blanking each value in place with same-length spaces. Same-length editing
// keeps every byte offset intact, so the cross-reference table stays valid and
// the PDF can never be corrupted or truncated by a clean.
//
// Honest about being partial: metadata carried inside compressed object streams
// (/ObjStm) or a compressed XMP packet is not reachable without decompressing
// and rebuilding the xref, which is out of scope here. Encrypted PDFs are left
// untouched. The result always reports `partial: true` so a caller never treats
// a PDF clean as exhaustive.

const PDF_META_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];

const SPACE = 0x20;
const BACKSLASH = 0x5c;
const LPAREN = 0x28;
const RPAREN = 0x29;
const LANGLE = 0x3c;
const RANGLE = 0x3e;

function detectPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-';
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

// Blank a PDF literal string `( ... )` starting at `open`. Returns the offset
// just past the closing paren, or -1 if the string is unterminated.
function blankLiteralString(bytes, open) {
  let depth = 1;
  let i = open + 1;
  while (i < bytes.length && depth > 0) {
    const byte = bytes[i];
    if (byte === BACKSLASH) { i += 2; continue; } // skip the escaped byte
    if (byte === LPAREN) depth += 1;
    else if (byte === RPAREN) { depth -= 1; if (depth === 0) break; }
    i += 1;
  }
  if (i >= bytes.length || bytes[i] !== RPAREN) return -1;
  bytes.fill(SPACE, open + 1, i);
  return i + 1;
}

// Blank a PDF hex string `< ... >` starting at `open`. Returns the offset just
// past the closing angle, or -1 if unterminated.
function blankHexString(bytes, open) {
  let i = open + 1;
  while (i < bytes.length && bytes[i] !== RANGLE) i += 1;
  if (i >= bytes.length) return -1;
  bytes.fill(SPACE, open + 1, i);
  return i + 1;
}

// From `after` (just past a key name), skip whitespace and blank the string
// value if one follows. Returns true if a value was blanked.
function blankValueAfter(bytes, after) {
  let i = after;
  while (i < bytes.length && isWhitespace(bytes[i])) i += 1;
  if (i >= bytes.length) return false;
  if (bytes[i] === LPAREN) return blankLiteralString(bytes, i) > 0;
  // A single `<` opens a hex string; `<<` opens a dictionary and is not a value.
  if (bytes[i] === LANGLE && bytes[i + 1] !== LANGLE) return blankHexString(bytes, i) > 0;
  return false;
}

function cleanPdf(buf) {
  if (!detectPdf(buf)) return { cleaned: buf, removed: [], partial: true, encrypted: false };
  // An encrypted PDF stores its strings as ciphertext; blanking them would not
  // reliably erase the plaintext and could confuse a reader. Leave it untouched.
  if (buf.includes('/Encrypt')) {
    return { cleaned: buf, removed: [], partial: true, encrypted: true };
  }

  const bytes = Buffer.from(buf); // never mutate the caller's buffer
  const removed = [];
  for (const key of PDF_META_KEYS) {
    const token = Buffer.from(`/${key}`, 'latin1');
    let from = 0;
    let blankedThisKey = false;
    for (;;) {
      const at = bytes.indexOf(token, from);
      if (at < 0) break;
      const after = at + token.length;
      // The next byte must delimit the key name (whitespace or a value opener),
      // so `/Creator` never matches inside `/CreatorTool`.
      const next = bytes[after];
      if (next === undefined || isWhitespace(next) || next === LPAREN || next === LANGLE) {
        if (blankValueAfter(bytes, after)) blankedThisKey = true;
      }
      from = after;
    }
    if (blankedThisKey) removed.push(`pdf:${key}`);
  }

  return { cleaned: removed.length > 0 ? bytes : buf, removed, partial: true, encrypted: false };
}

function inspectPdf(buf) {
  const { removed, partial, encrypted } = cleanPdf(buf);
  return { format: 'pdf', partial, encrypted, findings: removed, suspicious: removed.length > 0 };
}

module.exports = {
  detectPdf,
  cleanPdf,
  inspectPdf,
  PDF_META_KEYS,
};
