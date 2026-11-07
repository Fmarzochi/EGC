import { createHash } from 'node:crypto';

// The state document the memory server reads and writes, the AMI document of
// docs/spec/agent-memory-interchange.md: a title, a header of `key: value`
// lines and five H2 sections. One parser and one serializer serve update_state
// and the team sync merge, so both agree on every byte of a document.

export const TITLE = '# Project State';
export const CONTEXT_SECTION = 'Context';
export const NEXT_SECTION = 'Next Session';
export const CAPPED_SECTIONS: ReadonlyArray<{ heading: string; cap: number }> = [
  { heading: 'Active Decisions', cap: 15 },
  { heading: 'Do Not Repeat', cap: 10 },
  { heading: 'Preferences', cap: 15 },
];
export const SECTION_ORDER: readonly string[] = [CONTEXT_SECTION, ...CAPPED_SECTIONS.map(section => section.heading), NEXT_SECTION];
export const RETIRED_KEY = 'retired';
// A retired mark outlives the copies that may still carry the entry: thirty
// days covers a machine that stayed off for a month, and the cap bounds the
// header line whatever the churn.
export const RETIRED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RETIRED_CAP = 40;
const ENTRY_HASH_LENGTH = 12;
const H2 = /^## (.+)/;
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/;
const RETIRED_MARK = /^([0-9a-f]{12})@(\S+)$/;

export type HeaderField = { key: string; value: string };
export type StateSections = Record<string, string[]>;
export type StateDocument = { header: HeaderField[]; sections: StateSections };
export type RetiredMark = { hash: string; at: string };
export type StateEntry = { what: string; why?: string };
export type StateUpdate = {
  projectPath: string;
  branch: string | null;
  author: string;
  updated: string;
  context?: string;
  decisions?: StateEntry[];
  avoid?: StateEntry[];
  preferences?: string[];
  next?: string[];
};

function emptySections(): StateSections {
  const sections: StateSections = {};
  for (const heading of SECTION_ORDER) sections[heading] = [];
  return sections;
}

// Header lines are read until the first section; inside a section every
// non-empty line that is not a heading is one entry, its `- ` dropped, and
// the context paragraph is its lines.
export function parseStateDocument(content: string): StateDocument {
  const header: HeaderField[] = [];
  const sections = emptySections();
  let current: string | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const h2 = H2.exec(line);
    if (h2) {
      current = h2[1].trim();
      sections[current] ??= [];
      continue;
    }
    if (current === null) {
      const field = HEADER_LINE.exec(line);
      if (field) header.push({ key: field[1], value: field[2].trim() });
      continue;
    }
    if (!line.trim() || line.startsWith('#')) continue;
    sections[current].push(line.startsWith('- ') ? line.slice(2).trim() : line.trim());
  }
  return { header, sections };
}

export function headerValue(doc: StateDocument, key: string): string | undefined {
  return doc.header.find(field => field.key === key)?.value;
}

// The header with `key` set to `value`, in place when it exists and at the
// end when it is new; a null or empty value removes the field.
export function withHeaderValue(header: readonly HeaderField[], key: string, value: string | null): HeaderField[] {
  if (!value) return header.filter(field => field.key !== key);
  const index = header.findIndex(field => field.key === key);
  if (index === -1) return [...header, { key, value }];
  return header.map((field, i) => (i === index ? { key, value } : field));
}

export function contextOf(doc: StateDocument): string {
  return (doc.sections[CONTEXT_SECTION] || []).join('\n');
}

// The time of the `updated:` line, 0 when it is missing or unreadable.
export function updatedTime(doc: StateDocument): number {
  const value = headerValue(doc, 'updated');
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

export function serializeStateDocument(doc: StateDocument): string {
  const lines = [TITLE, ...doc.header.map(field => `${field.key}: ${field.value}`), ''];
  const extra = Object.keys(doc.sections).filter(heading => !SECTION_ORDER.includes(heading));
  for (const heading of [...SECTION_ORDER, ...extra]) {
    const entries = doc.sections[heading] || [];
    lines.push(`## ${heading}`, ...(heading === CONTEXT_SECTION ? entries : entries.map(entry => `- ${entry}`)), '');
  }
  return lines.join('\n');
}

// The document as it is shown to a reader: the retired marks are bookkeeping
// for the merge, not memory, so the line stays in the file and out of view.
export function withoutRetiredLine(content: string): string {
  const lines = content.split('\n');
  const firstSection = lines.findIndex(line => H2.test(line));
  const headerEnd = firstSection === -1 ? lines.length : firstSection;
  const kept = lines.filter((line, index) => index >= headerEnd || !line.startsWith(`${RETIRED_KEY}:`));
  return kept.join('\n');
}

export function dedupeEntries(entries: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function entryHash(entry: string): string {
  return createHash('sha256').update(entry.trim(), 'utf8').digest('hex').slice(0, ENTRY_HASH_LENGTH);
}

export function parseRetired(value: string | undefined): RetiredMark[] {
  if (!value) return [];
  const marks: RetiredMark[] = [];
  for (const token of value.split(/\s+/)) {
    const match = RETIRED_MARK.exec(token);
    if (match && !Number.isNaN(Date.parse(match[2]))) marks.push({ hash: match[1], at: match[2] });
  }
  return marks;
}

export function formatRetired(marks: readonly RetiredMark[]): string {
  return marks.map(mark => `${mark.hash}@${mark.at}`).join(' ');
}

// The retired list after a write or a merge at `at`: an entry that left the
// document gains a mark, an entry that is present loses its mark (it was
// added again), marks older than the window expire, one mark per entry with
// its newest time, newest first, capped.
export function settleRetired(marks: readonly RetiredMark[], change: { retired: Iterable<string>; present: Iterable<string>; at: string }): RetiredMark[] {
  const byHash = new Map<string, RetiredMark>();
  const consider = (mark: RetiredMark) => {
    const known = byHash.get(mark.hash);
    if (!known || Date.parse(mark.at) > Date.parse(known.at)) byHash.set(mark.hash, mark);
  };
  for (const mark of marks) consider(mark);
  for (const entry of change.retired) consider({ hash: entryHash(entry), at: change.at });
  for (const entry of change.present) byHash.delete(entryHash(entry));
  const now = Date.parse(change.at);
  const floor = Number.isNaN(now) ? Number.NEGATIVE_INFINITY : now - RETIRED_TTL_MS;
  return [...byHash.values()]
    .filter(mark => Date.parse(mark.at) >= floor)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.hash.localeCompare(right.hash))
    .slice(0, RETIRED_CAP);
}

// One entry is one line: a line break inside a text would read back as two
// entries, or as a heading, so it becomes a space.
function oneLine(text: string): string {
  return text.split(/[\r\n]+/).map(piece => piece.trim()).filter(Boolean).join(' ');
}

function formatEntry(entry: StateEntry): string {
  return oneLine(entry.why ? `${entry.what}: ${entry.why}` : entry.what);
}

// The document after an update_state: the incoming entries go first, then
// the existing ones, one copy of each text, capped per section (AMI, section
// 5); the context is replaced when the update carries one; Next Session is
// rewritten; what the cap pushed out is retired at the time of the write and
// an entry written again loses its mark.
export function buildStateDocument(update: StateUpdate, existing: StateDocument): StateDocument {
  const incoming: Record<string, string[]> = {
    'Active Decisions': (update.decisions || []).map(formatEntry),
    'Do Not Repeat': (update.avoid || []).map(formatEntry),
    'Preferences': (update.preferences || []).map(oneLine),
  };
  const sections = emptySections();
  const left: string[] = [];
  const present: string[] = [];
  for (const { heading, cap } of CAPPED_SECTIONS) {
    const before = dedupeEntries(existing.sections[heading] || []);
    const merged = dedupeEntries([...incoming[heading], ...before]).slice(0, cap);
    const kept = new Set(merged);
    sections[heading] = merged;
    left.push(...before.filter(entry => !kept.has(entry)));
    present.push(...merged);
  }
  const context = update.context || contextOf(existing);
  sections[CONTEXT_SECTION] = context ? context.split('\n') : [];
  sections[NEXT_SECTION] = (update.next || []).map(entry => entry.trim()).filter(Boolean);
  const retired = settleRetired(parseRetired(headerValue(existing, RETIRED_KEY)), { retired: left, present, at: update.updated });
  const header: HeaderField[] = [{ key: 'project', value: update.projectPath }];
  if (update.branch) header.push({ key: 'branch', value: update.branch });
  header.push({ key: 'author', value: update.author }, { key: 'updated', value: update.updated });
  if (retired.length > 0) header.push({ key: RETIRED_KEY, value: formatRetired(retired) });
  return { header, sections };
}
