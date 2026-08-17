'use strict';

// Layer B rewrite engine: lexical-divergence measurement, prompt building,
// candidate selection, strength escalation, and the measured finalize pass
// that re-applies Layer A. No network and no bundled model are exercised here.

const assert = require('node:assert');
const {
  HONEST_NOTE,
  STRENGTH_LADDER,
  lexicalDivergence,
  buildPrompt,
  selectCandidate,
  nextStrength,
  buildRewrite,
  finalizeRewrite,
} = require('../../scripts/lib/scrubber/rewrite');

const ZWSP = String.fromCodePoint(0x200b);

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(() => {}); // an accidental async test's rejection is handled, not fatal
      throw new Error('async test cases are not supported by this harness');
    }
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

check('lexicalDivergence is 0 for identical text and high for a reworded one', () => {
  const original = 'the quick brown fox jumps over the lazy dog';
  assert.strictEqual(lexicalDivergence(original, original), 0);
  const reworded = 'a speedy tan vulpine leaps above one sluggish hound';
  assert.ok(lexicalDivergence(original, reworded) > 0.9);
});

check('lexicalDivergence handles empty and one-word inputs without crashing', () => {
  assert.strictEqual(lexicalDivergence('', ''), 0);
  assert.strictEqual(lexicalDivergence('word', ''), 1);
  assert.strictEqual(lexicalDivergence('cat', 'cat'), 0);
  assert.strictEqual(lexicalDivergence('cat', 'dog'), 1);
});

check('lexicalDivergence tokenizes non-Latin scripts', () => {
  assert.strictEqual(lexicalDivergence('привет мир', 'привет мир'), 0);
  assert.ok(lexicalDivergence('привет мир друг', 'здравствуй земля товарищ') > 0.5);
});

check('buildPrompt fills every strength template and embeds the text', () => {
  for (const strength of ['paraphrase', 'humanize', 'code', 'structural']) {
    const prompt = buildPrompt(strength, 'SECRET_MARKER_123');
    assert.ok(prompt.includes('SECRET_MARKER_123'), `${strength} must embed the text`);
  }
  const bt = buildPrompt('backtranslate', 'hello', { lang: 'German', originalLang: 'English' });
  assert.ok(bt.includes('German') && bt.includes('English') && bt.includes('hello'));
});

check('buildPrompt rejects an unknown strength', () => {
  assert.throws(() => buildPrompt('nonsense', 'x'), /unknown rewrite strength/);
});

check('selectCandidate picks the most diverged candidate', () => {
  const original = 'the quick brown fox jumps over the lazy dog';
  const near = 'the quick brown fox jumps over the lazy hound';
  const far = 'a speedy tan vulpine leaps above one sluggish canine';
  const { best, bestIndex, scores } = selectCandidate(original, [near, far]);
  assert.strictEqual(best, far);
  assert.strictEqual(bestIndex, 1);
  assert.strictEqual(scores.length, 2);
});

check('selectCandidate penalizes extreme length drift', () => {
  const original = 'alpha beta gamma delta epsilon zeta';
  const balanced = 'one two three four five six';
  const bloated = `${balanced} ${'padding word '.repeat(40)}`;
  const { best } = selectCandidate(original, [balanced, bloated]);
  assert.strictEqual(best, balanced);
});

check('selectCandidate throws on an empty candidate list', () => {
  assert.throws(() => selectCandidate('x', []), /at least one candidate/);
});

check('nextStrength escalates and stops at the top of the ladder', () => {
  assert.strictEqual(nextStrength('paraphrase'), 'humanize');
  assert.strictEqual(nextStrength(STRENGTH_LADDER[STRENGTH_LADDER.length - 1]), null);
  assert.strictEqual(nextStrength('code'), null);
});

check('buildRewrite returns a relay instruction with the honest note and no network fields', () => {
  const r = buildRewrite('some drafted paragraph', { strength: 'paraphrase' });
  assert.strictEqual(r.mode, 'relay');
  assert.strictEqual(r.strength, 'paraphrase');
  assert.ok(r.prompt.includes('some drafted paragraph'));
  assert.strictEqual(r.note, HONEST_NOTE);
  assert.ok(!('base_url' in r) && !('url' in r) && !('endpoint' in r));
});

check('finalizeRewrite measures divergence and reports meetsThreshold', () => {
  const original = 'the quick brown fox jumps over the lazy dog';
  const weak = 'the quick brown fox jumps over the lazy dog today';
  const strong = 'a speedy tan vulpine leaps above one sluggish canine';
  const low = finalizeRewrite(original, [weak], { minDivergence: 0.5 });
  assert.strictEqual(low.meetsThreshold, false);
  const high = finalizeRewrite(original, [strong], { minDivergence: 0.5 });
  assert.strictEqual(high.meetsThreshold, true);
  assert.ok(high.divergence >= 0.5);
});

check('finalizeRewrite re-applies Layer A to the chosen candidate', () => {
  const original = 'draft text here';
  const candidate = `rewritten${ZWSP} wording entirely`;
  const r = finalizeRewrite(original, [candidate]);
  assert.ok(!r.output.includes(ZWSP), 'invisible carrier must be stripped by Layer A');
  assert.ok(r.layerA && r.layerA.removedCount >= 1);
});

check('finalizeRewrite can skip Layer A when asked', () => {
  const candidate = `kept${ZWSP}text`;
  const r = finalizeRewrite('x', [candidate], { layerAAfter: false });
  assert.ok(r.output.includes(ZWSP), 'Layer A skipped means the carrier stays');
  assert.strictEqual(r.layerA, null);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
