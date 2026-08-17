'use strict';

// Scrubber Layer A: classification of invisible / format Unicode and space
// look-alikes. This module owns the codepoint tables and the per-character
// decision that both inspect and clean share, so what a report lists is
// exactly what a clean removes. Pure functions, no I/O.
//
// Design note: the hard part is NOT stripping invisibles, it is preserving the
// ones that carry meaning. A zero-width joiner between ASCII letters is a
// carrier and goes; the same joiner inside an emoji sequence or between letters
// of a complex script is orthographic and stays. Every preservation rule below
// keys off the surrounding characters.

// Invisible / format controls with no visible glyph. Free-floating instances
// are carriers; some are preserved contextually (see the decide() rules).
const STRIP_CODEPOINTS = new Set([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x061c, // arabic letter mark (bidi; preserved by default)
  0x115f, // hangul choseong filler
  0x1160, // hangul jungseong filler
  0x17b4, // khmer vowel inherent aq
  0x17b5, // khmer vowel inherent aa
  0x180b, // mongolian free variation selector 1
  0x180c, // mongolian free variation selector 2
  0x180d, // mongolian free variation selector 3
  0x180e, // mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override
  0x2060, // word joiner
  0x2061, // function application
  0x2062, // invisible times
  0x2063, // invisible separator
  0x2064, // invisible plus
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
  0x206a, // inhibit symmetric swapping
  0x206b, // activate symmetric swapping
  0x206c, // inhibit arabic form shaping
  0x206d, // activate arabic form shaping
  0x206e, // national digit shapes
  0x206f, // nominal digit shapes
  0xfeff, // zero width no-break space / BOM
  0xfe00, 0xfe01, 0xfe02, 0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07,
  0xfe08, 0xfe09, 0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d, 0xfe0e, 0xfe0f, // variation selectors 1-16
  0xfff9, // interlinear annotation anchor
  0xfffa, // interlinear annotation separator
  0xfffb, // interlinear annotation terminator
]);

// Spaces that render like U+0020. Replaced with a plain space, not stripped, so
// word boundaries survive.
const SPACE_LOOKALIKES = new Map([
  [0x00a0, ' '], // no-break space
  [0x1680, ' '], // ogham space mark
  [0x2000, ' '], // en quad
  [0x2001, ' '], // em quad
  [0x2002, ' '], // en space
  [0x2003, ' '], // em space
  [0x2004, ' '], // three-per-em space
  [0x2005, ' '], // four-per-em space
  [0x2006, ' '], // six-per-em space
  [0x2007, ' '], // figure space
  [0x2008, ' '], // punctuation space
  [0x2009, ' '], // thin space
  [0x200a, ' '], // hair space
  [0x202f, ' '], // narrow no-break space
  [0x205f, ' '], // medium mathematical space
  [0x3000, ' '], // ideographic space
]);

// Cross-script look-alikes of Latin letters. Off by default (aggressive mode)
// because it can change legitimate multilingual text.
const LATIN_CONFUSABLES = new Map([
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041a, 'K'], [0x041c, 'M'],
  [0x041d, 'H'], [0x041e, 'O'], [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'],
  [0x0425, 'X'], [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'],
  [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'], [0x0456, 'i'],
]);

const FULLWIDTH_A = 0xff21;
const FULLWIDTH_Z_LOWER = 0xff5a;

// Bidi controls that are legitimate in mixed RTL/LTR prose: report them, but
// keep them unless the caller explicitly asks to strip bidi.
const PRESERVABLE_BIDI = new Set([0x061c, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069]);

const ZW_FAMILY = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const BIDI_CPS = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const SCRIPT_JOINERS = new Set([0x200c, 0x200d]);
const MONGOLIAN_FVS = new Set([0x180b, 0x180c, 0x180d]);
const KHMER_VOWELS = new Set([0x17b4, 0x17b5]);
const HANGUL_FILLERS = new Set([0x115f, 0x1160]);
const EMOJI_GLUE = new Set([0x200d, 0xfe0e, 0xfe0f]);
// Cf codepoints that are ordinary Arabic/Syriac orthography, not carriers.
const ORTHOGRAPHIC_CF = new Set([0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x08e2, 0x110bd, 0x110cd]);

function isFullwidthAlpha(cp) {
  return cp >= FULLWIDTH_A && cp <= FULLWIDTH_Z_LOWER;
}

function fullwidthToAscii(cp) {
  // Fullwidth block maps linearly to ASCII for A-Z, a-z (and the gap between).
  const ascii = cp - 0xfee0;
  return String.fromCodePoint(ascii);
}

function isPrivateUse(cp) {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

function isTagChar(cp) {
  return cp >= 0xe0001 && cp <= 0xe007f;
}

function isVsSupplement(cp) {
  return cp >= 0xe0100 && cp <= 0xe01ef;
}

function isVariationSelector(cp) {
  return isVsSupplement(cp) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x180b && cp <= 0x180d);
}

function isStripCodepoint(cp) {
  return STRIP_CODEPOINTS.has(cp) || isVsSupplement(cp) || isTagChar(cp) || isPrivateUse(cp);
}

function stripKind(cp) {
  if (isTagChar(cp)) return 'tag_chars';
  if (isVariationSelector(cp)) return 'variation_selector';
  if (BIDI_CPS.has(cp)) return 'bidi';
  if (ZW_FAMILY.has(cp)) return 'zero_width';
  if (isPrivateUse(cp)) return 'private_use';
  return 'format_control';
}

function isCjkIdeograph(cp) {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x323af)
  );
}

function isEmojiBase(cp) {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  if (cp >= 0x2190 && cp <= 0x25ff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return true;
  if (cp >= 0x2b00 && cp <= 0x2bff) return true;
  if ([0x00a9, 0x00ae, 0x2122, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp)) return true;
  return cp === 0x0023 || cp === 0x002a || (cp >= 0x0030 && cp <= 0x0039);
}

// Node has no unicodedata; approximate the "Letter or Mark" test with the
// property escape available in the RegExp engine. Used only inside the
// complex-script ranges, where the joiner-context check needs a base letter.
function isLetterOrMark(cp) {
  return /[\p{L}\p{M}]/u.test(String.fromCodePoint(cp));
}

function joiningScript(cp) {
  const ranges = [
    [0x0600, 0x08ff, 'arabic'],
    [0x0900, 0x0dff, 'indic'],
    [0x0f00, 0x109f, 'south_asian'],
    [0x1780, 0x17ff, 'khmer'],
    [0x1800, 0x18af, 'mongolian'],
  ];
  for (const [start, end, name] of ranges) {
    if (cp >= start && cp <= end && isLetterOrMark(cp)) {
      return name;
    }
  }
  return null;
}

function isMongolianLetter(cp) {
  return cp >= 0x1800 && cp <= 0x18af && isLetterOrMark(cp);
}

function isKhmerLetter(cp) {
  return cp >= 0x1780 && cp <= 0x17ff && isLetterOrMark(cp);
}

function isHangulJamo(cp) {
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0xa960 && cp <= 0xa97c) || (cp >= 0xd7b0 && cp <= 0xd7c6);
}

function isGlue(cp) {
  return (
    EMOJI_GLUE.has(cp) ||
    isVariationSelector(cp) ||
    SCRIPT_JOINERS.has(cp) ||
    isTagChar(cp) ||
    MONGOLIAN_FVS.has(cp) ||
    KHMER_VOWELS.has(cp) ||
    HANGUL_FILLERS.has(cp)
  );
}

// Indices inside complete subdivision-flag tag sequences (waving black flag
// followed by tag letters and a cancel tag). These tag chars are legitimate.
function validFlagTagIndices(codepoints) {
  const valid = new Set();
  let i = 0;
  while (i < codepoints.length) {
    if (codepoints[i] !== 0x1f3f4) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < codepoints.length && codepoints[j] >= 0xe0020 && codepoints[j] <= 0xe007e) {
      j += 1;
    }
    if (j > i + 1 && j < codepoints.length && codepoints[j] === 0xe007f) {
      for (let k = i + 1; k <= j; k += 1) valid.add(k);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return valid;
}

// Indices belonging to complete LRE/RLE ... PDF embeddings (not overrides).
// Overrides reorder unrelated spans, so they stay strippable.
function validBidiEmbeddingIndices(codepoints) {
  const valid = new Set();
  const stack = [];
  for (let index = 0; index < codepoints.length; index += 1) {
    const cp = codepoints[index];
    if (cp === 0x202a || cp === 0x202b || cp === 0x202d || cp === 0x202e) {
      stack.push([cp, index]);
    } else if (cp === 0x202c && stack.length > 0) {
      const [opener, openerIndex] = stack.pop();
      if (opener === 0x202a || opener === 0x202b) {
        valid.add(openerIndex);
        valid.add(index);
      }
    }
  }
  return valid;
}

module.exports = {
  STRIP_CODEPOINTS,
  SPACE_LOOKALIKES,
  LATIN_CONFUSABLES,
  PRESERVABLE_BIDI,
  SCRIPT_JOINERS,
  MONGOLIAN_FVS,
  KHMER_VOWELS,
  HANGUL_FILLERS,
  EMOJI_GLUE,
  ORTHOGRAPHIC_CF,
  isFullwidthAlpha,
  fullwidthToAscii,
  isPrivateUse,
  isTagChar,
  isVariationSelector,
  isStripCodepoint,
  stripKind,
  isCjkIdeograph,
  isEmojiBase,
  isLetterOrMark,
  joiningScript,
  isMongolianLetter,
  isKhmerLetter,
  isHangulJamo,
  isGlue,
  validFlagTagIndices,
  validBidiEmbeddingIndices,
};
