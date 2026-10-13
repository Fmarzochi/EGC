'use strict';

/**
 * The equivalence check for `node tests/run-all.js --report <file>`: two runs
 * of the same commit, one serial and one with --jobs, must agree on every
 * file's pass and fail counts and on the totals. Any difference is listed and
 * the exit code is 1.
 */

const fs = require('fs');

function compareReports(left, right) {
  const differences = [];
  const rightByFile = new Map(right.files.map(entry => [entry.file, entry]));
  const leftFiles = new Set(left.files.map(entry => entry.file));

  for (const entry of left.files) {
    const other = rightByFile.get(entry.file);
    if (!other) {
      differences.push(`${entry.file}: missing from the second run`);
    } else if (entry.passed !== other.passed || entry.failed !== other.failed || entry.ok !== other.ok) {
      differences.push(
        `${entry.file}: passed ${entry.passed}/${other.passed}, failed ${entry.failed}/${other.failed}, ok ${entry.ok}/${other.ok}`
      );
    }
  }
  for (const entry of right.files) {
    if (!leftFiles.has(entry.file)) differences.push(`${entry.file}: missing from the first run`);
  }
  if (left.totals.passed !== right.totals.passed || left.totals.failed !== right.totals.failed) {
    differences.push(
      `totals: passed ${left.totals.passed}/${right.totals.passed}, failed ${left.totals.failed}/${right.totals.failed}`
    );
  }
  return differences;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('Usage: node tests/fixtures/compare-reports.js <first.json> <second.json>');
    return 2;
  }
  const [left, right] = argv.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const differences = compareReports(left, right);
  if (differences.length === 0) {
    console.log(`Equivalent: ${left.files.length} files, ${left.totals.passed} passed, ${left.totals.failed} failed (${left.mode} and ${right.mode}).`);
    return 0;
  }
  console.log(`Not equivalent: ${differences.length} difference(s)`);
  for (const difference of differences) console.log(`  ${difference}`);
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { compareReports };
