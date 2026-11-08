import { createHash } from 'node:crypto';

import {
  CAPPED_SECTIONS,
  CONTEXT_SECTION,
  NEXT_SECTION,
  RETIRED_KEY,
  RETIRED_TTL_MS,
  SECTION_ORDER,
  dedupeEntries,
  entryHash,
  formatRetired,
  headerValue,
  parseRetired,
  parseStateDocument,
  serializeStateDocument,
  settleRetired,
  updatedTime,
  withHeaderValue,
} from '../state-doc';
import type { RetiredMark, StateDocument, StateSections } from '../state-doc';

// Two copies of one state document, written on two machines between two
// syncs, become one document section by section, following the merge
// semantics of the AMI specification (section 5) for two peers: the newer
// copy leads, the entries only the older copy has are woven in where that
// copy kept them, the caps hold after the union, the newer context and the
// newer Next Session win, and an entry one side retired stays out of the
// result while the retirement is at least as new as the copy that still
// carries it. Either order of the two copies gives the same document, and a
// document merged with itself, or with a copy it already contains, is
// unchanged.

type Side = { text: string; doc: StateDocument; time: number; marks: RetiredMark[] };

const CORE_HEADINGS = SECTION_ORDER.map(heading => new RegExp(`^## ${heading}\\s*$`, 'm'));

function side(content: string): Side {
  const doc = parseStateDocument(content);
  return { text: content, doc, time: updatedTime(doc), marks: parseRetired(headerValue(doc, RETIRED_KEY)) };
}

// A document is merged by section only when it has the five sections the
// merge knows; anything else (a note, a partial file, a document of a version
// before the sections) has nothing to merge by and is kept whole.
export function hasCoreSections(content: string): boolean {
  return CORE_HEADINGS.every(heading => heading.test(content));
}

// The text a document takes after a read and a write by this module: itself
// when it is not merged by section, its serialized form otherwise.
export function canonicalForm(content: string): string {
  return hasCoreSections(content) ? serializeStateDocument(parseStateDocument(content)) : content;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function entryCount(doc: StateDocument): number {
  return CAPPED_SECTIONS.reduce((total, { heading }) => total + dedupeEntries(doc.sections[heading] || []).length, 0);
}

// The newer copy leads. Of two copies of the same time, the one with more
// entries leads, so the result of a merge (never smaller than its inputs)
// leads over the copies it came from; the hash of their text decides the
// rest, so the arguments can come in either order.
function ordered(a: string, b: string): [Side, Side] {
  const first = side(a);
  const second = side(b);
  if (first.time !== second.time) return first.time > second.time ? [first, second] : [second, first];
  const firstCount = entryCount(first.doc);
  const secondCount = entryCount(second.doc);
  if (firstCount !== secondCount) return firstCount > secondCount ? [first, second] : [second, first];
  return digest(a) <= digest(b) ? [first, second] : [second, first];
}

// The entries of one copy that no mark retired at or after the time of that
// copy: a mark newer than the copy means the entry left the document after
// the copy was written, and the copy is stale about it.
function living(entries: readonly string[], time: number, marks: readonly RetiredMark[]): string[] {
  return entries.filter(entry => {
    const hash = entryHash(entry);
    return !marks.some(mark => mark.hash === hash && Date.parse(mark.at) >= time);
  });
}

// The newer list in its own order, with each entry only the older list has
// placed right before the first entry that follows it there and is in the
// newer list too, or at the end when none follows: what one machine added
// keeps its place among the entries both have.
function weave(newer: readonly string[], older: readonly string[]): string[] {
  const inNewer = new Set(newer);
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const entry of older) {
    if (!inNewer.has(entry)) {
      pending.push(entry);
    } else if (pending.length > 0) {
      before.set(entry, [...(before.get(entry) || []), ...pending]);
      pending = [];
    }
  }
  const woven: string[] = [];
  for (const entry of newer) woven.push(...(before.get(entry) || []), entry);
  return dedupeEntries([...woven, ...pending]);
}

function mergeList(newer: Side, older: Side, heading: string, marks: readonly RetiredMark[]): string[] {
  const fromNewer = living(dedupeEntries(newer.doc.sections[heading] || []), newer.time, marks);
  const fromOlder = living(dedupeEntries(older.doc.sections[heading] || []), older.time, marks);
  return weave(fromNewer, fromOlder);
}

// `now` is the moment of the merge: an entry the caps drop here is retired at
// that moment, not at the time of a copy that may be weeks old, so the mark
// outlives every stale copy by the whole window.
export function mergeStateDocuments(a: string, b: string, now: Date = new Date()): string {
  if (a === b) return a;
  const [newer, older] = ordered(a, b);
  // A copy without the five sections has nothing to merge by, and nothing in
  // it may be lost to the layout: the newer copy stands, whole, as before.
  if (!hasCoreSections(newer.text) || !hasCoreSections(older.text)) return newer.text;
  // A mark older than the window has expired and keeps nothing out, in this
  // merge as in the next.
  const window = now.getTime() - RETIRED_TTL_MS;
  const marks = [...newer.marks, ...older.marks].filter(mark => Date.parse(mark.at) >= window);
  const sections: StateSections = Object.create(null) as StateSections;
  const dropped: string[] = [];
  const present: string[] = [];
  for (const { heading, cap } of CAPPED_SECTIONS) {
    const union = mergeList(newer, older, heading, marks);
    sections[heading] = union.slice(0, cap);
    dropped.push(...union.slice(cap));
    present.push(...sections[heading]);
  }
  const newerContext = newer.doc.sections[CONTEXT_SECTION] || [];
  sections[CONTEXT_SECTION] = [...(newerContext.length > 0 ? newerContext : older.doc.sections[CONTEXT_SECTION] || [])];
  sections[NEXT_SECTION] = [...(newer.doc.sections[NEXT_SECTION] || [])];
  // A section the merge does not know travels with the leading copy, as it is.
  for (const heading of Object.keys(newer.doc.sections)) {
    if (!SECTION_ORDER.includes(heading)) sections[heading] = [...newer.doc.sections[heading]];
  }
  const retired = settleRetired(marks, { retired: dropped, present, at: now.toISOString() });
  const header = withHeaderValue(newer.doc.header, RETIRED_KEY, retired.length > 0 ? formatRetired(retired) : null);
  return serializeStateDocument({ header, sections });
}
