---
description: Create comprehensive feature implementation plan with codebase analysis and pattern extraction
argument-hint: <feature description | path/to/prd.md>
---

# Implementation Plan Builder

**Input**: $ARGUMENTS

Produce a plan that survives a cold start: a fresh session with zero conversation history must be able to open the plan file and implement the feature without re-researching the codebase. Everything the implementer needs lives inside the plan.

## Input resolution

| `$ARGUMENTS` looks like | Treat as | First action |
|---|---|---|
| Path ending in `.md` | PRD or phase document | Read it; pick the first unchecked entry under "Implementation Phases" |
| Free text | Feature description | Use the text as the goal statement |
| Blank | Missing input | Ask for a feature description or a PRD path, then stop |

When the source is a PRD, the plan covers **one phase**, not the whole document. Name the plan after the phase.

## Step 1: Reconnaissance

Before writing a single plan line, learn the codebase. Collect and record:

- **Conventions**: naming, directory layout, error handling style, import style. Cite the config files that enforce them (linter, formatter, tsconfig or equivalent).
- **Nearest neighbor**: the existing feature most similar to the new one. Note its file paths; the implementation will mirror its shape.
- **Test harness**: how tests are written and executed here. Copy the exact command that runs them.
- **Validation commands**: the real lint, typecheck, test, and build commands this repo uses, verified by running them once.

Anything you could not verify goes in the plan under Open risks, never silently guessed.

## Step 2: Slice into increments

Cut the work into increments where **each one leaves the repo green**: compiling, tests passing, feature partially working. Prefer vertical slices (a thin end-to-end path first) over horizontal layers. An increment that cannot be validated on its own is two increments glued together; cut again.

## Step 3: Write the plan file

Save to:

```text
PRPs/plans/{kebab-case-feature-name}.plan.md
```

Create the directory if needed.

### Plan format

```markdown
# Plan: {feature name}

source: {PRD path or "direct request"}
created: {date}
status: pending

## Goal

{Two sentences maximum: what exists when this plan is done, and how we know.}

## Context capsule

Read these before touching anything:

| File | Why it matters |
|---|---|
| {path} | {the pattern or contract it defines} |

Conventions that apply here:

- {convention}: enforced by {config file}

Validation commands (verified working):

- Lint: `{command}`
- Typecheck: `{command}`
- Tests: `{command}`
- Build: `{command}`

## Increments

### [ ] Increment 1: {name}

- Goal: {what works after this increment}
- Files: {paths to create or change}
- Mirror: {existing file whose shape to follow}
- Steps: {short numbered list}
- Validate: `{exact command}` plus {any manual check}

### [ ] Increment 2: {name}

{same structure}

## Open risks

- {unverified assumption or fragile area, and what to do if it bites}

## Done means

- All increments checked
- Full validation suite green
- {feature-specific acceptance check}
```

## Quality bar before saving

- Every increment has a runnable Validate command
- Every Mirror points to a real file that exists today
- The Context capsule alone is enough to start: no "see conversation" references
- Increments are ordered so the repo never goes red between them

## Handoff

```text
Plan saved: PRPs/plans/{name}.plan.md
Next: /prp-implement PRPs/plans/{name}.plan.md
```
