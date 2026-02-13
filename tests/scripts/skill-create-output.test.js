/**
 * Tests for scripts/skill-create-output.js
 *
 * Tests the SkillCreateOutput class and helper functions.
 *
 * Run with: node tests/scripts/skill-create-output.test.js
 */

const assert = require('assert');
// Import the module
const { SkillCreateOutput } = require('../../scripts/skill-create-output');

// We also need to test the un-exported helpers by requiring the source
// and extracting them from the module scope. Since they're not exported,
// we test them indirectly through the class methods, plus test the
// exported class directly.

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

// Strip ANSI escape sequences for assertions
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Capture console.log output
function captureLog(fn) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    fn();
    return logs;
  } finally {
    console.log = origLog;
  }
}

function runTests() {
  console.log('\n=== Testing skill-create-output.js ===\n');

  let passed = 0;
  let failed = 0;

  // Constructor tests
  console.log('SkillCreateOutput constructor:');

  if (test('creates instance with repo name', () => {
    const output = new SkillCreateOutput('test-repo');
    assert.strictEqual(output.repoName, 'test-repo');
    assert.strictEqual(output.width, 70); // default width
  })) passed++; else failed++;

  if (test('accepts custom width option', () => {
    const output = new SkillCreateOutput('repo', { width: 100 });
    assert.strictEqual(output.width, 100);
  })) passed++; else failed++;

  // header() tests
  console.log('\nheader():');

  if (test('outputs header with repo name', () => {
    const output = new SkillCreateOutput('my-project');
    const logs = captureLog(() => output.header());
    const combined = logs.join('\n');
    assert.ok(combined.includes('Skill Creator'), 'Should include Skill Creator');
    assert.ok(combined.includes('my-project'), 'Should include repo name');
  })) passed++; else failed++;

  if (test('header handles long repo names without crash', () => {
    const output = new SkillCreateOutput('a-very-long-repository-name-that-exceeds-normal-width-limits');
    // Should not throw RangeError
    const logs = captureLog(() => output.header());
    assert.ok(logs.length > 0, 'Should produce output');
  })) passed++; else failed++;

  // analysisResults() tests
  console.log('\nanalysisResults():');

  if (test('displays analysis data', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.analysisResults({
      commits: 150,
      timeRange: 'Jan 2026 - Feb 2026',
      contributors: 3,
      files: 200,
    }));
    const combined = logs.join('\n');
    assert.ok(combined.includes('150'), 'Should show commit count');
    assert.ok(combined.includes('Jan 2026'), 'Should show time range');
    assert.ok(combined.includes('200'), 'Should show file count');
  })) passed++; else failed++;

  // patterns() tests
  console.log('\npatterns():');

  if (test('displays patterns with confidence bars', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.patterns([
      { name: 'Test Pattern', trigger: 'when testing', confidence: 0.9, evidence: 'Tests exist' },
      { name: 'Another Pattern', trigger: 'when building', confidence: 0.5, evidence: 'Build exists' },
    ]));
    const combined = logs.join('\n');
    assert.ok(combined.includes('Test Pattern'), 'Should show pattern name');
    assert.ok(combined.includes('when testing'), 'Should show trigger');
    assert.ok(stripAnsi(combined).includes('90%'), 'Should show confidence as percentage');
  })) passed++; else failed++;

  if (test('handles patterns with missing confidence', () => {
    const output = new SkillCreateOutput('repo');
    // Should default to 0.8 confidence
    const logs = captureLog(() => output.patterns([
      { name: 'No Confidence', trigger: 'always', evidence: 'evidence' },
    ]));
    const combined = logs.join('\n');
    assert.ok(stripAnsi(combined).includes('80%'), 'Should default to 80% confidence');
  })) passed++; else failed++;

  // instincts() tests
  console.log('\ninstincts():');

  if (test('displays instincts in a box', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.instincts([
      { name: 'instinct-1', confidence: 0.95 },
      { name: 'instinct-2', confidence: 0.7 },
    ]));
    const combined = logs.join('\n');
    assert.ok(combined.includes('instinct-1'), 'Should show instinct name');
    assert.ok(combined.includes('95%'), 'Should show confidence percentage');
    assert.ok(combined.includes('70%'), 'Should show second confidence');
  })) passed++; else failed++;

  // output() tests
  console.log('\noutput():');

  if (test('displays file paths', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.output(
      '/path/to/SKILL.md',
      '/path/to/instincts.yaml'
    ));
    const combined = logs.join('\n');
    assert.ok(combined.includes('SKILL.md'), 'Should show skill path');
    assert.ok(combined.includes('instincts.yaml'), 'Should show instincts path');
    assert.ok(combined.includes('Complete'), 'Should show completion message');
  })) passed++; else failed++;

  // nextSteps() tests
  console.log('\nnextSteps():');

  if (test('displays next steps with commands', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.nextSteps());
    const combined = logs.join('\n');
    assert.ok(combined.includes('Next Steps'), 'Should show Next Steps title');
    assert.ok(combined.includes('/instinct-import'), 'Should show import command');
    assert.ok(combined.includes('/evolve'), 'Should show evolve command');
  })) passed++; else failed++;

  // footer() tests
  console.log('\nfooter():');

  if (test('displays footer with attribution', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.footer());
    const combined = logs.join('\n');
    assert.ok(combined.includes('Everything Claude Code'), 'Should include project name');
  })) passed++; else failed++;

  // progressBar edge cases (tests the clamp fix)
  console.log('\nprogressBar edge cases:');

  if (test('does not crash with confidence > 1.0 (percent > 100)', () => {
    const output = new SkillCreateOutput('repo');
    // confidence 1.5 => percent 150 — previously crashed with RangeError
    const logs = captureLog(() => output.patterns([
      { name: 'Overconfident', trigger: 'always', confidence: 1.5, evidence: 'too much' },
    ]));
    const combined = stripAnsi(logs.join('\n'));
    assert.ok(combined.includes('150%'), 'Should show 150%');
  })) passed++; else failed++;

  if (test('renders 0% confidence bar without crash', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.patterns([
      { name: 'Zero Confidence', trigger: 'never', confidence: 0.0, evidence: 'none' },
    ]));
    const combined = stripAnsi(logs.join('\n'));
    assert.ok(combined.includes('0%'), 'Should show 0%');
  })) passed++; else failed++;

  if (test('renders 100% confidence bar without crash', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.patterns([
      { name: 'Perfect', trigger: 'always', confidence: 1.0, evidence: 'certain' },
    ]));
    const combined = stripAnsi(logs.join('\n'));
    assert.ok(combined.includes('100%'), 'Should show 100%');
  })) passed++; else failed++;

  // Empty array edge cases
  console.log('\nempty array edge cases:');

  if (test('patterns() with empty array produces header but no entries', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.patterns([]));
    const combined = logs.join('\n');
    assert.ok(combined.includes('Patterns'), 'Should show header');
  })) passed++; else failed++;

  if (test('instincts() with empty array produces box but no entries', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.instincts([]));
    const combined = logs.join('\n');
    assert.ok(combined.includes('Instincts'), 'Should show box title');
  })) passed++; else failed++;

  // Box drawing crash fix (regression test)
  console.log('\nbox() crash prevention:');

  if (test('box does not crash on title longer than width', () => {
    const output = new SkillCreateOutput('repo', { width: 20 });
    // The instincts() method calls box() internally with a title
    // that could exceed the narrow width
    const logs = captureLog(() => output.instincts([
      { name: 'a-very-long-instinct-name', confidence: 0.9 },
    ]));
    assert.ok(logs.length > 0, 'Should produce output without crash');
  })) passed++; else failed++;

  if (test('analysisResults does not crash with very narrow width', () => {
    const output = new SkillCreateOutput('repo', { width: 10 });
    // box() is called with a title that exceeds width=10
    const logs = captureLog(() => output.analysisResults({
      commits: 1, timeRange: 'today', contributors: 1, files: 1,
    }));
    assert.ok(logs.length > 0, 'Should produce output without crash');
  })) passed++; else failed++;

  // box() alignment regression test
  console.log('\nbox() alignment:');

  if (test('top, middle, and bottom lines have equal visual width', () => {
    const output = new SkillCreateOutput('repo', { width: 40 });
    const logs = captureLog(() => output.instincts([
      { name: 'test', confidence: 0.9 },
    ]));
    const combined = logs.join('\n');
    const boxLines = combined.split('\n').filter(l => stripAnsi(l).trim().length > 0);
    // Find lines that start with box-drawing characters
    const boxDrawn = boxLines.filter(l => {
      const s = stripAnsi(l).trim();
      return s.startsWith('\u256D') || s.startsWith('\u2502') || s.startsWith('\u2570');
    });
    if (boxDrawn.length >= 3) {
      const widths = boxDrawn.map(l => stripAnsi(l).length);
      const firstWidth = widths[0];
      widths.forEach((w, i) => {
        assert.strictEqual(w, firstWidth,
          `Line ${i} width ${w} should match first line width ${firstWidth}`);
      });
    }
  })) passed++; else failed++;

  // ── Round 27: box and progressBar edge cases ──
  console.log('\nbox() content overflow:');

  if (test('box does not crash when content line exceeds width', () => {
    const output = new SkillCreateOutput('repo', { width: 30 });
    // Force a very long instinct name that exceeds width
    const logs = captureLog(() => output.instincts([
      { name: 'this-is-an-extremely-long-instinct-name-that-clearly-exceeds-width', confidence: 0.9 },
    ]));
    // Math.max(0, padding) should prevent RangeError
    assert.ok(logs.length > 0, 'Should produce output without RangeError');
  })) passed++; else failed++;

  if (test('patterns renders negative confidence without crash', () => {
    const output = new SkillCreateOutput('repo');
    // confidence -0.1 => percent -10 — Math.max(0, ...) should clamp filled to 0
    const logs = captureLog(() => output.patterns([
      { name: 'Negative', trigger: 'never', confidence: -0.1, evidence: 'impossible' },
    ]));
    const combined = stripAnsi(logs.join('\n'));
    assert.ok(combined.includes('-10%'), 'Should show -10%');
  })) passed++; else failed++;

  if (test('header does not crash with very long repo name', () => {
    const longRepo = 'A'.repeat(100);
    const output = new SkillCreateOutput(longRepo);
    // Math.max(0, 55 - stripAnsi(subtitle).length) protects against negative repeat
    const logs = captureLog(() => output.header());
    assert.ok(logs.length > 0, 'Should produce output without crash');
  })) passed++; else failed++;

  if (test('stripAnsi handles nested ANSI codes with multi-digit params', () => {
    // Simulate bold + color + reset
    const ansiStr = '\x1b[1m\x1b[36mBold Cyan\x1b[0m\x1b[0m';
    const stripped = stripAnsi(ansiStr);
    assert.strictEqual(stripped, 'Bold Cyan', 'Should strip all nested ANSI sequences');
  })) passed++; else failed++;

  if (test('footer produces output', () => {
    const output = new SkillCreateOutput('repo');
    const logs = captureLog(() => output.footer());
    const combined = stripAnsi(logs.join('\n'));
    assert.ok(combined.includes('Powered by'), 'Should include attribution text');
  })) passed++; else failed++;

  // Summary
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
