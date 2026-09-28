#!/usr/bin/env node
'use strict';

// The git pre-commit hook the installers put in a clone of this repository:
// it runs scripts/hooks/git-pre-commit.sh, which strips the egc:state blocks
// before a commit, and then the hook the clone had before, kept whole under
// its own name so its language and its exits stay its own. install.sh and
// install.ps1 both call this, so a clone set up on Windows gets the same hook
// a clone set up on Linux or macOS does. Git for Windows runs a hook through
// its own bash, so the hook is the same bash script everywhere, written with
// LF line endings and no byte order mark.
//
// Usage:
//   node scripts/lib/git-pre-commit-install.js
// It acts on the package it ships in, found from its own location.

const fs = require('node:fs');
const path = require('node:path');

const CALL = 'ROOT="$(git rev-parse --show-toplevel)"\nbash "$ROOT/scripts/hooks/git-pre-commit.sh"\n';
const PREVIOUS_NAME = 'pre-commit.before-egc';
const HOOK = [
  '#!/usr/bin/env bash',
  '# egc: strips the egc:state blocks, then runs the hook this clone had before (pre-commit.before-egc).',
  'ROOT="$(git rev-parse --show-toplevel)"',
  'bash "$ROOT/scripts/hooks/git-pre-commit.sh" || exit $?',
  `PREVIOUS="$(dirname "$0")/${PREVIOUS_NAME}"`,
  'if [ -x "$PREVIOUS" ]; then exec "$PREVIOUS" "$@"; fi',
  '',
].join('\n');
// What the installers wrote before this hook: a hook of their own, or the
// call appended to one someone had. A hook is compared and cut as bytes, so
// one that is not UTF-8 is kept as it was.
const EARLIER_HOOK = Buffer.from(`#!/usr/bin/env bash\n${CALL}`);
const APPENDED_CALL = Buffer.from(`\n${CALL}`);

const MESSAGES = {
  installed: 'git pre-commit hook installed',
  updated: 'git pre-commit hook updated',
  wrapped: `git pre-commit hook installed; the hook this clone had runs after it, as .git/hooks/${PREVIOUS_NAME}`,
  present: 'git pre-commit hook already installed',
  linked: 'git pre-commit hook left as it is: it is a link. Have what it points to run scripts/hooks/git-pre-commit.sh',
  conflict: `git pre-commit hook left as it is: .git/hooks/${PREVIOUS_NAME} is already there. Merge the two, then run the installer again`,
};

function isLink(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

// A hook with another name elsewhere shares its content with that file, so
// writing to it would change a file outside .git/hooks.
function isHardLinked(file) {
  return fs.statSync(file).nlink > 1;
}

// A link is read, never written through: it points to a file outside
// .git/hooks, often a tracked one. The one that points to the strip script
// itself already runs it.
function linkedOutcome(rootDir, hook) {
  const stripScript = path.join(rootDir, 'scripts', 'hooks', 'git-pre-commit.sh');
  try {
    return fs.realpathSync(hook) === fs.realpathSync(stripScript) ? 'present' : 'linked';
  } catch {
    return 'linked';
  }
}

// A hook of someone else's is kept whole under PREVIOUS_NAME, less the call
// an earlier installer appended to it, and the hook wraps it.
function wrapPrevious(hook, bytes) {
  const previous = path.join(path.dirname(hook), PREVIOUS_NAME);
  if (fs.lstatSync(previous, { throwIfNoEntry: false })) return 'conflict';
  fs.renameSync(hook, previous);
  const tail = bytes.subarray(bytes.length - APPENDED_CALL.length);
  if (bytes.length >= APPENDED_CALL.length && tail.equals(APPENDED_CALL)) {
    fs.writeFileSync(previous, bytes.subarray(0, bytes.length - APPENDED_CALL.length));
  }
  fs.writeFileSync(hook, HOOK);
  return 'wrapped';
}

function writeHook(hook, outcome) {
  fs.writeFileSync(hook, HOOK);
  return outcome;
}

// 'installed', 'updated' (the hook an earlier installer wrote), 'wrapped' (a
// hook someone had now runs after it), 'present', 'linked' or 'conflict'
// (left as they are, see MESSAGES), or 'skipped' when the root is no clone (a
// published install, or a worktree whose .git is a file).
function installPreCommitHook(rootDir) {
  const gitDir = path.join(rootDir, '.git');
  if (!fs.statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) return 'skipped';
  const hooksDir = path.join(gitDir, 'hooks');
  const hook = path.join(hooksDir, 'pre-commit');
  if (isLink(hooksDir)) return 'linked';
  if (isLink(hook)) return linkedOutcome(rootDir, hook);
  let outcome;
  if (fs.existsSync(hook)) {
    const bytes = fs.readFileSync(hook);
    if (bytes.equals(Buffer.from(HOOK))) return 'present';
    if (isHardLinked(hook)) return 'linked';
    outcome = bytes.equals(EARLIER_HOOK) ? writeHook(hook, 'updated') : wrapPrevious(hook, bytes);
  } else {
    fs.mkdirSync(hooksDir, { recursive: true });
    outcome = writeHook(hook, 'installed');
  }
  if (outcome !== 'conflict') fs.chmodSync(hook, fs.statSync(hook).mode | 0o100);
  return outcome;
}

// What install.sh and install.ps1 run: the hook in the clone this script
// belongs to, and a line saying what happened, a warning when it was left.
function main(rootDir = path.resolve(__dirname, '..', '..')) {
  const outcome = installPreCommitHook(rootDir);
  if (outcome === 'linked' || outcome === 'conflict') console.log(`  ! ${MESSAGES[outcome]}`);
  else if (outcome !== 'skipped') console.log(`  ✓ ${MESSAGES[outcome]}`);
  return outcome;
}

if (require.main === module) main();

module.exports = { installPreCommitHook, main, HOOK, PREVIOUS_NAME };
