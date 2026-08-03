#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'mcp', 'servers', 'egc-guardian', 'src', 'catalog-index.ts');

// YAML block scalar (key: > / >- / | / |-): the value is the indented block
// that follows, not the indicator. Folds it into one spaced line, returning
// the index of the first line after the block.
function foldBlockScalar(lines, startIndex) {
  const block = [];
  let j = startIndex;
  while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
    block.push(lines[j].trim());
    j++;
  }
  return { value: block.join(' ').replace(/\s+/g, ' ').trim(), nextIndex: j };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Indented lines belong to a block scalar already consumed below.
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawVal = line.slice(colon + 1).trim();
    let val;
    // A plain split-on-colon parser stored just ">-", corrupting these; a
    // real YAML loader instead chokes on the many descriptions that carry an
    // unquoted inline ":" ("... for Android and KMP: structured ..."), so we
    // keep splitting on the first colon and only special-case block scalars.
    if (/^[>|][+-]?$/.test(rawVal)) {
      const folded = foldBlockScalar(lines, i + 1);
      val = folded.value;
      i = folded.nextIndex - 1;
    } else {
      val = rawVal.replace(/^["']|["']$/g, '');
    }
    if (key && val) fm[key] = val;
  }
  return fm;
}

// Skills are canonically skills/<category>/<name>/SKILL.md (or the flatter
// skills/<name>/SKILL.md). Only SKILL.md defines a skill; other .md files
// living under a skill (reference docs, sub-agents) must not be indexed as
// top-level skills, which is what inflated the catalog past the real count.
// A category directory (e.g. skills/dev/) holds one level of nested skill
// dirs, each optionally containing its own SKILL.md.
function listNestedSkillMd(categoryDir) {
  let children;
  try {
    children = fs.readdirSync(categoryDir, { withFileTypes: true });
  } catch (_) { // NOSONAR
    return [];
  }
  const results = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const skillMd = path.join(categoryDir, child.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) results.push(skillMd);
  }
  return results;
}

function listSkillMd(skillsRoot) {
  let top;
  try {
    top = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch (_) { // NOSONAR
    return [];
  }
  const results = [];
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsRoot, entry.name);
    const flatSkillMd = path.join(dir, 'SKILL.md');
    if (fs.existsSync(flatSkillMd)) {
      results.push(flatSkillMd);
      continue;
    }
    results.push(...listNestedSkillMd(dir));
  }
  return results;
}

// Agents are flat agents/<name>.md files, so every .md is an agent definition.
function walkMd(dir, results = []) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkMd(full, results);
      else if (entry.name.endsWith('.md')) results.push(full);
    }
  } catch (_) { /* ignore: unreadable dir safely leaves the index as best-effort */ } // NOSONAR
  return results;
}

const entries = [];

for (const f of listSkillMd(path.join(root, 'skills'))) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    if (fm?.name && fm?.description) {
      entries.push({ kind: 'skill', name: String(fm.name), description: String(fm.description) });
    }
  } catch (_) { /* ignore: unreadable file is safely skipped */ } // NOSONAR
}

for (const f of walkMd(path.join(root, 'agents'))) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    if (fm?.name && fm?.description) {
      entries.push({ kind: 'agent', name: String(fm.name), description: String(fm.description) });
    }
  } catch (_) { /* ignore: unreadable file is safely skipped */ } // NOSONAR
}

const rulesRoot = path.join(root, 'rules');
for (const f of walkMd(rulesRoot)) {
  try {
    if (path.basename(f) === 'README.md') continue;
    const content = fs.readFileSync(f, 'utf8');
    const h1 = content.match(/^#\s+(.+)$/m); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
    if (!h1) continue;
    const rel = path.relative(rulesRoot, f);
    const name = rel.replace(/[\\/]/g, '-').replace(/\.md$/, '').toLowerCase();
    entries.push({ kind: 'rule', name, description: h1[1].trim() });
  } catch (_) { /* ignore: unreadable file is safely skipped */ } // NOSONAR
}

const out = `// AUTO-GENERATED by scripts/build-skill-index.js -- do not edit manually
export const CATALOG: ReadonlyArray<{ kind: 'agent' | 'skill' | 'rule'; name: string; description: string }> = ${JSON.stringify(entries, null, 2)};
`;

fs.writeFileSync(outFile, out, 'utf8');

// JSON twin of the catalog for plain-JS consumers: the prompt-router hook
// reads it to offer in-session routing without depending on the guardian
// build. Lives in scripts/lib so the hooks-runtime module installs it
// alongside the hook libs.
const jsonOutFile = path.join(root, 'scripts', 'lib', 'skill-index.json');
fs.writeFileSync(jsonOutFile, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');

process.stderr.write(`build-skill-index: ${entries.length} entries written to catalog-index.ts and skill-index.json\n`);
