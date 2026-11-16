'use strict';

// The merge of docs/spec/agent-memory-interchange.md (section 5) for the CLI:
// the rules the memory server applies in state-doc.ts on update_state, in
// JavaScript so egc import needs no server build. The entries a document
// brings go first, one copy of each text, capped per section; the Context is
// replaced when the document carries one; Next Session is rewritten when the
// document carries the section; what the cap pushes out is retired at the time
// of the write, an entry that comes back while its retirement is held is
// restored, and a retirement newer than the document keeps its entry out
// (section 4.1 and 5.1).

const crypto = require('node:crypto');

const CONTEXT_SECTION = 'Context';
const NEXT_SECTION = 'Next Session';
const CAPPED_SECTIONS = [
  { heading: 'Active Decisions', cap: 15 },
  { heading: 'Do Not Repeat', cap: 10 },
  { heading: 'Preferences', cap: 15 },
];
const SECTION_ORDER = [CONTEXT_SECTION, ...CAPPED_SECTIONS.map(section => section.heading), NEXT_SECTION];
// A retired mark outlives the copies that may still carry the entry; the cap
// bounds the header line whatever the churn (the same numbers as the server).
const RETIRED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_CAP = 40;
const ENTRY_HASH_LENGTH = 12;
const RETIRED_MARK = /^([0-9a-f]{12})([@+])(\S+)$/;

function dedupeEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const raw of entries || []) {
    const entry = String(raw).trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function entryHash(entry) {
  return crypto.createHash('sha256').update(String(entry).trim(), 'utf8').digest('hex').slice(0, ENTRY_HASH_LENGTH);
}

function parseRetired(value) {
  if (!value) return [];
  const marks = [];
  for (const token of String(value).split(/\s+/)) {
    const match = RETIRED_MARK.exec(token);
    if (match && !Number.isNaN(Date.parse(match[3]))) {
      marks.push({ hash: match[1], at: match[3], kind: match[2] === '@' ? 'retired' : 'restored' });
    }
  }
  return marks;
}

function formatRetired(marks) {
  return marks.map(mark => `${mark.hash}${mark.kind === 'retired' ? '@' : '+'}${mark.at}`).join(' ');
}

// Of two marks for one entry the newer stands; at the same time a restoration
// stands over a retirement, since adding is the deliberate act.
function newerMark(left, right) {
  const leftTime = Date.parse(left.at);
  const rightTime = Date.parse(right.at);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return left.kind === 'restored' ? left : right;
}

function newestMarks(marks) {
  const byHash = new Map();
  for (const mark of marks) {
    const known = byHash.get(mark.hash);
    byHash.set(mark.hash, known ? newerMark(known, mark) : mark);
  }
  return byHash;
}

// The marks after a write at `at`: a retirement per entry that left, a
// restoration per entry that came back, one mark per entry (the newest), the
// ones older than the window dropped, newest first, capped.
function settleRetired(marks, { retired, restored, at }) {
  const all = [...marks];
  for (const entry of retired) all.push({ hash: entryHash(entry), at, kind: 'retired' });
  for (const entry of restored) all.push({ hash: entryHash(entry), at, kind: 'restored' });
  const now = Date.parse(at);
  const floor = Number.isNaN(now) ? Number.NEGATIVE_INFINITY : now - RETIRED_TTL_MS;
  return [...newestMarks(all).values()]
    .filter(mark => Date.parse(mark.at) >= floor)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.hash.localeCompare(right.hash))
    .slice(0, RETIRED_CAP);
}

function hasSection(sections, heading) {
  return Boolean(sections) && Object.hasOwn(sections, heading);
}

function extraHeadings(sections) {
  return Object.keys(sections || {}).filter(heading => !SECTION_ORDER.includes(heading));
}

// A retirement newer than the document keeps the entry out: the copy that
// carries it was written before the entry left. A document without a readable
// `updated` is read as written now, a deliberate import.
function keptIncoming(entries, newest, documentTime) {
  return entries.filter(entry => {
    const mark = newest.get(entryHash(entry));
    return !(mark && mark.kind === 'retired' && Date.parse(mark.at) > documentTime);
  });
}

/**
 * The sections and the retired line after an import.
 *
 * @param {object} args
 * @param {{ header: object, sections: object } | null} args.current The memory as it is, or null.
 * @param {{ header: object, sections: object }} args.imported The document being imported.
 * @param {'merge' | 'replace'} args.mode Section 5 merge, or the document in place of the memory.
 * @param {string} args.now The ISO 8601 time of the write.
 * @returns {{ sections: object, retired: string | undefined }}
 */
function mergeDocuments({ current, imported, mode, now }) {
  const have = current ? current.sections : {};
  const marks = [...parseRetired(current && current.header.retired), ...parseRetired(imported.header.retired)];
  const nowTime = Date.parse(now);
  const window = Number.isNaN(nowTime) ? Number.NEGATIVE_INFINITY : nowTime - RETIRED_TTL_MS;
  const newest = newestMarks(marks.filter(mark => Date.parse(mark.at) >= window));
  const parsedDocumentTime = Date.parse(imported.header.updated || '');
  const documentTime = Number.isNaN(parsedDocumentTime) ? nowTime : parsedDocumentTime;

  const sections = {};
  const left = [];
  const restored = [];
  for (const { heading, cap } of CAPPED_SECTIONS) {
    const incoming = keptIncoming(dedupeEntries(imported.sections[heading]), newest, documentTime);
    const existing = dedupeEntries(have[heading]);
    const union = mode === 'replace' ? incoming : dedupeEntries([...incoming, ...existing]);
    const merged = union.slice(0, cap);
    sections[heading] = merged;
    const kept = new Set(merged);
    // Everything the cap left out is retired, and so is every entry the memory
    // held that a replacement drops: a copy elsewhere may carry them, and they
    // must not come back from there.
    left.push(...union.slice(cap), ...existing.filter(entry => !kept.has(entry)));
    // Only an entry the document brings is a return.
    restored.push(...incoming.filter(entry => kept.has(entry) && newest.get(entryHash(entry))?.kind === 'retired'));
  }

  const incomingContext = dedupeEntries(imported.sections[CONTEXT_SECTION]);
  sections[CONTEXT_SECTION] = incomingContext.length > 0 ? incomingContext : dedupeEntries(have[CONTEXT_SECTION]);
  const nextFromDocument = mode === 'replace' || hasSection(imported.sections, NEXT_SECTION);
  sections[NEXT_SECTION] = dedupeEntries(nextFromDocument ? imported.sections[NEXT_SECTION] : have[NEXT_SECTION]);

  const extras = mode === 'replace' ? extraHeadings(imported.sections) : [...new Set([...extraHeadings(have), ...extraHeadings(imported.sections)])];
  for (const heading of extras) {
    sections[heading] = mode === 'replace' || !hasSection(have, heading)
      ? dedupeEntries(imported.sections[heading])
      : dedupeEntries(have[heading]);
  }

  const retired = settleRetired(marks, { retired: left, restored, at: now });
  return { sections, retired: retired.length > 0 ? formatRetired(retired) : undefined };
}

module.exports = {
  CAPPED_SECTIONS,
  CONTEXT_SECTION,
  NEXT_SECTION,
  SECTION_ORDER,
  RETIRED_TTL_MS,
  RETIRED_CAP,
  dedupeEntries,
  entryHash,
  parseRetired,
  formatRetired,
  newestMarks,
  settleRetired,
  mergeDocuments,
};
