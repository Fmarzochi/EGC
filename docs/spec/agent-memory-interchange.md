# Agent Memory Interchange (AMI) Specification

Status: Draft v0.1 (not yet published)
Editor: Felipe Marzochi
Reference implementation: EGC (Extended Global Context), `egc-memory` MCP server

## 1. Purpose

AI coding agents accumulate project memory: decisions made, approaches that failed, user preferences, and what to pick up next. Today each tool stores that memory in a proprietary shape, locked to one vendor, one harness, one machine. Switching tools, or running two tools side by side, means starting from zero.

Agent Memory Interchange (AMI) is an open, plain-text format for portable AI agent memory. Any agent, IDE, CLI, or harness that reads and writes AMI documents shares the same brain: memory written by one tool is immediately usable by every other.

This specification documents the format already shipping in production in EGC. It is intentionally small: one Markdown document per memory scope, five sections, deterministic merge rules.

### 1.1 What AMI is not

- Not a database or wire protocol. AMI defines a document, not a transport.
- Not a conversation log. AMI stores distilled state, not transcripts.
- Not vendor configuration. Tool-specific settings stay in tool-specific files.

## 2. Terminology

- **Memory Document**: a single AMI Markdown file holding the memory of one scope.
- **Scope**: the identity a document belongs to. AMI defines three: project, branch, and global (user-wide).
- **Section**: one of the five named H2 blocks inside a document.
- **Entry**: one list item inside a section.
- **Producer**: software that writes AMI documents.
- **Consumer**: software that reads them.

The key words MUST, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## 3. Data model

A Memory Document is identified by:

1. **project**: the absolute path of the project root on the machine that produced it, informative for consumers on other machines; across machines a project is identified by its repository, as section 4.1 defines, or by its path when it has no repository remote.
2. **branch** (optional): the version-control branch the memory belongs to. When present, the document carries branch-scoped memory; when absent, project-scoped.
3. **global scope**: a document not tied to any project, holding user-wide preferences and lessons. Consumers MUST give project and branch entries precedence over global entries when both apply.

How documents are laid out on disk is an implementation concern. The reference implementation stores one file per project and branch under a private state directory, encrypted at rest; encryption and file naming are outside this specification. The interchange unit is always the decrypted plain-text document.

## 4. Document format

An AMI document is UTF-8 Markdown with the following fixed structure.

### 4.1 Header

The first line MUST be the H1 title `# Project State`. It is followed by a block of `key: value` lines:

```
# Project State
project: /home/dev/projects/example
branch: main
author: dev
updated: 2026-01-15T12:00:00.000Z
```

- `project` (REQUIRED for project-scoped and branch-scoped documents, omitted for global-scope documents): absolute project path as seen by the producer.
- `branch` (OPTIONAL): branch name; omitted for project-scoped and global documents.
- `author` (REQUIRED): the OS user or agent identity that produced the update.
- `updated` (REQUIRED): ISO 8601 timestamp of the last write.

Consumers MUST ignore header keys they do not recognize; producers MAY add keys, but the four above are the interoperable core.

- `retired` (OPTIONAL, written by the reference implementation): space-separated marks about entries that left the document. `<hash>@<time>` is a retirement: the entry left at `<time>`. `<hash>+<time>` is a restoration: a producer that held the retirement added the entry again at `<time>`. `<hash>` is the first 12 hexadecimal characters of the SHA-256 of the entry text (trimmed, without its `- `) and `<time>` the ISO 8601 moment of the write, or of the merge, that dropped or restored it. The list is bookkeeping for the merge of two copies (section 5.1), not memory: a consumer that presents a document to a reader SHOULD omit the line, and a producer that rewrites a document MUST carry the marks over, add a retirement for each entry it drops, add a restoration for an entry it writes while holding its retirement, keep one mark per entry (the newest; at the same time, the restoration), and keep the list bounded (the reference implementation expires a mark after thirty days and keeps at most forty, newest first).

`project` is a hint for a human reader, not the identity of the project: the same repository sits at different paths on different machines. The reference implementation keys the storage of a document, and the name it travels under between machines, by the repository itself: the URL of its `origin` remote, normalized (scheme and credentials dropped, host lowercased with its port only when it is not the default of its scheme, trailing `/` and `.git` removed, owner and name as written), hashed with SHA-256 and prefixed by the repository name. A directory without a remote, or a checkout outside the roots the implementation trusts for reading git metadata, is keyed by a slug of its path. A consumer that holds the checkouts it serves, and so can derive that identity, MUST match documents across machines by it and never by `project`; a consumer that holds only the document has no identity to compare and MUST NOT take `project` for one.

### 4.2 Sections

Five H2 sections follow, in this order:

| Section | Content | Shape |
|---------|---------|-------|
| `## Context` | What the project is and its current phase | One paragraph |
| `## Active Decisions` | Decisions currently in force | Bullet list |
| `## Do Not Repeat` | Approaches that failed or were rejected | Bullet list |
| `## Preferences` | Coding style and workflow preferences | Bullet list |
| `## Next Session` | What to pick up next | Bullet list |

List entries use the form:

```
- <what>: <why>
```

The `: <why>` suffix is RECOMMENDED for `Active Decisions` and `Do Not Repeat` (a decision without its reason loses most of its value) and OPTIONAL elsewhere.

A consumer parsing a document MUST treat any line starting with `- ` inside a section as one entry, and non-empty non-heading lines inside `## Context` as the context paragraph. Unknown H2 sections MAY be preserved but are not part of the interchange core.

## 5. Merge semantics

AMI updates are merges, never blind overwrites. Given an existing document and an incoming update, a producer MUST apply:

1. **Context**: the incoming context replaces the existing one; if the update carries no context, the existing paragraph is preserved.
2. **Active Decisions, Do Not Repeat, Preferences**: incoming entries are prepended (newest first), followed by the existing entries. The merged list is then capped: 15 entries for Active Decisions, 10 for Do Not Repeat, 15 for Preferences. Entries pushed past the cap age out.
3. **Next Session**: replaced entirely by the incoming list. It describes the immediate future and is rewritten on every update; an empty incoming list empties the section.

These rules make updates idempotent in spirit: repeated writes converge, recent knowledge wins, and stale tail entries retire naturally.

### 5.1 Two copies of one document

When two producers hold copies of the same document written apart (two machines between two syncs), neither copy is an update of the other, and a merge of the two MUST keep what each added:

1. The copy with the later `updated` leads; two copies of the same time are ordered by their number of entries in Active Decisions, Do Not Repeat and Preferences together (one per text), the fuller first, and then by the SHA-256 of their text, so the result does not depend on which side merges and the result of a merge leads over the copies it came from.
2. **Context**: the paragraph of the leading copy; when it is empty, the paragraph of the other.
3. **Active Decisions, Do Not Repeat, Preferences**: the union of both copies, one entry per text. The leading copy keeps its order; an entry only the other copy has is placed right before the first entry that follows it in that copy and is in the leading copy too, or at the end when none follows. The caps of section 5 apply after the union, and each entry they push out is retired at the moment of the merge (header `retired`, section 4.1).
4. An entry whose newest mark, across both copies, is a retirement is left out, whatever the `updated` of the copy that carries it; a restoration newer than the retirement lets it in. Marks of both copies are carried over, the newest per entry, bounded as section 4.1 says.
5. **Next Session**: the list of the leading copy, whole.
6. The header of the result is the header of the leading copy, with `retired` recomputed; a section the merge does not know travels with the leading copy as it is.

Merging A with B and B with A at the same moment MUST give the same document. Merging a document with an identical copy MUST return it unchanged, and merging it with a copy it already contains MUST leave its content unchanged (the layout MAY become the canonical one; two copies of the same time that hold the same entries in another order MAY be reordered once, to the order of the copy the tie-break chose). A copy without the five sections of section 4.2 has nothing to merge by: the leading copy then stands whole, so nothing in it is lost to its layout.

## 6. Scopes and precedence

1. **Branch scope**: memory tied to one branch of one project. Producers that are branch-aware SHOULD write branch-scoped documents.
2. **Project scope**: memory shared by all branches of a project, the project being the repository (its normalized `origin` remote, section 4.1) wherever it is checked out, or the directory when there is no remote. Also the fallback when branch information is unavailable.
3. **Global scope**: user-wide preferences and lessons that travel across projects.

When assembling context for an agent, consumers MUST apply precedence: branch over project, project over global. Global entries duplicated at a narrower scope are shadowed.

## 7. Security considerations

- AMI documents contain distilled work history. They are private by default and MUST NOT be committed to version control or published. The reference implementation enforces this with commit guards and zeroed public baselines.
- Producers SHOULD redact secrets (API keys, tokens, credentials) before writing entries.
- Encryption at rest, integrity checks, and access control are storage concerns of implementations, not of the interchange format. A document in transit between tools is plain text and should be handled accordingly.

## 8. Interchange operations (reference behavior)

Two operations complete the interchange story. They are specified here by behavior; `egc export` is the reference implementation of the first, `egc import` is planned.

### 8.1 Export

Produce the plain-text AMI document for a given scope, decrypted, ready to hand to another tool or person. Export MUST NOT include storage artifacts (encryption headers, integrity trailers).

Reference: `egc export [--project <path>] [--scope project|global] [--json]` prints the document for a project (default: the current directory, resolved to its branch state like `get_state`) or for the global scope. Plain text is the stored document byte for byte, decrypted; `--json` parses the header fields and the five sections (unknown sections are kept under `other_sections`). The state file is read through a checked descriptor (never through a link, a regular file inside the state directory) and the key is loaded without changing its mode: the command never writes the state files, the key or the sidecars. Exit codes: 0 printed, 1 usage error or a state file or key that cannot be read or trusted, 2 no memory for the scope, 3 encrypted memory whose key is missing.

### 8.2 Import

Read a foreign memory artifact and merge it into an AMI document using the Section 5 rules. Reference mappings:

| Source | Mapping |
|--------|---------|
| `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` instruction files | Instruction bullets become `Preferences`; project descriptions become `Context` |
| Cursor native memories | Each memory becomes an `Active Decisions` or `Preferences` entry by content |
| Free-form notes | Split by the importer into the five sections, with the user reviewing the result |

Importers MUST preserve the source meaning, MUST NOT invent entries, and SHOULD tag imported entries with their origin when the source is another person's memory.

## 9. Conformance

A minimal conforming implementation:

1. Reads and writes the document format of Section 4 (MUST).
2. Applies the merge semantics of Section 5 on update (MUST).
3. Honors scope precedence of Section 6 when assembling context (MUST).
4. Keeps documents out of version control by default (MUST).
5. Implements export (SHOULD) and import of at least one foreign format (SHOULD).

## 10. Versioning

This document is versioned independently of EGC releases. Draft v0.1 documents the format as shipped in EGC v1.1.14. Breaking changes to section names, header keys, or merge rules require a new major spec version; adding optional header keys or import mappings does not.

## 11. Complete synthetic example

```
# Project State
project: /home/dev/projects/orbit-tracker
branch: main
author: dev
updated: 2026-01-15T12:00:00.000Z

## Context
Satellite tracking dashboard in beta. Realtime pipeline done, alerting in progress.

## Active Decisions
- Use SQLite for the event store: zero-ops requirement on user machines
- Alert thresholds live in config, not code: operators tune them without redeploys

## Do Not Repeat
- WebSocket reconnect without backoff: melted the server during the 01/10 outage

## Preferences
- Tests colocated with modules
- Conventional commits, no scopes wider than one subsystem

## Next Session
- Wire the alert webhook to the notification service
- Load-test the realtime pipeline at 10x current traffic
```
