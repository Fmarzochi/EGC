'use strict';

// Refuse to treat binary containers as text. Cleaning a PNG or a zip as if it
// were text would walk its compressed bytes and write mangled bytes back,
// destroying the file. The Scrubber only ever touches content it is confident
// is text; everything else passes through untouched.

// Leading magic numbers for common binary formats, as latin1 byte strings.
const BINARY_MAGIC = [
  ['PK\x03\x04', 'a zip container (docx, odt, xlsx, pptx, epub, jar)'],
  ['PK\x05\x06', 'an empty zip container'],
  ['PK\x07\x08', 'a spanned zip container'],
  ['%PDF-', 'a pdf'],
  ['\x89PNG\r\n\x1a\n', 'a png image'],
  ['\xff\xd8\xff', 'a jpeg image'],
  ['GIF87a', 'a gif image'],
  ['GIF89a', 'a gif image'],
  ['BM', 'a bmp image'],
  ['II*\x00', 'a tiff image'],
  ['MM\x00*', 'a tiff image'],
  ['RIFF', 'a riff container (webp, wav, avi)'],
  ['OggS', 'an ogg media file'],
  ['\x1f\x8b', 'a gzip archive'],
  ['BZh', 'a bzip2 archive'],
  ['\xfd7zXZ\x00', 'an xz archive'],
  ['7z\xbc\xaf\x27\x1c', 'a 7-zip archive'],
  ['Rar!\x1a\x07', 'a rar archive'],
  ['\x7fELF', 'an elf binary'],
  ['\xca\xfe\xba\xbe', 'a java class or mach-o fat binary'],
  ['\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'a legacy office document'],
  ['SQLite format 3\x00', 'a sqlite database'],
];

const SNIFF_BYTES = 8192;
const CONTROL_RATIO_LIMIT = 0.05;
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);

const REPLACEMENT_CHAR = 0xfffd;
const NUL_CHAR = String.fromCodePoint(0);

// Precise path: magic-byte and control-byte checks on the real bytes.
function looksBinaryBuffer(buf) {
  if (buf.length === 0) return null;
  const head = buf.subarray(0, SNIFF_BYTES);
  const headLatin1 = head.toString('latin1');
  for (const [magic, label] of BINARY_MAGIC) {
    if (headLatin1.startsWith(magic)) return label;
  }
  let controls = 0;
  for (const byte of head) {
    if (byte === 0x00) return 'binary data (contains NUL bytes)';
    if (byte < 0x20 && !ALLOWED_CONTROLS.has(byte)) controls += 1;
  }
  if (controls / head.length > CONTROL_RATIO_LIMIT) {
    return 'binary data (dense in control bytes)';
  }
  return null;
}

// String path: a string that came from decoding binary keeps its NUL and
// U+FFFD replacement characters even though re-encoding to UTF-8 would not
// recover the original magic bytes. Check those directly, so a binary payload
// that reached us already decoded is still refused.
function looksBinaryString(text) {
  if (text.length === 0) return null;
  const sample = text.slice(0, SNIFF_BYTES);
  if (sample.includes(NUL_CHAR)) return 'binary data (contains NUL bytes)';
  let suspicious = 0;
  let count = 0;
  for (const ch of sample) {
    count += 1;
    const cp = ch.codePointAt(0);
    if (cp === REPLACEMENT_CHAR || (cp < 0x20 && !ALLOWED_CONTROLS.has(cp))) suspicious += 1;
  }
  if (count > 0 && suspicious / count > CONTROL_RATIO_LIMIT) {
    return 'binary data (dense in control or replacement characters)';
  }
  return null;
}

// Accepts a Buffer or a string. Returns a human description of why the data is
// not plausibly text, or null when it looks like text. Pass a Buffer for a
// precise magic-byte check; a string is checked for NUL / replacement / control
// characters, which survive decoding. Conservative: undecodable bytes alone are
// not proof, so non-UTF-8 encodings keep working.
function looksBinary(data) {
  if (data === null || data === undefined) return null;
  if (Buffer.isBuffer(data)) return looksBinaryBuffer(data);
  return looksBinaryString(String(data));
}

// File extensions the Scrubber write-hook is confident are text and safe to
// clean in place. Anything not listed is left alone (binary or unknown).
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.mdx', '.rst', '.adoc',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonc',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.cs', '.php', '.pl', '.swift', '.scala', '.sh', '.bash', '.zsh', '.fish',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.vue', '.svelte', '.astro',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.csv', '.tsv', '.sql', '.graphql', '.gql', '.proto', '.tf', '.gradle',
]);

function hasTextExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(lower.slice(dot));
}

module.exports = { looksBinary, hasTextExtension, TEXT_EXTENSIONS };
