#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LANGUAGE_NAMES = {
  pt: 'Português (Brasil)',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  ru: 'Русский',
  uk: 'Українська',
  tr: 'Türkçe',
  ar: 'العربية',
  hi: 'हिन्दी',
  zh: '中文',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  vi: 'Tiếng Việt',
  th: 'ภาษาไทย',
  id: 'Bahasa Indonesia',
  sv: 'Svenska',
  da: 'Dansk',
  no: 'Norsk',
  fi: 'Suomi',
  cs: 'Čeština',
  sk: 'Slovenčina',
  ro: 'Română',
  hu: 'Magyar',
  bg: 'Български',
  hr: 'Hrvatski',
  el: 'Ελληνικά',
  he: 'עברית',
  fa: 'فارسی',
  bn: 'বাংলা',
  ms: 'Bahasa Melayu',
  ca: 'Català'
};

const ROOT = path.join(__dirname, '..');
const TRANSLATIONS = path.join(ROOT, 'translations');
const README_PATH = path.join(ROOT, 'README.md');
const TOP_START = '<!-- LANGUAGE-SELECTOR-START -->';
const TOP_END = '<!-- LANGUAGE-SELECTOR-END -->';

// Markers for blocks that should be identical across all translations
// Format: [startMarker, endMarker]
const SYNC_BLOCKS = [
  ['<!-- BADGES-START -->', '<!-- BADGES-END -->'],
  ['<!-- BOTTOM-BADGES-START -->', '<!-- BOTTOM-BADGES-END -->']
];

function getAvailableLanguages() {
  if (!fs.existsSync(TRANSLATIONS)) return [];
  return fs
    .readdirSync(TRANSLATIONS)
    .filter(code => {
      const stat = fs.statSync(path.join(TRANSLATIONS, code));
      const readme = path.join(TRANSLATIONS, code, 'README.md');
      return stat.isDirectory() && fs.existsSync(readme);
    })
    .sort();
}

function buildSelectorForLang(currentLang, langs) {
  const links = langs.map(code => {
    const name = LANGUAGE_NAMES[code] || code.toUpperCase();
    if (code === currentLang) {
      return `**${name}**`;
    }
    const relPath = currentLang === 'en' ? `translations/${code}/README.md` : `../${code}/README.md`;
    return `[${name}](${relPath})`;
  });

  const enName = currentLang === 'en' ? '**English**' : '[English](../../README.md)';
  return `\u{1F310} ${enName} · ${links.join(' · ')}`;
}

function replaceBlock(content, start, end, block) {
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) return content;
  return content.slice(0, s) + block + content.slice(e + end.length);
}

function extractBlock(content, start, end) {
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) return null;
  return content.slice(s, e + end.length);
}

function updateReadme() {
  const langs = getAvailableLanguages();

  // 1. Update Root README
  const enReadme = fs.readFileSync(README_PATH, 'utf8');
  const enSelector = `${TOP_START}\n${buildSelectorForLang('en', langs)}\n${TOP_END}`;
  let updatedEn = replaceBlock(enReadme, TOP_START, TOP_END, enSelector);

  // Also update bottom selector in root README if present (matching line starting with /u{1F310})
  const bottomSelectorEn = buildSelectorForLang('en', langs);
  updatedEn = updatedEn.replace(/^\u{1F310} .*$/gm, bottomSelectorEn);

  if (updatedEn !== enReadme) {
    fs.writeFileSync(README_PATH, updatedEn, 'utf8');
    console.log(`Root README language selector updated with ${langs.length} language(s).`);
  }

  // 2. Update All Translation READMEs
  for (const lang of langs) {
    const filePath = path.join(TRANSLATIONS, lang, 'README.md');
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const langSelector = buildSelectorForLang(lang, langs);
    const topBlock = `${TOP_START}\n${langSelector}\n${TOP_END}`;

    let updated = content;
    if (content.includes(TOP_START) && content.includes(TOP_END)) {
      updated = replaceBlock(updated, TOP_START, TOP_END, topBlock);
    }
    // Update bottom selector (all lines starting with /u{1F310})
    updated = updated.replace(/^\u{1F310} .*$/gm, langSelector);

    if (updated !== content) {
      fs.writeFileSync(filePath, updated, 'utf8');
      console.log(`Updated language selectors (top and bottom) in translations/${lang}/README.md`);
    }
  }
}

function syncBlocks() {
  const enContent = fs.readFileSync(README_PATH, 'utf8');
  const langs = getAvailableLanguages();
  let synced = 0;

  for (const [start, end] of SYNC_BLOCKS) {
    const enBlock = extractBlock(enContent, start, end);
    if (!enBlock) {
      console.warn(`  Warning: sync marker not found in EN README: ${start}`);
      continue;
    }

    for (const lang of langs) {
      const filePath = path.join(TRANSLATIONS, lang, 'README.md');
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(start) || !content.includes(end)) {
        console.warn(`  Warning: sync marker missing in translations/${lang}/README.md: ${start}`);
        continue;
      }
      const updated = replaceBlock(content, start, end, enBlock);
      if (updated !== content) {
        fs.writeFileSync(filePath, updated, 'utf8');
        console.log(`  Synced block [${start}] in translations/${lang}/README.md`);
        synced++;
      }
    }
  }

  if (synced === 0) console.log('Sync blocks: all translations up to date.');
}

function checkDrift() {
  const enContent = fs.readFileSync(README_PATH, 'utf8');
  const langs = getAvailableLanguages();
  const warnings = [];

  // Extract key fingerprints from the English README
  const enToolCount = (enContent.match(/^\| `\w/gm) || []).length;
  const enHasSocket = enContent.includes('socket.dev/npm/package');
  const enHasOpenRouter = enContent.includes('OpenRouter');

  for (const lang of langs) {
    const filePath = path.join(TRANSLATIONS, lang, 'README.md');
    const content = fs.readFileSync(filePath, 'utf8');
    const toolCount = (content.match(/^\| `\w/gm) || []).length;

    if (toolCount !== enToolCount) {
      warnings.push(`[${lang}] tool count mismatch: has ${toolCount}, EN has ${enToolCount}`);
    }
    if (enHasSocket && !content.includes('socket.dev/npm/package')) {
      warnings.push(`[${lang}] missing Socket.dev badge`);
    }
    if (enHasOpenRouter && !content.includes('OpenRouter')) {
      warnings.push(`[${lang}] missing OpenRouter mention`);
    }
  }

  if (warnings.length === 0) {
    console.log('Drift check: all translations appear in sync.');
  } else {
    console.warn('Drift check warnings:');
    warnings.forEach(w => console.warn('  ' + w));
    if (process.argv.includes('--strict')) process.exit(1);
  }
}

updateReadme();
syncBlocks();
checkDrift();
