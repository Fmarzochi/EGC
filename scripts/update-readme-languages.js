#!/usr/bin/env node
"use strict";

const fs   = require("fs");
const path = require("path");

const LANGUAGE_NAMES = {
  pt: "Português do Brasil",
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

const ROOT              = path.join(__dirname, "..");
const TRANSLATIONS_DIR  = path.join(ROOT, "translations");
const README_PATH       = path.join(ROOT, "README.md");
const SELECTOR_START    = "<!-- LANGUAGE-SELECTOR-START -->";
const SELECTOR_END      = "<!-- LANGUAGE-SELECTOR-END -->";

function getAvailableLanguages() {
  if (!fs.existsSync(TRANSLATIONS_DIR)) return [];

  return fs
    .readdirSync(TRANSLATIONS_DIR)
    .filter((code) => {
      const readmePath = path.join(TRANSLATIONS_DIR, code, "README.md");
      return fs.statSync(path.join(TRANSLATIONS_DIR, code)).isDirectory()
        && fs.existsSync(readmePath);
    })
    .sort();
}

function buildSelector(langs) {
  const langLinks = langs.map((code) => {
    const name = LANGUAGE_NAMES[code] || code.toUpperCase();
    return `  <a href="translations/${code}/README.md">${name}</a>`;
  });

  const englishLink = `  <a href="README.md"><b>English</b></a>`;
  const allLinks    = [englishLink, ...langLinks];
  const linksLine   = allLinks.join(" |\n");

  return [
    SELECTOR_START,
    '<div align="center">',
    "  <b>Language / Idioma</b>",
    "  <br/>",
    linksLine,
    "</div>",
    SELECTOR_END,
  ].join("\n");
}

function updateReadme() {
  const readme = fs.readFileSync(README_PATH, "utf8");

  const startIdx = readme.indexOf(SELECTOR_START);
  const endIdx   = readme.indexOf(SELECTOR_END);

  if (startIdx === -1 || endIdx === -1) {
    console.error("Language selector sentinels not found in README.md");
    process.exit(1);
  }

  const langs       = getAvailableLanguages();
  const newSelector = buildSelector(langs);
  const updated     = readme.slice(0, startIdx)
    + newSelector
    + readme.slice(endIdx + SELECTOR_END.length);

  if (updated === readme) {
    console.log("Language selector already up to date.");
    return;
  }

  fs.writeFileSync(README_PATH, updated, "utf8");
  console.log(`Language selector updated with ${langs.length} language(s): ${langs.join(", ")}`);
}

updateReadme();
