#!/usr/bin/env node
/**
 * Validate that translated READMEs stay structurally parallel to the
 * English source.
 *
 * Mirrors the structural-drift checks freeCodeCamp runs across its
 * multi-language curriculum: the translated text obviously differs per
 * language, but the outline (which headings exist, at which level, in
 * which order) must match the source exactly, or Crowdin sync has silently
 * dropped/reordered a section in one language and not the others.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const README_PATH = path.join(ROOT, 'README.md');
const TRANSLATIONS_DIR = path.join(ROOT, 'translations');
const LANGUAGES = ['ar', 'es', 'hi', 'ja', 'ko', 'pt', 'ru', 'zh-CN'];

// Only ## and ### are part of the README's structural outline; deeper
// headings are free-form prose inside a section, not the skeleton being
// compared here.
const HEADING_PATTERN = /^(#{2,3})\s+(\S.*)?$/;

function extractHeadings(content) {
  const lines = content.split(/\r?\n/);
  const headings = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(HEADING_PATTERN);
    if (match) {
      headings.push({ level: match[1], text: (match[2] || '').trim() });
    }
  }

  return headings;
}

// Longest common subsequence over heading *levels* (not text, which is
// translated and therefore never string-equal to the source). This lets us
// report precisely which headings were inserted or dropped rather than just
// flagging "mismatch" from the first differing index onward.
function diffHeadingLevels(sourceHeadings, targetHeadings) {
  const n = sourceHeadings.length;
  const m = targetHeadings.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (sourceHeadings[i].level === targetHeadings[j].level) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const missing = []; // present in source, absent in target
  const extra = []; // present in target, absent in source
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (sourceHeadings[i].level === targetHeadings[j].level) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      missing.push({ index: i, heading: sourceHeadings[i] });
      i++;
    } else {
      extra.push({ index: j, heading: targetHeadings[j] });
      j++;
    }
  }
  while (i < n) {
    missing.push({ index: i, heading: sourceHeadings[i] });
    i++;
  }
  while (j < m) {
    extra.push({ index: j, heading: targetHeadings[j] });
    j++;
  }

  return { missing, extra };
}

function validateTranslationFile(lang, sourceHeadings) {
  const translationPath = path.join(TRANSLATIONS_DIR, lang, 'README.md');

  if (!fs.existsSync(translationPath)) {
    console.error(`ERROR: translations/${lang}/README.md - File not found`);
    return { valid: false };
  }

  let translationContent;
  try {
    translationContent = fs.readFileSync(translationPath, 'utf-8');
  } catch (err) {
    console.error(`ERROR: translations/${lang}/README.md - ${err.message}`);
    return { valid: false };
  }

  const targetHeadings = extractHeadings(translationContent);

  if (targetHeadings.length === sourceHeadings.length
    && targetHeadings.every((h, idx) => h.level === sourceHeadings[idx].level)) {
    return { valid: true };
  }

  console.error(`ERROR: translations/${lang}/README.md - Heading structure diverges from README.md (source has ${sourceHeadings.length} headings, translation has ${targetHeadings.length})`);

  const { missing, extra } = diffHeadingLevels(sourceHeadings, targetHeadings);

  for (const { index, heading } of missing) {
    console.error(`  - MISSING heading at source position ${index}: ${heading.level} "${heading.text}" has no counterpart in translations/${lang}/README.md`);
  }
  for (const { index, heading } of extra) {
    console.error(`  - EXTRA heading at translation position ${index}: ${heading.level} "${heading.text}" in translations/${lang}/README.md has no counterpart in README.md`);
  }
  if (missing.length === 0 && extra.length === 0) {
    // Same multiset of levels, different order.
    console.error(`  - ORDER mismatch: same heading levels present but in a different order than README.md`);
  }

  return { valid: false };
}

function validateTranslationStructure() {
  if (!fs.existsSync(README_PATH)) {
    console.error('ERROR: README.md not found at repo root');
    process.exit(1);
  }

  if (!fs.existsSync(TRANSLATIONS_DIR)) {
    console.log('No translations directory found, skipping validation');
    process.exit(0);
  }

  const sourceContent = fs.readFileSync(README_PATH, 'utf-8');
  const sourceHeadings = extractHeadings(sourceContent);

  if (sourceHeadings.length === 0) {
    console.error('ERROR: README.md - No ## or ### headings found; nothing to validate translations against');
    process.exit(1);
  }

  let hasErrors = false;
  let validCount = 0;

  for (const lang of LANGUAGES) {
    const { valid } = validateTranslationFile(lang, sourceHeadings);
    if (valid) {
      validCount++;
    } else {
      hasErrors = true;
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated heading structure for ${validCount} translation files against README.md (${sourceHeadings.length} headings)`);
}

if (require.main === module) {
  validateTranslationStructure();
}

module.exports = { extractHeadings, diffHeadingLevels };
