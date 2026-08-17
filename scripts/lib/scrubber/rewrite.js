'use strict';

// Layer B: best-effort rewrite for statistical (token-sampling) watermarks.
//
// A statistical mark rides in the model's word choices, so the only handle on
// it is to re-say the same content differently. This module never claims a
// mark was cleared: it assembles the rewrite instruction, scores how far a
// candidate moved from the source, and runs the deterministic pass again on
// the result. In relay mode there is no network and no bundled model, so the
// agent that already hosts EGC is what actually rewrites; that makes the layer
// reach every tool that can run a skill. Honesty is the rule here: a strong,
// measured rewrite is the best lever we have, not a promise that a vendor
// detector is beaten.

const { clean } = require('./engine');

const HONEST_NOTE =
  'Reduces statistical token-sampling marks by rewording and reports how far the ' +
  'text moved. It gives no proof that a vendor detector was defeated and is never ' +
  'evidence that a human wrote the text.';

// Rewrite instructions, lightest to heaviest. The wording is our own; the host
// agent is what carries them out. No model ships in this file.
const PROMPTS = {
  paraphrase:
    'Restate the passage below in your own words, changing as many word choices as ' +
    'the meaning allows. Reorder clauses, swap the linking words, and move where ' +
    'sentences begin and end. Keep every fact, figure, name, and identifier exactly ' +
    'as written, and neither add nor drop any point. Return only the reworded ' +
    'passage.\n\n===\n{TEXT}',
  humanize:
    'Redraft the passage below the way a person would write it from scratch. Vary ' +
    'the length and cadence of sentences, and trade mechanical connective phrases ' +
    'for plain, concrete wording. Hold every fact, figure, name, and identifier ' +
    'steady, and change no point. Return only the redraft.\n\n===\n{TEXT}',
  code:
    'In the source below, reword only the human-language parts: comments, ' +
    'docstrings, and string literals. Rename local variables, parameters, and ' +
    'private helpers to different but equivalent names. Behavior, exported names, ' +
    'and any value that affects output must stay identical. Return only the ' +
    'adjusted source.\n\n===\n{TEXT}',
  backtranslate:
    'Render the passage below into {LANG}, then carry that version back into ' +
    '{ORIGINAL_LANG}. Keep every fact, figure, and name unchanged. Return only the ' +
    'final {ORIGINAL_LANG} passage.\n\n===\n{TEXT}',
  structural:
    'List the claims and shape of the passage below as terse bullet points, with ' +
    'no full sentences. Then compose a fresh, natural-reading document from those ' +
    'bullets, leaving none out. Return only the finished document.\n\n===\n{TEXT}',
};

// Escalation order when a rewrite misses the divergence target. `code` sits
// outside the ladder: it is chosen per input kind, not reached by escalation.
const STRENGTH_LADDER = ['paraphrase', 'humanize', 'backtranslate', 'structural'];

// Unicode-aware so non-Latin scripts are tokenized fairly across the tools.
function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function bigrams(tokens) {
  const set = new Set();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    set.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

// Bigram-Jaccard distance: 0.0 means identical wording, 1.0 fully moved. For a
// one-word input that has no adjacent pairs, it falls back to a token-set
// distance so a genuine change is not scored as "identical" for lack of pairs.
function lexicalDivergence(original, candidate) {
  const a = tokenize(original);
  const b = tokenize(candidate);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) {
    return jaccard(new Set(a), new Set(b));
  }
  return jaccard(ba, bb);
}

function buildPrompt(strength, text, options) {
  const opts = options || {};
  const template = PROMPTS[strength];
  if (!template) {
    throw new Error(`unknown rewrite strength: ${strength}`);
  }
  // Use replacement functions so a `$` sequence in the input (for example `$&`
  // or `$1`) is inserted literally, not interpreted as a replacement pattern.
  return template
    .replace('{LANG}', () => opts.lang || 'French')
    .replace('{ORIGINAL_LANG}', () => opts.originalLang || 'English')
    .replace('{TEXT}', () => text);
}

// Choose the candidate that moved furthest, with a small penalty for extreme
// length drift so a rewrite that doubled or halved the text is not blindly
// preferred over one that stayed close in size.
function selectCandidate(original, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('selectCandidate needs at least one candidate');
  }
  const originalLength = original.length;
  const scores = candidates.map((candidate) => {
    let score = lexicalDivergence(original, candidate);
    if (originalLength > 0) {
      const ratio = candidate.length / originalLength;
      if (ratio > 2.0 || ratio < 0.5) score -= 0.15;
    }
    return score;
  });
  let bestIndex = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > scores[bestIndex]) bestIndex = i;
  }
  return { best: candidates[bestIndex], bestIndex, scores };
}

function nextStrength(current) {
  const index = STRENGTH_LADDER.indexOf(current);
  if (index < 0 || index >= STRENGTH_LADDER.length - 1) return null;
  return STRENGTH_LADDER[index + 1];
}

// Relay mode: no network, no bundled model. Returns the instruction for the
// host agent to carry out, plus the honest note.
function buildRewrite(text, options) {
  const opts = options || {};
  const strength = opts.strength || 'paraphrase';
  return {
    mode: 'relay',
    strength,
    prompt: buildPrompt(strength, text, opts),
    inputChars: String(text).length,
    note: HONEST_NOTE,
  };
}

// Given the model's candidate rewrites, take the strongest, run the
// deterministic pass again, and report whether the measured move met the
// target. This is the measured guarantee: it proves how far the text moved,
// never that a detector was defeated.
function finalizeRewrite(original, candidates, options) {
  const opts = options || {};
  const minDivergence = typeof opts.minDivergence === 'number' ? opts.minDivergence : 0.35;
  const layerAAfter = opts.layerAAfter !== false;
  const { best, bestIndex, scores } = selectCandidate(original, candidates);

  let output = best;
  let layerA = null;
  if (layerAAfter) {
    const result = clean(output, opts.layerAOptions);
    output = result.cleaned;
    layerA = result.stats;
  }

  const divergence = lexicalDivergence(original, output);
  return {
    output,
    bestIndex,
    divergence,
    minDivergence,
    meetsThreshold: divergence >= minDivergence,
    scores,
    layerA,
    note: HONEST_NOTE,
  };
}

module.exports = {
  HONEST_NOTE,
  PROMPTS,
  STRENGTH_LADDER,
  tokenize,
  lexicalDivergence,
  buildPrompt,
  selectCandidate,
  nextStrength,
  buildRewrite,
  finalizeRewrite,
};
