import { createHash } from 'node:crypto';

import {
  CAPPED_SECTIONS,
  CONTEXT_SECTION,
  NEXT_SECTION,
  RETIRED_KEY,
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

const HAS_SECTION = /^## /m;

function side(content: string): Side {
  const doc = parseStateDocument(content);
  return { text: content, doc, time: updatedTime(doc), marks: parseRetired(headerValue(doc, RETIRED_KEY)) };
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// The newer copy leads; two copies of the same time are ordered by the hash
// of their text, so the arguments can come in either order.
function ordered(a: string, b: string): [Side, Side] {
  const first = side(a);
  const second = side(b);
  if (first.time !== second.time) return first.time > second.time ? [first, second] : [second, first];
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

export function mergeStateDocuments(a: string, b: string): string {
  const [newer, older] = ordered(a, b);
  // A copy with no section at all has nothing to merge by, and nothing in it
  // may be lost to the layout: the newer copy stands, whole, as before.
  if (!HAS_SECTION.test(newer.text) || !HAS_SECTION.test(older.text)) return newer.text;
  const marks = [...newer.marks, ...older.marks];
  const sections: StateSections = {};
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
  const at = headerValue(newer.doc, 'updated') || new Date(newer.time).toISOString();
  const retired = settleRetired(marks, { retired: dropped, present, at });
  const header = withHeaderValue(newer.doc.header, RETIRED_KEY, retired.length > 0 ? formatRetired(retired) : null);
  return serializeStateDocument({ header, sections });
}
