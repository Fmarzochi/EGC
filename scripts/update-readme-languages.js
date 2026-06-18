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
  fa: "فارסی",
  bn: "বাংলা",
  ms: "Bahasa Melayu",
  ca: "Català",
};

const ROOT           = path.join(__dirname, "..");
const TRANSLATIONS   = path.join(ROOT, "translations");
const README_PATH    = path.join(ROOT, "README.md");
const TOP_START      = "<!-- LANGUAGE-SELECTOR-START -->";
const TOP_END        = "<!-- LANGUAGE-SELECTOR-END -->";
const CENTER_START   = "<!-- CENTERED-LANGUAGE-SELECTOR-START -->";
const CENTER_END     = "<!-- CENTERED-LANGUAGE-SELECTOR-END -->";

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
  const title = `**Language**`;
  const links      = [
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

function updateReadme() {
  const readme = fs.readFileSync(README_PATH, "utf8");
  const langs  = getAvailableLanguages();

  const updated = replaceBlock(
    replaceBlock(readme, TOP_START, TOP_END, buildTopSelector(langs)),
    CENTER_START,
    CENTER_END,
    buildCenteredSelector(langs)
  );

  if (updated === readme) {
    console.log("Language selectors already up to date.");
    return;
  }

  fs.writeFileSync(README_PATH, updated, "utf8");
  console.log(`Language selectors updated with ${langs.length} language(s): ${langs.join(", ")}`);
}

updateReadme();
