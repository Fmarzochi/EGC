#!/usr/bin/env node

/**
 * Stop Hook: Check for console.log statements in modified files
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs after each response and checks if any modified JavaScript/TypeScript
 * files contain console.log statements. Provides warnings to help developers
 * remember to remove debug statements before committing.
 *
 * Exclusions: test files, config files, and scripts/ directory (where
 * console.log is often intentional).
 */

const fs = require('node:fs');
const { isGitRepo, getGitModifiedFiles, readFile, log } = require('../lib/utils');
const { readHookStdin } = require('../lib/hook-stdin');

// Files where console.log is expected and should not trigger warnings. The
// directory patterns accept both separators, since git reports forward
// slashes but a path handed in on Windows can carry backslashes, and they
// match a whole path segment, so "myscripts/" is not "scripts/".
const EXCLUDED_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]s$/,
  /(^|[\\/])scripts[\\/]/,
  /(^|[\\/])__tests__[\\/]/,
  /(^|[\\/])__mocks__[\\/]/,
];

function isExcluded(file) {
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(file));
}

function main() {
  readHookStdin(({ raw: data }) => {
    try {
      if (!isGitRepo()) {
        process.stdout.write(data);
        process.exit(0);
      }

      const files = getGitModifiedFiles([String.raw`\.tsx?$`, String.raw`\.jsx?$`])
        .filter(f => fs.existsSync(f))
        .filter(f => !isExcluded(f));

      let hasConsole = false;

      for (const file of files) {
        const content = readFile(file);
        if (content?.includes('console.log')) {
          log(`[Hook] WARNING: console.log found in ${file}`);
          hasConsole = true;
        }
      }

      if (hasConsole) {
        log('[Hook] Remove console.log statements before committing');
      }
    } catch (err) {
      log(`[Hook] check-console-log error: ${err.message}`);
    }

    // Always output the original data
    process.stdout.write(data);
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { EXCLUDED_PATTERNS, isExcluded };
