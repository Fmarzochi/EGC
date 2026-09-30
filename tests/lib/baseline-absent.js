'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Repo-relative paths that the public baseline does not ship (locale docs,
// the 2.0.0-rc.1 release surface, the Rust crate) or that only a build
// produces (the OpenCode dist). A test that asserts on one of these skips
// itself instead of fabricating the content (project policy: do not invent
// missing public docs to make CI green).
//
// A path on this list is honoured only while it is really absent from the
// checkout. Once it exists, a failure that names it is a real failure.
const BASELINE_ABSENT_PATHS = Object.freeze([
  'README.zh-CN.md',
  'docs/HERMES-SETUP.md',
  'docs/SELECTIVE-INSTALL-ARCHITECTURE.md',
  'docs/business/social-launch-copy.md',
  'docs/ja-JP/',
  'docs/pt-BR/',
  'docs/ko-KR/',
  'docs/zh-CN/',
  'docs/zh-TW/',
  'docs/tr/',
  'docs/releases/2.0.0-rc.1',
  'egc/Cargo.toml',
  '.opencode/dist',
]);

function isAbsentFromCheckout(relativePath) {
  return !fs.existsSync(path.join(REPO_ROOT, relativePath));
}

// True only for a "no such file" error about a listed path that the checkout
// really lacks. An assertion failure, an error that merely mentions a listed
// path, or a missing file that is not on the list all stay failures.
function isBaselineAbsentError(error) {
  if (!error || error.code !== 'ENOENT') return false;
  const haystack = `${error.path || ''} ${error.message || ''}`.replace(/\\/g, '/');
  return BASELINE_ABSENT_PATHS.some(p => haystack.includes(p) && isAbsentFromCheckout(p));
}

function maybeSkipBaselineAbsent(error, name) {
  if (!isBaselineAbsentError(error)) return false;
  const detail = error.path || (error.message ? error.message.split("'").filter(s => s.includes('/')).pop() : '');
  console.log(`SKIP: ${name} (baseline-absent${detail ? ': ' + detail : ''})`);
  return true;
}

module.exports = {
  BASELINE_ABSENT_PATHS,
  isBaselineAbsentError,
  maybeSkipBaselineAbsent,
};
