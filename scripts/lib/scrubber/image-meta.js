'use strict';

// Scrubber image metadata: strip AI-provenance and other non-image metadata
// (EXIF, XMP, C2PA, text, comments) from common raster formats by parsing the
// container structure at the byte level. No dependencies. Fail-safe: on any
// malformed or unexpected structure the original buffer is returned unchanged,
// so a clean can never corrupt an image.
//
// Whole metadata blocks are dropped, never rewritten, and image data is copied
// verbatim, so re-encoding artifacts are impossible.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectImageFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

// --- PNG ------------------------------------------------------------------

// Ancillary chunks that carry text / time / provenance, dropped whole. Image
// and color chunks (IHDR, PLTE, IDAT, IEND, tRNS, gAMA, iCCP, ...) are kept.
const PNG_DROP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf', 'caBX', 'caNv', 'orNT']);

function cleanPng(buf) {
  const removed = [];
  const out = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length; // length + type(4) + data + crc(4)
    if (length > buf.length || end > buf.length) return { cleaned: buf, removed: [] }; // malformed: bail
    const chunk = buf.subarray(offset, end);
    if (PNG_DROP_CHUNKS.has(type)) {
      removed.push(`png:${type}`);
    } else {
      out.push(chunk);
    }
    offset = end;
    if (type === 'IEND') break;
  }
  if (removed.length === 0) return { cleaned: buf, removed };
  return { cleaned: Buffer.concat(out), removed };
}

// --- JPEG -----------------------------------------------------------------

// Markers with no length payload.
const JPEG_STANDALONE = new Set([0xd8, 0xd9, 0x01]);
function isRstMarker(marker) {
  return marker >= 0xd0 && marker <= 0xd7;
}
// APP1 (EXIF/XMP), APP11 (JUMBF/C2PA), APP13 (IPTC/Photoshop), COM (comment).
const JPEG_DROP_MARKERS = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function cleanJpeg(buf) {
  const removed = [];
  const out = [];
  let offset = 0;

  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return { cleaned: buf, removed: [] }; // not at a marker: bail
    const marker = buf[offset + 1];

    if (JPEG_STANDALONE.has(marker) || isRstMarker(marker)) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data runs to the end (or EOI). Copy
      // the rest verbatim without parsing inside it.
      out.push(buf.subarray(offset));
      break;
    }
    if (offset + 4 > buf.length) return { cleaned: buf, removed: [] };
    const segLength = buf.readUInt16BE(offset + 2);
    const end = offset + 2 + segLength;
    if (segLength < 2 || end > buf.length) return { cleaned: buf, removed: [] };
    if (JPEG_DROP_MARKERS.has(marker)) {
      removed.push(`jpeg:app${marker & 0x0f}`);
    } else {
      out.push(buf.subarray(offset, end));
    }
    offset = end;
  }

  if (removed.length === 0) return { cleaned: buf, removed };
  return { cleaned: Buffer.concat(out), removed };
}

// --- Dispatch -------------------------------------------------------------

function cleanImage(buf) {
  const format = detectImageFormat(buf);
  try {
    if (format === 'png') return { format, ...cleanPng(buf) };
    if (format === 'jpeg') return { format, ...cleanJpeg(buf) };
  } catch {
    return { format, cleaned: buf, removed: [] };
  }
  return { format, cleaned: buf, removed: [] };
}

function inspectImage(buf) {
  const { format, removed } = cleanImage(buf);
  return { format, findings: removed, suspicious: removed.length > 0 };
}

module.exports = {
  detectImageFormat,
  cleanPng,
  cleanJpeg,
  cleanImage,
  inspectImage,
  PNG_DROP_CHUNKS,
  JPEG_DROP_MARKERS,
};
