#!/usr/bin/env node
"use strict";

const fs   = require("fs");
const path = require("path");

const LANGUAGE_NAMES = {
  pt: "Português (Brasil)",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  ru: "Русский",
  uk: "Українська",
  tr: "Türkçe",
  ar: "العربية",
  hi: "हिन्दी",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  vi: "Tiếng Việt",
  th: "ภาษาไทย",
  id: "Bahasa Indonesia",
  sv: "Svenska",
  da: "Dansk",
  no: "Norsk",
  fi: "Suomi",
  cs: "Čeština",
  sk: "Slovenčina",
  ro: "Română",
  hu: "Magyar",
  bg: "Български",
  hr: "Hrvatski",
  el: "Ελληνικά",
  he: "עברית",
  fa: "فارسی",
  bn: "বাংলা",
  ms: "Bahasa Melayu",
  ca: "Català",
};

const ROOT         = path.join(__dirname, "..");
const TRANSLATIONS = path.join(ROOT, "translations");
const README_PATH  = path.join(ROOT, "README.md");
const TOP_START    = "<!-- LANGUAGE-SELECTOR-START -->";
const TOP_END      = "<!-- LANGUAGE-SELECTOR-END -->";

// Markers for blocks that should be identical across all translations
// Format: [startMarker, endMarker]
const SYNC_BLOCKS = [
  ["<!-- BADGES-START -->", "<!-- BADGES-END -->"],
  ["<!-- BOTTOM-BADGES-START -->", "<!-- BOTTOM-BADGES-END -->"],
];

function getAvailableLanguages() {
  if (!fs.existsSync(TRANSLATIONS)) return [];
  return fs
    .readdirSync(TRANSLATIONS)
    .filter((code) => {
      const stat   = fs.statSync(path.join(TRANSLATIONS, code));
      const readme = path.join(TRANSLATIONS, code, "README.md");
      return stat.isDirectory() && fs.existsSync(readme);
    })
    .sort();
}

function buildTopSelector(langs) {
  const links = langs.map((code) => {
    const name = LANGUAGE_NAMES[code] || code.toUpperCase();
    return `[${name}](translations/${code}/README.md)`;
  });
  return `${TOP_START}\n🌐 **English** · ${links.join(" · ")}\n${TOP_END}`;
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
  const readme = fs.readFileSync(README_PATH, "utf8");
  const langs  = getAvailableLanguages();

  const updated = replaceBlock(readme, TOP_START, TOP_END, buildTopSelector(langs));

  if (updated !== readme) {
    fs.writeFileSync(README_PATH, updated, "utf8");
    console.log(`Language selectors updated with ${langs.length} language(s): ${langs.join(", ")}`);
  } else {
    console.log("Language selectors already up to date.");
  }
}

function syncBlocks() {
  const enContent = fs.readFileSync(README_PATH, "utf8");
  const langs     = getAvailableLanguages();
  let   synced    = 0;

  for (const [start, end] of SYNC_BLOCKS) {
    const enBlock = extractBlock(enContent, start, end);
    if (!enBlock) {
      console.warn(`  Warning: sync marker not found in EN README: ${start}`);
      continue;
    }

    for (const lang of langs) {
      const filePath = path.join(TRANSLATIONS, lang, "README.md");
      const content  = fs.readFileSync(filePath, "utf8");
      if (!content.includes(start) || !content.includes(end)) {
        console.warn(`  Warning: sync marker missing in translations/${lang}/README.md: ${start}`);
        continue;
      }
      const updated = replaceBlock(content, start, end, enBlock);
      if (updated !== content) {
        fs.writeFileSync(filePath, updated, "utf8");
        console.log(`  Synced block [${start}] in translations/${lang}/README.md`);
        synced++;
      }
    }
  }

  if (synced === 0) console.log("Sync blocks: all translations up to date.");
}

function checkDrift() {
  const enContent = fs.readFileSync(README_PATH, "utf8");
  const langs     = getAvailableLanguages();
  const warnings  = [];

  // Extract key fingerprints from the English README
  const enToolCount  = (enContent.match(/^\| `\w/gm) || []).length;
  const enHasSocket  = enContent.includes("socket.dev/npm/package");
  const enHasOpenRouter = enContent.includes("OpenRouter");

  for (const lang of langs) {
    const filePath = path.join(TRANSLATIONS, lang, "README.md");
    const content  = fs.readFileSync(filePath, "utf8");
    const toolCount = (content.match(/^\| `\w/gm) || []).length;

    if (toolCount !== enToolCount) {
      warnings.push(`[${lang}] tool count mismatch: has ${toolCount}, EN has ${enToolCount}`);
    }
    if (enHasSocket && !content.includes("socket.dev/npm/package")) {
      warnings.push(`[${lang}] missing Socket.dev badge`);
    }
    if (enHasOpenRouter && !content.includes("OpenRouter")) {
      warnings.push(`[${lang}] missing OpenRouter mention`);
    }
  }

  if (warnings.length === 0) {
    console.log("Drift check: all translations appear in sync.");
  } else {
    console.warn("Drift check warnings:");
    warnings.forEach((w) => console.warn("  " + w));
    if (process.argv.includes("--strict")) process.exit(1);
  }
}

updateReadme();
syncBlocks();
checkDrift();
