/**
 * Tests for the installer progress spinner: a plain line without a TTY,
 * an in-place frame with one, and the ASCII fallback on the legacy
 * Windows console.
 */

const assert = require('assert');
const { createSpinner, frameSet, BRAILLE_FRAMES, ASCII_FRAMES } = require('../../scripts/lib/spinner');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function fakeStream(isTTY) {
  const chunks = [];
  return { isTTY, chunks, write: chunk => chunks.push(String(chunk)) };
}

test('without a TTY the label is printed once per step and no control sequence is written', () => {
  const stream = fakeStream(false);
  const spinner = createSpinner({ stream, environment: {}, platform: 'linux' });
  spinner.start('checking the install...');
  spinner.update('repairing 2 targets...');
  spinner.stop();
  const output = stream.chunks.join('');
  assert.strictEqual(output, '  checking the install...\n  repairing 2 targets...\n');
  assert.ok(!output.includes('\r'), 'no carriage return without a TTY');
  assert.ok(!output.includes('\x1b'), 'no escape sequence without a TTY');
  assert.strictEqual(spinner.live, false);
});

test('with a TTY the frame is drawn in place and the line is cleared on stop', () => {
  const stream = fakeStream(true);
  const spinner = createSpinner({ stream, environment: {}, platform: 'linux', interval: 60000 });
  spinner.start('checking the install...');
  spinner.stop();
  const output = stream.chunks.join('');
  assert.ok(output.startsWith(`\r  ${BRAILLE_FRAMES[0]}  checking the install...\x1b[K`), output);
  assert.ok(output.endsWith('\r\x1b[K'), 'stop clears the line');
  assert.ok(!output.includes('\n'), 'the spinner never scrolls the terminal');
  assert.strictEqual(spinner.live, true);
});

test('update redraws the label in place on a TTY', () => {
  const stream = fakeStream(true);
  const spinner = createSpinner({ stream, environment: {}, platform: 'linux', interval: 60000 });
  spinner.start('one');
  spinner.update('two');
  spinner.stop();
  const output = stream.chunks.join('');
  assert.ok(output.includes('  one\x1b[K'));
  assert.ok(output.includes('  two\x1b[K'));
});

test('the legacy Windows console gets ASCII frames, everything else gets braille', () => {
  assert.strictEqual(frameSet({}, 'win32'), ASCII_FRAMES);
  assert.strictEqual(frameSet({ WT_SESSION: '1' }, 'win32'), BRAILLE_FRAMES);
  assert.strictEqual(frameSet({ TERM_PROGRAM: 'vscode' }, 'win32'), BRAILLE_FRAMES);
  assert.strictEqual(frameSet({}, 'linux'), BRAILLE_FRAMES);
  assert.strictEqual(frameSet({}, 'darwin'), BRAILLE_FRAMES);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
