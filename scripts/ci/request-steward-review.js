#!/usr/bin/env node
'use strict';

/**
 * The stewards a pull request's changed files call for.
 *
 * docs/governance/stewards.md promises the area steward the first review on
 * every pull request that touches the area. .github/stewards.json is the
 * machine-readable twin of that table (tests/ci/request-steward-review.test.js
 * keeps the two in step), and .github/workflows/steward-review.yml feeds this
 * script the changed files, the author and the reviewers already requested,
 * then asks GitHub for the logins printed here, one per line.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STEWARDS = path.join(__dirname, '..', '..', '.github', 'stewards.json');
const STATUSES = new Set(['accepted', 'invited']);
const USAGE = 'Usage: node scripts/ci/request-steward-review.js --files <list> [--author <login>] [--requested <list>] [--stewards <json>]';

const compiled = new Map();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// A glob of the kind .gitignore and CODEOWNERS use: `**` spans any number of
// directories, `*` and `?` stay inside one segment, and the match ignores
// case so a path spelled OpenCode still belongs to the OpenCode area.
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function matchesGlob(pattern, file) {
  if (!compiled.has(pattern)) compiled.set(pattern, globToRegExp(pattern));
  return compiled.get(pattern).test(file);
}

function readStewards(file = DEFAULT_STEWARDS) {
  const stewards = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(stewards.areas)) throw new Error(`${file}: "areas" must be an array`);
  for (const area of stewards.areas) {
    if (typeof area.area !== 'string' || !area.area) throw new Error(`${file}: every area needs a name`);
    if (area.steward !== null && typeof area.steward !== 'string') throw new Error(`${file}: ${area.area}: "steward" must be a login or null`);
    if (!STATUSES.has(area.status)) throw new Error(`${file}: ${area.area}: "status" must be accepted or invited`);
    if (!Array.isArray(area.paths) || area.paths.length === 0 || area.paths.some(pattern => typeof pattern !== 'string')) {
      throw new Error(`${file}: ${area.area}: "paths" must be a non-empty list of globs`);
    }
  }
  return stewards;
}

// GitHub logins compare without case.
function sameLogin(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function stewardsFor(files, stewards, options = {}) {
  const skipped = [options.author, ...(options.alreadyRequested || [])].filter(Boolean);
  const logins = [];
  for (const area of stewards.areas) {
    if (area.status !== 'accepted' || !area.steward) continue;
    if (skipped.some(login => sameLogin(login, area.steward))) continue;
    if (logins.some(login => sameLogin(login, area.steward))) continue;
    if (files.some(file => area.paths.some(pattern => matchesGlob(pattern, file)))) logins.push(area.steward);
  }
  return logins;
}

function parseArgs(argv) {
  const options = { files: null, author: '', requested: null, stewards: DEFAULT_STEWARDS };
  const flags = { '--files': 'files', '--author': 'author', '--requested': 'requested', '--stewards': 'stewards' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags[argv[index]];
    if (!key) throw new Error(`unknown argument ${argv[index]}. ${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${argv[index]}. ${USAGE}`);
    options[key] = value;
    index += 1;
  }
  if (!options.files) throw new Error(`--files is required. ${USAGE}`);
  return options;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const stewards = readStewards(options.stewards);
    const files = readLines(options.files);
    const alreadyRequested = options.requested ? readLines(options.requested) : [];
    const logins = stewardsFor(files, stewards, { author: options.author, alreadyRequested });
    if (logins.length > 0) process.stdout.write(`${logins.join('\n')}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`request-steward-review: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { DEFAULT_STEWARDS, globToRegExp, matchesGlob, readStewards, stewardsFor, parseArgs, main };
