#!/usr/bin/env node
'use strict';

// The git pre-commit hook the installers put in a clone of this repository:
// it runs scripts/hooks/git-pre-commit.sh, which strips the egc:state blocks
// before a commit. install.sh and install.ps1 both call this, so a clone set
// up on Windows gets the same hook a clone set up on Linux or macOS does.
// Git for Windows runs a hook through its own bash, so the hook is the same
// bash script everywhere, written with LF line endings and no byte order
// mark.
//
// Usage:
//   node scripts/lib/git-pre-commit-install.js
// It acts on the package it ships in, found from its own location.

const fs = require('node:fs');
const path = require('node:path');

const CALL = 'ROOT="$(git rev-parse --show-toplevel)"\nbash "$ROOT/scripts/hooks/git-pre-commit.sh"\n';

const MESSAGES = {
  installed: 'git pre-commit hook installed',
  updated: 'git pre-commit hook updated',
  present: 'git pre-commit hook already installed',
};

// 'installed', 'updated' (a hook someone had gets the call appended),
// 'present', or 'skipped' when the root is no clone (a published install, or
// a worktree whose .git is a file).
function installPreCommitHook(rootDir) {
  const gitDir = path.join(rootDir, '.git');
  if (!fs.statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) return 'skipped';
  const hook = path.join(gitDir, 'hooks', 'pre-commit');
  let outcome;
  if (!fs.existsSync(hook)) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/usr/bin/env bash\n${CALL}`);
    outcome = 'installed';
  } else if (fs.readFileSync(hook, 'utf8').includes('git-pre-commit.sh')) {
    return 'present';
  } else {
    fs.appendFileSync(hook, `\n${CALL}`);
    outcome = 'updated';
  }
  fs.chmodSync(hook, fs.statSync(hook).mode | 0o100);
  return outcome;
}

if (require.main === module) {
  const outcome = installPreCommitHook(path.resolve(__dirname, '..', '..'));
  if (outcome !== 'skipped') console.log(`  ✓ ${MESSAGES[outcome]}`);
}

module.exports = { installPreCommitHook };
