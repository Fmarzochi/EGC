'use strict';

// Scrubber deterministic engine: inspect and clean share one per-character
// decision so a report lists exactly what a clean removes. Iterates by code
// point (Array.from), so astral characters (emoji, tag chars) are handled whole.

const marks = require('./unicode-marks');
const { normalizeDashes } = require('./dash-normalize');

const OTHER_FORMAT = /\p{Cf}/u;

function cpAt(char) {
  return char.codePointAt(0);
}

// A variation selector right after the base it modifies (CJK ideograph or
// Mongolian letter) is orthographic, not a carrier.
function preservedVariationSelector(cp, prevInput) {
  if (prevInput === null) return false;
  const prevCp = cpAt(prevInput);
  if (cp >= 0xe0100 && cp <= 0xe01ef && marks.isCjkIdeograph(prevCp)) return true;
  if (cp >= 0x180b && cp <= 0x180d && prevCp >= 0x1800 && prevCp <= 0x18af) return true;
  return cp >= 0xfe00 && cp <= 0xfe0d && marks.isCjkIdeograph(prevCp);
}

// Emoji presentation glue (ZWJ between emoji, VS15/VS16 after an emoji base).
function preservedEmojiGlue(cp, prevKept, prevInput, nextInput) {
  if (!marks.EMOJI_GLUE.has(cp)) return false;
  if ((cp === 0xfe0e || cp === 0xfe0f) && prevInput !== null && marks.isEmojiBase(cpAt(prevInput))) return true;
  return (
    cp === 0x200d &&
    prevKept !== null &&
    nextInput !== null &&
    marks.isEmojiBase(cpAt(prevKept)) &&
    marks.isEmojiBase(cpAt(nextInput))
  );
}

// ZWNJ/ZWJ between two letters of the same complex script is orthographic.
function preservedScriptJoiner(cp, prevInput, nextInput) {
  if (!marks.SCRIPT_JOINERS.has(cp) || prevInput === null || nextInput === null) return false;
  const prevScript = marks.joiningScript(cpAt(prevInput));
  return prevScript !== null && prevScript === marks.joiningScript(cpAt(nextInput));
}

// Same-script fillers/selectors that are only meaningful right after a base
// from their own script (Mongolian FVS, Khmer inherent vowels, Hangul fillers).
function preservedSameScriptFiller(cp, prevKept) {
  if (prevKept === null) return false;
  const prevCp = cpAt(prevKept);
  if (marks.MONGOLIAN_FVS.has(cp) && marks.isMongolianLetter(prevCp)) return true;
  if (marks.KHMER_VOWELS.has(cp) && marks.isKhmerLetter(prevCp)) return true;
  return marks.HANGUL_FILLERS.has(cp) && marks.isHangulJamo(prevCp);
}

// Returns true when a potential carrier is actually load-bearing in context and
// must be kept. Delegates to small per-family checks to stay simple.
function isPreserved(cp, prevKept, prevInput, nextInput, opts) {
  // stripEmojiGlue gates only the emoji-glue rule: every other contextual
  // preservation (CJK/Mongolian variation selectors, complex-script joiners,
  // flag tags, same-script fillers, orthographic Cf) stays active.
  return (
    preservedVariationSelector(cp, prevInput) ||
    (!opts.stripEmojiGlue && preservedEmojiGlue(cp, prevKept, prevInput, nextInput)) ||
    preservedScriptJoiner(cp, prevInput, nextInput) ||
    (marks.isTagChar(cp) && opts.validFlagTag) ||
    preservedSameScriptFiller(cp, prevKept) ||
    marks.ORTHOGRAPHIC_CF.has(cp)
  );
}

// Classify one code point. Returns { action: keep|strip|replace, out, kind }.
function classify(char, prevKept, prevInput, nextInput, opts) {
  const cp = cpAt(char);

  if (opts.validBidiEmbedding && !opts.stripBidi) return { action: 'keep', out: char, kind: null };
  if (marks.PRESERVABLE_BIDI.has(cp) && !opts.stripBidi) return { action: 'keep', out: char, kind: null };
  if (isPreserved(cp, prevKept, prevInput, nextInput, opts)) return { action: 'keep', out: char, kind: null };

  if (marks.isStripCodepoint(cp)) return { action: 'strip', out: '', kind: marks.stripKind(cp) };
  if (opts.normalizeSpaces && marks.SPACE_LOOKALIKES.has(cp)) {
    return { action: 'replace', out: marks.SPACE_LOOKALIKES.get(cp), kind: 'space' };
  }
  if (opts.aggressive) {
    if (marks.LATIN_CONFUSABLES.has(cp)) return { action: 'replace', out: marks.LATIN_CONFUSABLES.get(cp), kind: 'confusable' };
    if (marks.isFullwidthAlpha(cp)) return { action: 'replace', out: marks.fullwidthToAscii(cp), kind: 'confusable' };
  }
  if (OTHER_FORMAT.test(char) && !marks.SPACE_LOOKALIKES.has(cp)) {
    return { action: 'strip', out: '', kind: 'format_control' };
  }
  return { action: 'keep', out: char, kind: null };
}

function resolveOptions(options) {
  const o = options || {};
  return {
    normalizeSpaces: o.normalizeSpaces !== false,
    aggressive: Boolean(o.aggressive),
    stripEmojiGlue: Boolean(o.stripEmojiGlue),
    stripBidi: Boolean(o.stripBidi),
    normalizeDashes: o.normalizeDashes !== false,
  };
}

function charLabel(char) {
  const cp = cpAt(char);
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function hitConfidence(kind) {
  return kind === 'space' ? 'informational' : 'probable';
}

// Walk the text once, calling classify per code point and threading prevKept /
// flag-tag / bidi-embedding context. Reused by both inspect and clean.
function walk(text, opts, onDecision) {
  const chars = Array.from(text);
  const cps = chars.map(cpAt);
  const validFlagTags = marks.validFlagTagIndices(cps);
  const validBidiEmbeddings = marks.validBidiEmbeddingIndices(cps);
  let prevKept = null;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const decision = classify(char, prevKept, i > 0 ? chars[i - 1] : null, i + 1 < chars.length ? chars[i + 1] : null, {
      ...opts,
      validFlagTag: validFlagTags.has(i),
      validBidiEmbedding: validBidiEmbeddings.has(i),
    });
    onDecision(char, i, decision);
    if (decision.action === 'keep') {
      if (!marks.isGlue(cpAt(char))) prevKept = decision.out;
    } else if (decision.action === 'replace') {
      prevKept = decision.out;
    }
  }
  return chars.length;
}

function inspect(text, options) {
  // Inspect is diagnostic: it surfaces bidi controls as hits even though clean
  // preserves the legitimate ones by default. Forcing stripBidi here classifies
  // them so the report lists them; clean still keeps them unless asked not to.
  const opts = { ...resolveOptions(options), stripBidi: true };
  const buckets = new Map();
  let total = 0;

  walk(text, opts, (char, index, decision) => {
    if (decision.kind === null) return;
    const key = `${cpAt(char)}:${decision.kind}`;
    if (!buckets.has(key)) {
      buckets.set(key, { codepoint: cpAt(char), label: charLabel(char), kind: decision.kind, count: 0, samples: [] });
    }
    const bucket = buckets.get(key);
    bucket.count += 1;
    if (bucket.samples.length < 10) bucket.samples.push(index);
    total += 1;
  });

  const dashProbe = normalizeDashes(text);
  const hits = [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.codepoint - b.codepoint)
    .map(h => ({ ...h, confidence: hitConfidence(h.kind) }));

  const notes = [
    'Layer A only: invisible/format Unicode, space look-alikes, and long dashes.',
    'Statistical (token-sampling) marks are out of scope here; use the rewrite workflow.',
  ];
  if (hits.length === 0 && dashProbe.count === 0) {
    notes.push('No deterministic carriers detected.');
  }

  return {
    length: Array.from(text).length,
    suspiciousTotal: total + dashProbe.count,
    hits,
    dashes: dashProbe.count,
    notes,
  };
}

function clean(text, options) {
  const opts = resolveOptions(options);
  const removed = new Map();
  const replaced = new Map();
  const out = [];

  walk(text, opts, (char, _index, decision) => {
    if (decision.action === 'keep' || decision.action === 'replace') {
      out.push(decision.out);
    }
    if (decision.action === 'strip') {
      removed.set(charLabel(char), (removed.get(charLabel(char)) || 0) + 1);
    } else if (decision.action === 'replace') {
      replaced.set(charLabel(char), (replaced.get(charLabel(char)) || 0) + 1);
    }
  });

  let cleaned = out.join('');
  let dashCount = 0;
  if (opts.normalizeDashes) {
    const dashResult = normalizeDashes(cleaned);
    cleaned = dashResult.text;
    dashCount = dashResult.count;
  }

  const removedCount = [...removed.values()].reduce((a, b) => a + b, 0);
  const replacedCount = [...replaced.values()].reduce((a, b) => a + b, 0);

  return {
    cleaned,
    changed: removedCount > 0 || replacedCount > 0 || dashCount > 0,
    stats: {
      inputLength: Array.from(text).length,
      outputLength: Array.from(cleaned).length,
      removed: Object.fromEntries(removed),
      replaced: Object.fromEntries(replaced),
      removedCount,
      replacedCount,
      dashCount,
    },
  };
}

module.exports = { inspect, clean, classify };
