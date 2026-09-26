'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInsideReal, realizePath } = require('../../scripts/lib/path-safety');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

// base/root is the managed root, base/outside anything beyond it. The base
// is realized once so expectations compare real paths on macOS, where the
// temp folder sits behind /var -> /private/var.
function withLayout(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-test-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  try {
    fn({ base, root, outside });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('\n=== Testing path-safety.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('a missing path lands under the real location of its deepest existing folder', () => {
    withLayout(({ root }) => {
      assert.strictEqual(realizePath(path.join(root, 'a', 'b.json')), path.join(root, 'a', 'b.json'));
    });
  })) passed++; else failed++;

  if (process.platform !== 'win32') {
    if (test('a link to an existing file lands on that file', () => {
      withLayout(({ root, outside }) => {
        fs.writeFileSync(path.join(outside, 'x.json'), '{}');
        fs.symlinkSync(path.join(outside, 'x.json'), path.join(root, 'link.json'));
        assert.strictEqual(realizePath(path.join(root, 'link.json')), path.join(outside, 'x.json'));
        assert.strictEqual(isInsideReal(path.join(root, 'link.json'), root), false);
      });
    })) passed++; else failed++;

    if (test('a link to a file that is not there yet lands where that file would be created', () => {
      withLayout(({ root, outside }) => {
        fs.symlinkSync(path.join(outside, 'new.json'), path.join(root, 'link.json'));
        assert.strictEqual(realizePath(path.join(root, 'link.json')), path.join(outside, 'new.json'));
        assert.strictEqual(isInsideReal(path.join(root, 'link.json'), root), false);
      });
    })) passed++; else failed++;

    if (test('a link to a file that is not there yet, inside the root, stays inside', () => {
      withLayout(({ root }) => {
        fs.mkdirSync(path.join(root, 'kept'));
        fs.symlinkSync(path.join('kept', 'new.json'), path.join(root, 'link.json'));
        assert.strictEqual(realizePath(path.join(root, 'link.json')), path.join(root, 'kept', 'new.json'));
        assert.strictEqual(isInsideReal(path.join(root, 'link.json'), root), true);
      });
    })) passed++; else failed++;

    if (test('a relative link is followed from the folder it really sits in', () => {
      withLayout(({ base, root, outside }) => {
        fs.symlinkSync(outside, path.join(root, 'dir'), 'dir');
        fs.symlinkSync(path.join('..', 'escaped.json'), path.join(outside, 'link.json'));
        assert.strictEqual(realizePath(path.join(root, 'dir', 'link.json')), path.join(base, 'escaped.json'));
      });
    })) passed++; else failed++;

    if (test('a chain of links to a missing file is followed to its end', () => {
      withLayout(({ root, outside }) => {
        fs.symlinkSync(path.join(outside, 'end.json'), path.join(root, 'second.json'));
        fs.symlinkSync('second.json', path.join(root, 'first.json'));
        assert.strictEqual(realizePath(path.join(root, 'first.json')), path.join(outside, 'end.json'));
      });
    })) passed++; else failed++;

    if (test('a link to a missing file below a missing folder keeps the tail under the link target', () => {
      withLayout(({ root, outside }) => {
        fs.symlinkSync(path.join(outside, 'gone'), path.join(root, 'dir'), 'dir');
        assert.strictEqual(realizePath(path.join(root, 'dir', 'a', 'b.json')), path.join(outside, 'gone', 'a', 'b.json'));
      });
    })) passed++; else failed++;

    if (test('a link loop returns an answer instead of hanging or throwing', () => {
      withLayout(({ root }) => {
        fs.symlinkSync('b', path.join(root, 'a'));
        fs.symlinkSync('a', path.join(root, 'b'));
        assert.strictEqual(typeof realizePath(path.join(root, 'a')), 'string');
      });
    })) passed++; else failed++;
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
