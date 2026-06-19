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

const LANGUAGE_WORD = {
  pt: "Idioma",
  es: "Idioma",
  fr: "Langue",
  de: "Sprache",
  it: "Lingua",
  nl: "Taal",
  pl: "Język",
  ru: "Язык",
  uk: "Мова",
  tr: "Dil",
  ar: "اللغة",
  hi: "भाषा",
  zh: "语言",
  ja: "言語",
  ko: "언어",
  vi: "Ngôn ngữ",
  th: "ภาษา",
  id: "Bahasa",
  sv: "Språk",
  da: "Sprog",
  no: "Språk",
  fi: "Kieli",
  cs: "Jazyk",
  sk: "Jazyk",
  ro: "Limbă",
  hu: "Nyelv",
  bg: "Език",
  hr: "Jezik",
  el: "Γλώσσα",
  he: "שפה",
  fa: "زبان",
  bn: "ভাষা",
  ms: "Bahasa",
  ca: "Idioma",
};

const ROOT         = path.join(__dirname, "..");
const TRANSLATIONS = path.join(ROOT, "translations");
const README_PATH  = path.join(ROOT, "README.md");
const TOP_START    = "<!-- LANGUAGE-SELECTOR-START -->";
const TOP_END      = "<!-- LANGUAGE-SELECTOR-END -->";
const CENTER_START = "<!-- CENTERED-LANGUAGE-SELECTOR-START -->";
const CENTER_END   = "<!-- CENTERED-LANGUAGE-SELECTOR-END -->";

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
  return `${TOP_START}\n**Language:** English | ${links.join(" | ")}\n${TOP_END}`;
}

function buildCenteredSelector(langs) {
  const titleWords  = ["Language", ...langs.map((c) => LANGUAGE_WORD[c] || c.toUpperCase())];
  const uniqueWords = [...new Set(titleWords)];
  const title       = `**${uniqueWords.join(" / ")}**`;
  const links       = [
    `[**English**](README.md)`,
    ...langs.map((code) => {
      const name = LANGUAGE_NAMES[code] || code.toUpperCase();
      return `[${name}](translations/${code}/README.md)`;
    }),
  ].join(" | ");

  return [
    CENTER_START,
    '<div align="center">',
    "",
    title,
    "",
    links,
    "",
    "</div>",
    CENTER_END,
  ].join("\n");
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

  const updated = replaceBlock(
    replaceBlock(readme, TOP_START, TOP_END, buildTopSelector(langs)),
    CENTER_START,
    CENTER_END,
    buildCenteredSelector(langs)
  );

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
    if (!enBlock) continue;

    for (const lang of langs) {
      const filePath = path.join(TRANSLATIONS, lang, "README.md");
      const content  = fs.readFileSync(filePath, "utf8");
      const updated  = replaceBlock(content, start, end, enBlock);
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
  const enHasBadges  = enContent.includes("shields.io");
  const enHasSocket  = enContent.includes("socket.dev/api/badge");
  const enHasOpenRouter = enContent.includes("OpenRouter");

  for (const lang of langs) {
    const filePath = path.join(TRANSLATIONS, lang, "README.md");
    const content  = fs.readFileSync(filePath, "utf8");
    const toolCount = (content.match(/^\| `\w/gm) || []).length;

    if (toolCount !== enToolCount) {
      warnings.push(`[${lang}] tool count mismatch: has ${toolCount}, EN has ${enToolCount}`);
    }
    if (enHasBadges && !content.includes("shields.io")) {
      warnings.push(`[${lang}] missing shields.io badges`);
    }
    if (enHasSocket && !content.includes("socket.dev/api/badge")) {
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
