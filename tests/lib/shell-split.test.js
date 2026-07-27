'use strict';
const assert = require('assert');
const { splitShellSegments, extractSubstitutionBodies } = require('../../scripts/lib/shell-split');

console.log('=== Testing shell-split.js ===\n');

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${desc}: ${e.message}`);
    failed++;
  }
}

// Basic operators
console.log('Basic operators:');
test('&& splits into two segments', () => {
  assert.deepStrictEqual(splitShellSegments('echo hi && echo bye'), ['echo hi', 'echo bye']);
});
test('|| splits into two segments', () => {
  assert.deepStrictEqual(splitShellSegments('echo hi || echo bye'), ['echo hi', 'echo bye']);
});
test('; splits into two segments', () => {
  assert.deepStrictEqual(splitShellSegments('echo hi; echo bye'), ['echo hi', 'echo bye']);
});
test('single & splits (background)', () => {
  assert.deepStrictEqual(splitShellSegments('sleep 1 & echo hi'), ['sleep 1', 'echo hi']);
});

// Redirection operators should NOT split
console.log('\nRedirection operators (should NOT split):');
test('2>&1 stays as one segment', () => {
  const segs = splitShellSegments('cmd 2>&1 | grep error');
  assert.strictEqual(segs.length, 1);
});
test('&> stays as one segment', () => {
  const segs = splitShellSegments('cmd &> /dev/null');
  assert.strictEqual(segs.length, 1);
});
test('>& stays as one segment', () => {
  const segs = splitShellSegments('cmd >& /dev/null');
  assert.strictEqual(segs.length, 1);
});

// Quoting
console.log('\nQuoting:');
test('double-quoted && not split', () => {
  const segs = splitShellSegments('tmux new -d "cd /app && echo hi"');
  assert.strictEqual(segs.length, 1);
});
test('single-quoted && not split', () => {
  const segs = splitShellSegments("tmux new -d 'cd /app && echo hi'");
  assert.strictEqual(segs.length, 1);
});
test('double-quoted ; not split', () => {
  const segs = splitShellSegments('echo "hello; world"');
  assert.strictEqual(segs.length, 1);
});

// Escaped quotes
console.log('\nEscaped quotes:');
test('escaped double quote inside double quotes', () => {
  const segs = splitShellSegments('echo "hello \\"world\\"" && echo bye');
  assert.strictEqual(segs.length, 2);
});
test('escaped single quote inside single quotes', () => {
  const segs = splitShellSegments("echo 'hello \\'world\\'' && echo bye");
  assert.strictEqual(segs.length, 2);
});

// Escaped operators outside quotes
console.log('\nEscaped operators outside quotes:');
test('escaped && outside quotes not split', () => {
  const segs = splitShellSegments('tmux new-session -d bash -lc cd /app \\&\\& npm run dev');
  assert.strictEqual(segs.length, 1);
});
test('escaped ; outside quotes not split', () => {
  const segs = splitShellSegments('echo hello \\; echo bye');
  assert.strictEqual(segs.length, 1);
});

// Complex real-world cases
console.log('\nReal-world cases:');
test('tmux new-session with quoted compound command', () => {
  const segs = splitShellSegments('tmux new-session -d -s dev "cd /app && npm run dev"');
  assert.strictEqual(segs.length, 1);
  assert.ok(segs[0].includes('tmux'));
  assert.ok(segs[0].includes('npm run dev'));
});
test('chained: tmux ls then bare dev', () => {
  const segs = splitShellSegments('tmux ls; npm run dev');
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[1], 'npm run dev');
});
test('background dev server', () => {
  const segs = splitShellSegments('npm run dev & echo started');
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0], 'npm run dev');
});
test('empty string returns empty array', () => {
  assert.deepStrictEqual(splitShellSegments(''), []);
});
test('single command no operators', () => {
  assert.deepStrictEqual(splitShellSegments('npm run dev'), ['npm run dev']);
});

// Newline/CR splitting (unconditional, all callers)
console.log('\nNewline/CR splitting:');
test('embedded newline splits into two segments', () => {
  assert.deepStrictEqual(splitShellSegments('echo a\necho b'), ['echo a', 'echo b']);
});
test('embedded carriage return splits into two segments', () => {
  assert.deepStrictEqual(splitShellSegments('echo a\recho b'), ['echo a', 'echo b']);
});
test('quoted newline does not split', () => {
  assert.deepStrictEqual(splitShellSegments('echo "a\nb"'), ['echo "a\nb"']);
});

// splitOnPipe option (opt-in, guardian command validator)
console.log('\nsplitOnPipe option:');
test('bare pipe stays one segment by default (splitOnPipe unset)', () => {
  assert.deepStrictEqual(splitShellSegments('echo a | grep b'), ['echo a | grep b']);
});
test('bare pipe splits into two segments when splitOnPipe is true', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo a | grep b', { splitOnPipe: true }),
    ['echo a', 'grep b'],
  );
});
test('|| still splits as a single operator even with splitOnPipe true (not double-counted)', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo a || echo b', { splitOnPipe: true }),
    ['echo a', 'echo b'],
  );
});
test('quoted pipe does not split even with splitOnPipe true', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo "a | b"', { splitOnPipe: true }),
    ['echo "a | b"'],
  );
});
test('multi-stage pipeline splits into one segment per stage when splitOnPipe is true', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo x | xargs rm -rf', { splitOnPipe: true }),
    ['echo x', 'xargs rm -rf'],
  );
});

// Heredoc bodies (cubic-dev-ai P2: newline splitting must not fragment one)
console.log('\nHeredoc bodies:');
test('heredoc body is not split by its own embedded newlines', () => {
  const segs = splitShellSegments('cat <<EOF\nrm -rf /\nsome other line\nEOF\n');
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});
test('command after a heredoc terminator is still its own segment', () => {
  const segs = splitShellSegments('cat <<EOF\nbody text\nEOF\necho done\n');
  assert.deepStrictEqual(segs, ['cat <<EOF\nbody text\nEOF', 'echo done']);
});
test('<<- heredoc strips leading tabs only when matching the terminator line', () => {
  const segs = splitShellSegments('cat <<-EOF\n\tbody text\n\tEOF\n');
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});
test('quoted heredoc delimiter is recognized', () => {
  const segs = splitShellSegments("cat <<'EOF'\nrm -rf /\nEOF\n");
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});
test('heredoc body line that merely starts with the delimiter text does not end it early', () => {
  const segs = splitShellSegments('cat <<EOF\nEOFOO not the real terminator\nEOF\n');
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});

// extractSubstitutionBodies (cubic-dev-ai P0: $(...)/`...`/<(...)/>(...) content
// must be recoverable so a hidden command can be validated, not just skipped)
console.log('\nextractSubstitutionBodies:');
test('extracts a $(...) command substitution body', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo $(rm -rf /)'), ['rm -rf /']);
});
test('extracts a backtick substitution body', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo `rm -rf /`'), ['rm -rf /']);
});
test('extracts a <(...) process substitution body', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('diff <(rm -rf /) file'), ['rm -rf /']);
});
test('extracts a >(...) process substitution body', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo x >(rm -rf /)'), ['rm -rf /']);
});
test('extracts multiple substitutions in one command', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies('echo $(rm -rf /) `mv /a /b`'),
    ['rm -rf /', 'mv /a /b'],
  );
});
test('still extracts $(...) inside double quotes (double quotes do not suppress command substitution in a real shell)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo "$(rm -rf /)"'), ['rm -rf /']);
});
test('does not extract $(...) hidden inside a single-quoted string (shell would not expand it either)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies("echo '$(rm -rf /)'"), []);
});
test('handles nested command substitution by returning the outer body whole (caller recurses)', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies('echo $(echo $(rm -rf /))'),
    ['echo $(rm -rf /)'],
  );
});
test('returns empty array for a command with no substitutions', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('npm run build'), []);
});
test('malformed unterminated $( does not throw and extracts nothing', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo $(rm -rf /'), []);
});
test('malformed unterminated backtick does not throw and extracts nothing', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo `rm -rf /'), []);
});
test('a closing paren inside a quoted string within $(...) does not close the substitution early', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo $(echo "a)b" rm -rf /)'), ['echo "a)b" rm -rf /']);
});
test('an escaped double quote inside $(...) does not end the quoted span early', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies('echo $(echo "a\\"b)" rm -rf /)'),
    ['echo "a\\"b)" rm -rf /'],
  );
});
test('an escaped paren inside $(...) (outside any quote) does not close the substitution early', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo $(a \\) b)'), ['a \\) b']);
});
test('an escaped backtick inside a backtick substitution does not end it early', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo `a \\` b`'), ['a \\` b']);
});
test('an escaped quote at the top level (outside any substitution) is skipped without starting a quote span', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo \\" $(rm -rf /)'), ['rm -rf /']);
});
test('an escaped char inside a double-quoted span before a substitution does not break tracking', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo "a\\"b" $(rm -rf /)'), ['rm -rf /']);
});
test('a heredoc with no terminator runs to the end of the string without throwing', () => {
  const segs = splitShellSegments('cat <<EOF\nbody with no terminator');
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
