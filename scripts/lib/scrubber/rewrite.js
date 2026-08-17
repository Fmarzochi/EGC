'use strict';

// Layer B: best-effort rewrite for statistical (token-sampling) watermarks.
//
// Statistical marks live in the model's word choice, so the only lever that
// touches them is rewriting the prose. This module never certifies removal
// against a vendor detector: it builds the rewrite prompt, measures how far a
// candidate diverged from the original, and re-applies the deterministic
// Layer A. The agent hosting EGC is the rewrite model (the print-prompt mode
// carries no network and no bundled model), so this works in every tool that
// runs a skill. Keep this honest: strong measured rewrite is the best known
// lever, not a guarantee that a vendor watermark is gone.

const { clean } = require('./engine');

const HONEST_NOTE =
  'Best-effort against statistical token-sampling watermarks: rewrites the prose ' +
  'and measures lexical divergence. It cannot certify that a vendor watermark ' +
  'detector will fail, and it is never proof of human authorship.';

// Rewrite instructions, ordered from lightest to strongest. The agent that
// hosts EGC executes these; no model is bundled here.
const PROMPTS = {
  paraphrase:
    'Rewrite the following text so that it uses substantially different wording ' +
    'at the token level. Change clause order, connectors, and transition words; ' +
    'vary sentence boundaries and length; and replace both content words and ' +
    'function words where meaning allows. Preserve all facts, numbers, names, and ' +
    'technical identifiers. Do not add or remove claims. Output only the rewritten ' +
    'text.\n\n---\n{TEXT}',
  humanize:
    'Rewrite the following text so it reads as if a human wrote it from scratch. ' +
    'Vary sentence rhythm and length, replace formulaic AI-style transitions and ' +
    'filler with concrete natural phrasing, and use plain, varied wording. Preserve ' +
    'all facts, numbers, names, and technical identifiers. Do not add or remove ' +
    'claims. Output only the rewritten text.\n\n---\n{TEXT}',
  code:
    'Rewrite the natural-language parts of this code (comments, docstrings, and ' +
    'string literals) using different wording. Rename local variables, function ' +
    'parameters, and private helper names to semantically equivalent names. ' +
    'Preserve program behavior, public API names, and all values that affect ' +
    'output. Output only the rewritten code.\n\n---\n{TEXT}',
  backtranslate:
    'Translate the text to {LANG}, then translate that result back to ' +
    '{ORIGINAL_LANG}. Preserve all facts, numbers, and names. Output only the ' +
    'final {ORIGINAL_LANG} text.\n\n---\n{TEXT}',
  structural:
    'First extract a bullet outline of all claims (no full sentences). Then write ' +
    'a complete document from that outline in natural, varied human prose without ' +
    'omitting any bullet. Output only the final document.\n\n---\n{TEXT}',
};

// Escalation order used when a rewrite does not reach the divergence target.
// `code` is intentionally out of the ladder: it is opt-in per input kind.
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

// Bigram-Jaccard distance: 0.0 identical wording, 1.0 fully diverged. Falls
// back to token-set distance for one-word inputs that have no bigrams, so a
// short rewrite is not scored as "identical" just for lacking pairs.
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
  return template
    .replace('{LANG}', opts.lang || 'French')
    .replace('{ORIGINAL_LANG}', opts.originalLang || 'English')
    .replace('{TEXT}', text);
}

// Pick the most diverged candidate, gently penalizing extreme length drift so
// a rewrite that doubled or halved the text is not blindly preferred.
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

// print-prompt mode: no network, no bundled model. Returns the instruction for
// the host agent to execute, plus the honest note.
function buildRewrite(text, options) {
  const opts = options || {};
  const strength = opts.strength || 'paraphrase';
  return {
    mode: 'print-prompt',
    strength,
    prompt: buildPrompt(strength, text, opts),
    inputChars: String(text).length,
    note: HONEST_NOTE,
  };
}

// Given the model's candidate rewrites, pick the strongest, re-apply Layer A,
// and report whether the measured divergence met the target. This is the
// "measured guarantee": it proves how far the text moved, never that a vendor
// detector was defeated.
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
