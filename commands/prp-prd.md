---
description: "Interactive PRD generator - problem-first, hypothesis-driven product spec with back-and-forth questioning"
argument-hint: "[feature/product idea] (blank = start with questions)"
---

# PRD Builder

**Input**: $ARGUMENTS

Build a Product Requirements Document by interviewing the user until the problem is understood, then writing the spec. The document is the output of the conversation, never a form filled in one shot.

## Operating rule: the certainty board

Maintain a three-column board for the whole session:

| Column | Contents |
|---|---|
| **Known** | Facts the user stated or evidence you gathered |
| **Assumed** | Working hypotheses you adopted to move forward |
| **Unknown** | Questions that still block a trustworthy spec |

Every answer moves items between columns. You may only write the PRD when **Unknown is empty** or the user explicitly says "write it with what we have". Anything still in Assumed at writing time goes into the PRD's assumptions section, visible and testable.

## Session flow

### 1. Seed

If `$ARGUMENTS` contains an idea, restate it in one sentence and place it in Assumed (it is a hypothesis, not a fact). If blank, open with exactly one question: "What problem keeps happening, and to whom?"

### 2. Question rounds

Ask in rounds of **at most three questions**. Never send a questionnaire. Pick the three questions that would eliminate the most Unknowns, favoring this order:

1. Who has the problem and how do they cope today
2. What evidence shows the problem is real (frequency, cost, complaints)
3. What outcome would make the user say "solved"
4. What must NOT change (constraints, integrations, budget)
5. What happens if nothing is built

After each round, show the updated board in compact form so the user sees progress and can correct wrong Assumed entries.

### 3. Evidence pass

Before writing, verify what can be verified without the user:

- Search the repo for related code, prior attempts, TODO markers
- Check `PRPs/prds/` for an earlier PRD on the same area
- Note every verification in Known with its source

### 4. Write

Generate the document from the board. Kebab-case the title for the filename and save to:

```text
PRPs/prds/{kebab-case-name}.prd.md
```

Create the directory if it does not exist.

## PRD template

```markdown
# {Name}

status: draft
written: {date}

## Problem

{One paragraph. Who hurts, how often, what it costs. No solution language here.}

## Evidence

{Bulleted facts from the Known column, each with its source: user statement,
repo finding, metric. If evidence is thin, say so explicitly.}

## Users and jobs

{Each user type and the job they are trying to get done. Real roles, not personas.}

## Outcome metrics

{2-4 measurable statements that define success. Each one must be checkable
after shipping: number, threshold, and how it will be measured.}

## Scope ledger

Committed:

- {what this PRD promises}

Excluded:

- {what was consciously left out, with the one-line reason}

Deferred:

- {what waits for a later phase}

## Assumptions to validate

{Everything still in the Assumed column at writing time. Each entry gets a
validation idea: how we will find out if it is wrong, and what we do then.}

## Implementation Phases

- [ ] Phase 1: {smallest end-to-end slice that proves the approach}
- [ ] Phase 2: {next increment}
- [ ] Phase 3: {and so on}

Each phase must be independently shippable and verifiable.
```

## Quality bar before saving

- The Problem section contains zero solution words (no "add", "build", "implement")
- Every metric in Outcome metrics has a measurement method
- Scope ledger has at least one Excluded entry (a PRD that excludes nothing was not thought through)
- Every phase in Implementation Phases can be verified on its own

## Handoff

After saving, tell the user:

```text
PRD saved: PRPs/prds/{name}.prd.md
Next: /prp-plan PRPs/prds/{name}.prd.md
```
