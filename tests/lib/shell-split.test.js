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
test('heredoc delimiter with punctuation (EOF-1) is parsed in full, body closes and later commands are their own segment', () => {
  const segs = splitShellSegments('cat <<EOF-1\nbody text\nEOF-1\necho done\n');
  assert.deepStrictEqual(segs, ['cat <<EOF-1\nbody text\nEOF-1', 'echo done']);
});
test('heredoc delimiter with a dot (v1.0) is parsed in full, not truncated at the identifier boundary', () => {
  const segs = splitShellSegments('cat <<v1.0\nbody text\nv1.0\necho done\n');
  assert.deepStrictEqual(segs, ['cat <<v1.0\nbody text\nv1.0', 'echo done']);
});
test('heredoc operator with a space before the delimiter word is recognized the same as no space', () => {
  const segs = splitShellSegments('cat << EOF\nbody\nEOF\n');
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});
test('heredoc operator with nothing usable after it (end of string) is not treated as a heredoc', () => {
  const segs = splitShellSegments('cat <<');
  assert.deepStrictEqual(segs, ['cat <<']);
});
test('heredoc delimiter with an unterminated quote is not treated as a heredoc (fails safe, does not hang or throw)', () => {
  const segs = splitShellSegments("cat <<'EOF\nrm -rf /\n");
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}: ${JSON.stringify(segs)}`);
});
test('heredoc delimiter with an escaped quote inside a double-quoted span is parsed correctly (not truncated at the escaped quote)', () => {
  const segs = splitShellSegments('cat <<"EO\\"F"\nbody text\nEO"F\necho done\n');
  assert.deepStrictEqual(segs, ['cat <<"EO\\"F"\nbody text\nEO"F', 'echo done']);
});
test('heredoc delimiter with a backslash before a non-special character inside double quotes keeps the backslash literally', () => {
  const segs = splitShellSegments('cat <<"EO\\NF"\nbody text\nEO\\NF\necho done\n');
  assert.deepStrictEqual(segs, ['cat <<"EO\\NF"\nbody text\nEO\\NF', 'echo done']);
});
test('a very long single-line heredoc body does not cause quadratic slowdown', () => {
  const longLine = 'x'.repeat(200000);
  const command = `cat <<EOF\n${longLine}\nEOF\n`;
  const start = Date.now();
  const segs = splitShellSegments(command);
  const elapsedMs = Date.now() - start;
  assert.strictEqual(segs.length, 1, `expected 1 segment, got ${segs.length}`);
  assert.ok(elapsedMs < 2000, `expected roughly linear-time scan, took ${elapsedMs}ms for a 200k-char line`);
});
test('multiple heredocs on one line are consumed in order, not mixed with ordinary segments', () => {
  const segs = splitShellSegments(
    'cat <<MARKERA <<MARKERB\nline one for A\nMARKERA\nline one for B\nMARKERB\necho done\n'
  );
  assert.deepStrictEqual(segs, [
    'cat <<MARKERA <<MARKERB\nline one for A\nMARKERA\nline one for B\nMARKERB',
    'echo done',
  ]);
});

// Comments (EGC-539 audit, security fix: splitShellSegments previously had no
// # comment awareness at all, unlike extractSubstitutionBodies below -- a
// real parsing divergence in a module that feeds the Guardian bash validator.
// echo hi # note: rm -rf / && something used to split into ["echo hi # note:
// rm -rf /", "something"], treating the && inside the comment as a live
// separator and manufacturing a segment ("something") that was never live
// shell syntax.)
console.log('\nComments (EGC-539):');
test('a # comment absorbs a trailing && instead of producing a spurious extra segment', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo hi # note: rm -rf / && something'),
    ['echo hi # note: rm -rf / && something'],
  );
});
test('a # comment absorbs trailing ; and | operators too, not just &&', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo hi # rm -rf /; also | this', { splitOnPipe: true }),
    ['echo hi # rm -rf /; also | this'],
  );
});
test('# appearing mid-word does not start a comment (foo#bar is one identifier)', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo foo#bar && something'),
    ['echo foo#bar', 'something'],
  );
});
test('a comment only runs to end of line: operators on the next line still split normally', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo hi # comment\necho bye && echo baz'),
    ['echo hi # comment', 'echo bye', 'echo baz'],
  );
});
test('a quoted # does not start a comment', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo "a # b" && echo c'),
    ['echo "a # b"', 'echo c'],
  );
});
test('# inside a heredoc body is literal body text, not a comment (no change from prior behavior)', () => {
  const segs = splitShellSegments('cat <<EOF\n# not a comment && rm -rf /\nEOF\necho done');
  assert.deepStrictEqual(segs, ['cat <<EOF\n# not a comment && rm -rf /\nEOF', 'echo done']);
});

// Cubic review (EGC-539, PR #1147): the first comment-detection fix above
// introduced its own two false-comment regressions -- a live && hidden
// behind a # that only LOOKS like a comment start. Both are real bash
// tokenization behavior, verified against a real bash shell.
test('a backslash-newline continuation glues the next line onto the current word, so a following # is mid-word, not a comment start', () => {
  // Bash removes the unescaped backslash+newline pair entirely before
  // tokenizing, so 'echo hi\<newline>#c && rm -rf /' is really the single
  // token line 'echo hi#c && rm -rf /' -- '#c' is glued onto 'hi' (not a
  // comment), and the && after it is a live, real separator. The segment
  // text itself is preserved verbatim (backslash and newline included, same
  // as every other test in this file) -- only the split *decision* changes.
  assert.deepStrictEqual(
    splitShellSegments('echo hi\\\n#c && rm -rf /'),
    ['echo hi\\\n#c', 'rm -rf /'],
  );
});
test('a space before the backslash-newline continuation keeps # as a real comment start on the next line', () => {
  // Contrast with the case above: a space before the escaped newline means
  // bash sees 'hi ' (trailing space preserved) followed by '#c ...', so #
  // genuinely starts a word here and is a real comment that absorbs the
  // trailing && into the same (single) segment, verbatim text preserved.
  assert.deepStrictEqual(
    splitShellSegments('echo hi \\\n#c && rm -rf /'),
    ['echo hi \\\n#c && rm -rf /'],
  );
});
test('a backslash before CRLF escapes only the CR, not the whole line ending, so the following # is still a real comment', () => {
  // Cubic review, third pass (EGC-539, PR #1147): confirmed against a real
  // bash shell that '\' + '\r' + '\n' is NOT a line continuation. Bash has
  // no special handling of a lone CR, so the backslash escapes only the
  // '\r' (kept literally in the word), and the unescaped '\n' right after
  // it still ends the line for real. A prior fix here wrongly swallowed all
  // three characters as one continuation unit, which caused the '#' on the
  // next line to be read as mid-word instead of a real comment start -- that
  // silently pulled '&& rm -rf /' inside what bash treats as inert comment
  // text out as its own live segment, defeating the whole point of this PR.
  // The two segments below match real bash: the first ends at the escaped
  // CR (trimmed, same as the plain-newline-splitting tests above), and the
  // '#' on the next line starts a real comment that absorbs the rest of the
  // line, including '&& rm -rf /', as inert text -- never its own segment.
  assert.deepStrictEqual(
    splitShellSegments('echo hi\\\r\n#c && rm -rf /'),
    ['echo hi\\', '#c && rm -rf /'],
  );
});
test('# immediately after a closing paren from $(...) is mid-word, not a comment start (bash concatenates the following text onto the same word)', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo $(date)#c && echo AFTER'),
    ['echo $(date)#c', 'echo AFTER'],
  );
});
test('# immediately after a redirection target character is part of the filename, not a comment start', () => {
  assert.deepStrictEqual(
    splitShellSegments('echo hi >#x && rm -rf /'),
    ['echo hi >#x', 'rm -rf /'],
  );
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

// cubic-dev-ai P2 (2026-07-27, second follow-up round): $(...) written only
// as documentation inside a # comment or a literal (quoted-delimiter)
// heredoc body must not be extracted, since bash never expands it there.
test('does not extract $(...) written only as an example inside a # comment', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo hi # example: $(rm -rf /)'), []);
});
test('still extracts $(...) when # appears mid-word, not starting a real comment', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo foo#bar $(rm -rf /)'), ['rm -rf /']);
});
test('a comment only runs to end of line: a substitution on the next line is still extracted', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo hi # $(rm -rf /a)\necho $(rm -rf /b)'), ['rm -rf /b']);
});
test('does not extract $(...) inside a heredoc body whose delimiter was single-quoted (fully literal, no expansion)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies("cat <<'EOF'\nexample: $(rm -rf /)\nEOF\n"), []);
});
test('does not extract $(...) inside a heredoc body whose delimiter was double-quoted (also fully literal)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('cat <<"EOF"\nexample: $(rm -rf /)\nEOF\n'), []);
});
test('does not extract $(...) inside a heredoc body whose delimiter was backslash-escaped (also fully literal)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('cat <<\\EOF\nexample: $(rm -rf /)\nEOF\n'), []);
});
test('still extracts $(...) inside a heredoc body with a bare/unquoted delimiter (bash still expands it there)', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('cat <<EOF\n$(rm -rf /)\nEOF\n'), ['rm -rf /']);
});
test('multiple heredocs on one line: each body is scanned per its own delimiter\'s literalness', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies(
      "cat <<'LIT' <<EXP\nliteral body $(rm -rf /a)\nLIT\nexpandable body $(rm -rf /b)\nEXP\n"
    ),
    ['rm -rf /b'],
  );
});
test('does not treat pure arithmetic expansion $((...)) as a substitution body', () => {
  assert.deepStrictEqual(extractSubstitutionBodies('echo $((1+2))'), []);
});
test('still surfaces a real command substitution nested inside arithmetic expansion (one more extraction level, per the documented non-recursive contract)', () => {
  const outerBodies = extractSubstitutionBodies('echo $(( $(cat /etc/shadow) + 1 ))');
  assert.strictEqual(outerBodies.length, 1, 'the arithmetic body containing a real substitution must still be pushed once');
  assert.deepStrictEqual(extractSubstitutionBodies(outerBodies[0]), ['cat /etc/shadow']);
});
test('extractSubstitutionBodies: a very long single-line heredoc body does not cause quadratic slowdown', () => {
  const longLine = 'x'.repeat(200000);
  const command = `cat <<EOF\n${longLine}\nEOF\n`;
  const start = Date.now();
  const bodies = extractSubstitutionBodies(command);
  const elapsedMs = Date.now() - start;
  assert.deepStrictEqual(bodies, []);
  assert.ok(elapsedMs < 2000, `expected roughly linear-time scan, took ${elapsedMs}ms for a 200k-char line`);
});
test('extractSubstitutionBodies honors <<- leading-tab stripping when matching the terminator line', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies('cat <<-EOF\n\t$(rm -rf /)\n\tEOF\n'),
    ['rm -rf /'],
  );
});
test('a heredoc with no terminator still extracts substitutions from its unterminated expandable body', () => {
  assert.deepStrictEqual(
    extractSubstitutionBodies('cat <<EOF\nbody with no terminator $(rm -rf /)'),
    ['rm -rf /'],
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
