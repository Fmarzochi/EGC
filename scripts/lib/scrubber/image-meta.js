'use strict';

// Scrubber image metadata: strip AI-provenance and other non-image metadata
// (EXIF, XMP, C2PA, text, comments) from PNG and JPEG by parsing the container
// structure at the byte level. No dependencies. Fail-safe: the cleaned buffer
// is only emitted when the whole structure parsed to its exact terminator with
// no leftover bytes (`valid: true`); on anything malformed the original buffer
// is returned with `valid: false`, so a clean can never corrupt or truncate an
// image. Whole metadata blocks are dropped, image data is copied verbatim.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Formats we actually clean. Others may be detected (for an honest warning) but
// are never rewritten.
const SUPPORTED = new Set(['png', 'jpeg']);

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

// Ancillary chunks worth keeping (color, transparency, rendering). Every other
// ancillary chunk (text, time, EXIF, C2PA, and unknown/private chunks) is
// dropped so provenance in an unlisted chunk cannot slip through. Critical
// chunks (uppercase first letter: IHDR, PLTE, IDAT, IEND, ...) are always kept.
const PNG_KEEP_ANCILLARY = new Set([
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'sPLT', 'hIST',
  'acTL', 'fcTL', 'fdAT', // APNG animation control and frame data (image data)
]);

function keepPngChunk(type) {
  const isCritical = (type.charCodeAt(0) & 0x20) === 0; // uppercase first letter
  return isCritical || PNG_KEEP_ANCILLARY.has(type);
}

function cleanPng(buf) {
  const removed = [];
  const out = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let ihdrFirst = false;
  let sawIdat = false;
  let sawIend = false;
  let index = 0;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length; // length(4) + type(4) + data + crc(4)
    if (length > buf.length || end > buf.length) return { cleaned: buf, removed: [], valid: false };
    if (index === 0) ihdrFirst = type === 'IHDR';
    if (type === 'IDAT') sawIdat = true;
    if (keepPngChunk(type)) out.push(buf.subarray(offset, end));
    else removed.push(`png:${type}`);
    offset = end;
    index += 1;
    if (type === 'IEND') { sawIend = true; break; }
  }

  // Rewrite only a genuine PNG: IHDR first, at least one IDAT, IEND terminating,
  // and no trailing bytes. Anything else is left untouched.
  if (!ihdrFirst || !sawIdat || !sawIend || offset !== buf.length) {
    return { cleaned: buf, removed: [], valid: false };
  }
  if (removed.length === 0) return { cleaned: buf, removed, valid: true };
  return { cleaned: Buffer.concat(out), removed, valid: true };
}

// --- JPEG -----------------------------------------------------------------

const JPEG_STANDALONE = new Set([0xd8, 0x01]); // SOI and TEM carry no payload
function isRstMarker(marker) {
  return marker >= 0xd0 && marker <= 0xd7;
}
// APP1 (EXIF/XMP), APP11 (JUMBF/C2PA), APP13 (IPTC/Photoshop), COM (comment).
const JPEG_DROP_MARKERS = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function jpegDropLabel(marker) {
  if (marker === 0xfe) return 'jpeg:com';
  return `jpeg:app${marker - 0xe0}`; // 0xe1 -> app1, 0xeb -> app11, 0xed -> app13
}

// Start-of-frame markers (baseline/progressive/lossless), excluding DHT (0xc4),
// JPG (0xc8), and DAC (0xcc), which are not frame headers.
function isSofMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// From the start of entropy-coded data, find the next real marker: a 0xff not
// followed by 0x00 (byte stuffing), 0xff (fill byte), or a restart marker
// (0xd0-0xd7). Returns the offset of the 0xff that begins the marker.
function scanEntropyEnd(buf, from) {
  let p = from;
  while (p + 1 < buf.length) {
    if (buf[p] === 0xff) {
      const next = buf[p + 1];
      if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) return p;
    }
    p += 1;
  }
  return -1; // no terminating marker: truncated scan
}

function cleanJpeg(buf) {
  const removed = [];
  const out = [];
  let offset = 0;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;

  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return { cleaned: buf, removed: [], valid: false };
    // A marker may be preceded by 0xff fill bytes; preserve them and advance to
    // the 0xff that actually begins the marker.
    while (offset + 1 < buf.length && buf[offset + 1] === 0xff) {
      out.push(buf.subarray(offset, offset + 1));
      offset += 1;
    }
    const marker = buf[offset + 1];

    if (marker === 0xd9) { // EOI
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      sawEoi = true;
      break;
    }
    if (JPEG_STANDALONE.has(marker) || isRstMarker(marker)) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return { cleaned: buf, removed: [], valid: false };
    const segLength = buf.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLength;
    if (segLength < 2 || segEnd > buf.length) return { cleaned: buf, removed: [], valid: false };

    if (isSofMarker(marker)) sawSof = true;

    if (marker === 0xda) {
      // Start of scan: header (segLength) then entropy data up to the next
      // marker. Copy both verbatim, then resume segment parsing (progressive
      // JPEGs have several scans with segments in between).
      sawSos = true;
      const scanEnd = scanEntropyEnd(buf, segEnd);
      if (scanEnd < 0) return { cleaned: buf, removed: [], valid: false };
      out.push(buf.subarray(offset, scanEnd));
      offset = scanEnd;
      continue;
    }
    if (JPEG_DROP_MARKERS.has(marker)) removed.push(jpegDropLabel(marker));
    else out.push(buf.subarray(offset, segEnd));
    offset = segEnd;
  }

  // Require a real JPEG: a frame header and a scan, a clean EOI, no trailing.
  if (!sawSof || !sawSos || !sawEoi || offset !== buf.length) {
    return { cleaned: buf, removed: [], valid: false };
  }
  if (removed.length === 0) return { cleaned: buf, removed, valid: true };
  return { cleaned: Buffer.concat(out), removed, valid: true };
}

// --- Dispatch -------------------------------------------------------------

function cleanImage(buf) {
  const format = detectImageFormat(buf);
  const supported = SUPPORTED.has(format);
  if (!supported) return { format, supported: false, valid: false, cleaned: buf, removed: [] };
  try {
    const result = format === 'png' ? cleanPng(buf) : cleanJpeg(buf);
    return { format, supported: true, valid: result.valid, cleaned: result.cleaned, removed: result.removed };
  } catch {
    return { format, supported: true, valid: false, cleaned: buf, removed: [] };
  }
}

function inspectImage(buf) {
  const { format, supported, valid, removed } = cleanImage(buf);
  return {
    format,
    supported,
    scanned: supported && valid,
    findings: removed,
    suspicious: removed.length > 0,
  };
}

module.exports = {
  detectImageFormat,
  cleanPng,
  cleanJpeg,
  cleanImage,
  inspectImage,
  keepPngChunk,
  jpegDropLabel,
  SUPPORTED,
  JPEG_DROP_MARKERS,
};
