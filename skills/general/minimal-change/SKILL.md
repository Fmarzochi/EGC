---
name: minimal-change
description: Apply the minimal-change ladder when writing or modifying code, choosing the smallest rung that truly solves the task and refusing both padded overengineering and half-done stubs. Use for implementation, refactoring, and bug-fix requests; not for research, documentation, or conversation.
origin: EGC
---

# Minimal Change: the ladder in practice

The always-on rule in `coding-style.md` gives every agent the ladder. This skill loads only when the task is code, and turns the ladder into a working protocol: how to pick a rung, what the delivery must contain, and how strict to be for the context at hand.

Two failure modes, one discipline. A half-done change solves the request on paper and leaves a broken edge behind. An overengineered change solves the request and three imaginary future ones, at triple the diff. The ladder exists to kill both with the same move: the smallest change that fully works.

## Rung selection protocol

1. Restate the request as an observable outcome (what behavior changes, for whom).
2. Start at rung 1 and climb only on evidence: name the reason each lower rung fails before moving up.
3. Announce the chosen rung in one line whenever the choice is not obvious, for example: `Rung 5: extending the existing adapter registry; a new module (rung 6) would duplicate its lifecycle handling.`
4. If mid-implementation you discover the rung was wrong, stop and re-announce instead of silently expanding scope.

## Delivery contract

Every code deliverable under this skill must satisfy all of these:

- **No stubs shipped as done.** No placeholder bodies, no `TODO` standing in for logic, no commented-out intentions. If something is genuinely out of scope, say so in the summary instead of leaving it half-coded.
- **The diff is sized to the problem.** Every changed line traces back to the stated outcome. Drive-by refactors, renames, and formatting churn belong in their own change.
- **Nothing from The Floor is missing**: error handling, boundary validation, tests for changed behavior, security checks, resource cleanup, documented invariants.
- **Dead weight is removed, not added.** No speculative parameters, no config for futures nobody asked for, no wrapper around a wrapper.
- **Done means verified.** State how the change was checked (test run, command output, reproduction), not that it "should work".

## Strictness modes

- **Strict** (default for production paths, shared libraries, installers, security-adjacent code): full protocol, rung announcement mandatory, contract enforced item by item.
- **Light** (prototypes, spikes, throwaway scripts, sandboxes): the ladder still guides rung choice and The Floor holds in full; no mode ever waives it. Announcements become optional, and the rest of the contract relaxes to: no silent broken edges, and label the artifact as a prototype.

When in doubt about which mode applies, ask or default to strict.

## Worked examples

**Deletion beats patching (rung 2).** A flag parser mishandles an option that nothing has set for six releases. The quick fix wraps it in a try/catch; the overengineered fix rewrites the parser. The ladder answer deletes the dead option and its branch, and adds the one regression test proving the remaining options still parse.

**Root cause beats symptom (rung 3).** A dashboard shows stale numbers after midnight. The quick fix reloads the page on a timer; the ladder answer is the one-line fix at the date-boundary comparison that caused the staleness, plus a test pinned to the boundary.

**Existing seam beats new machinery (rung 5).** A new screen needs one more operation exposed over HTTP. The overengineered fix builds a second router with its own auth. The ladder answer registers the operation in the dispatcher that already exists and reuses its token gate, because the seam was built for exactly this.

## Anti-pattern table

| Smell | Failure mode | Ladder response |
|---|---|---|
| Placeholder body or TODO-as-logic | half-done | Implement or declare out of scope explicitly |
| Swallowed error to make tests pass | half-done | Handle it; the error path is part of the task |
| Symptom patch over root cause | half-done | Climb down to rung 3 at the real cause |
| New layer with a single caller | overengineering | Rung 5: extend the seam that exists |
| Config knob for an imagined future | overengineering | YAGNI; delete it |
| Rewrite when an edit suffices | overengineering | Re-walk the ladder from rung 1 |
