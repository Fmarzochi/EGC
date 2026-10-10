#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DOC_RELATIVE_PATH, loadToolPaths, renderToolPathsMarkdown } = require('../lib/tool-paths');

const repoRoot = path.resolve(__dirname, '..', '..');
const docPath = path.join(repoRoot, DOC_RELATIVE_PATH);
const rendered = renderToolPathsMarkdown(loadToolPaths(repoRoot));

if (process.argv.includes('--check')) {
  const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  if (current !== rendered) {
    console.error(`${DOC_RELATIVE_PATH} is out of date: run node scripts/ci/generate-tool-paths-doc.js`);
    process.exit(1);
  }
  console.log(`${DOC_RELATIVE_PATH} is up to date`);
} else {
  fs.writeFileSync(docPath, rendered);
  console.log(`wrote ${DOC_RELATIVE_PATH}`);
}
