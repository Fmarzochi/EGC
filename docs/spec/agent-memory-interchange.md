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

1. **project**: the absolute path of the project root on the machine that produced it (informative for consumers on other machines).
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

- `project` (REQUIRED): absolute project path as seen by the producer.
- `branch` (OPTIONAL): branch name; omitted for project-scoped and global documents.
- `author` (REQUIRED): the OS user or agent identity that produced the update.
- `updated` (REQUIRED): ISO 8601 timestamp of the last write.

Consumers MUST ignore header keys they do not recognize; producers MAY add keys, but the four above are the interoperable core.

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

## 6. Scopes and precedence

1. **Branch scope**: memory tied to one branch of one project. Producers that are branch-aware SHOULD write branch-scoped documents.
2. **Project scope**: memory shared by all branches of a project. Also the fallback when branch information is unavailable.
3. **Global scope**: user-wide preferences and lessons that travel across projects.

When assembling context for an agent, consumers MUST apply precedence: branch over project, project over global. Global entries duplicated at a narrower scope are shadowed.

## 7. Security considerations

- AMI documents contain distilled work history. They are private by default and MUST NOT be committed to version control or published. The reference implementation enforces this with commit guards and zeroed public baselines.
- Producers SHOULD redact secrets (API keys, tokens, credentials) before writing entries.
- Encryption at rest, integrity checks, and access control are storage concerns of implementations, not of the interchange format. A document in transit between tools is plain text and should be handled accordingly.

## 8. Interchange operations (reference behavior)

Two operations complete the interchange story. They are specified here by behavior; `egc export` and `egc import` are the planned reference implementation.

### 8.1 Export

Produce the plain-text AMI document for a given scope, decrypted, ready to hand to another tool or person. Export MUST NOT include storage artifacts (encryption headers, integrity trailers).

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
