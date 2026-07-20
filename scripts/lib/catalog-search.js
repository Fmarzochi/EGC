'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, 'skill-index.json');

function loadIndexEntries(indexPath = INDEX_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch (_) {
    // Missing or corrupt index degrades to manifest-only search results.
    return [];
  }
}

function scoreEntry(entry, terms) {
  const name = String(entry.name || '').toLowerCase();
  const description = String(entry.description || '').toLowerCase();
  let total = 0;

  for (const term of terms) {
    let score = 0;
    if (name === term) {
      score = 5;
    } else if (name.includes(term)) {
      score = 3;
    }
    if (description.includes(term)) {
      score += 1;
    }
    if (score === 0) {
      return 0;
    }
    total += score;
  }

  return total;
}

function searchEntries(entries, rawTerms, limit = 20) {
  const terms = (Array.isArray(rawTerms) ? rawTerms : [])
    .map(term => String(term).trim().toLowerCase())
    .filter(Boolean);

  if (terms.length === 0) {
    return [];
  }

  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, terms);
    if (score > 0) {
      scored.push({ kind: entry.kind, name: entry.name, description: entry.description, score });
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name))
  );

  return scored.slice(0, limit);
}

module.exports = {
  loadIndexEntries,
  searchEntries,
};
