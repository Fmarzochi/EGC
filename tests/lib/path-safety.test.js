'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileKey, isInsideReal, isUnderFolder, realizePath } = require('../../scripts/lib/path-safety');

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

function runFileKeyTests() {
  const results = [
    test('the same file written in two ways has one key', () => {
      withLayout(({ root }) => {
        const spelled = path.join(root, 'a', '..', 'a', 'b.json');
        assert.strictEqual(fileKey(spelled), fileKey(path.join(root, 'a', 'b.json')));
        const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
        assert.strictEqual(fileKey(path.join(root, 'A')) === fileKey(path.join(root, 'a')), foldsCase);
      });
    }),
    test('a folder holds what sits under it, not itself and not a sibling that starts with its name', () => {
      withLayout(({ root }) => {
        assert.strictEqual(isUnderFolder(path.join(root, 'a', 'b.json'), root), true);
        assert.strictEqual(isUnderFolder(root, root), false);
        assert.strictEqual(isUnderFolder(`${root}-other`, root), false);
        assert.strictEqual(isUnderFolder(root, path.parse(root).root), true, 'the top of the file system holds what sits under it');
      });
    }),
  ];

  if (process.platform !== 'win32') {
    results.push(test('a file reached through a link has the key of the file it is', () => {
      withLayout(({ root, outside }) => {
        fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
        assert.strictEqual(fileKey(path.join(root, 'linked', 'x.json')), fileKey(path.join(outside, 'x.json')));
        assert.strictEqual(isUnderFolder(path.join(root, 'linked', 'x.json'), outside), true);
      });
    }));
  }

  const passed = results.filter(Boolean).length;
  return { passed, failed: results.length - passed };
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

  const keys = runFileKeyTests();
  passed += keys.passed;
  failed += keys.failed;

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

    if (test('a chain of 40 links, the most a write follows, is followed to its end', () => {
      withLayout(({ root, outside }) => {
        let next = path.join(outside, 'end.json');
        for (let i = 39; i >= 0; i--) {
          const link = path.join(root, `link${i}.json`);
          fs.symlinkSync(next, link);
          next = link;
        }
        assert.strictEqual(realizePath(path.join(root, 'link0.json')), path.join(outside, 'end.json'));
        assert.strictEqual(isInsideReal(path.join(root, 'link0.json'), root), false);
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
