---
description: Execute an implementation plan with rigorous validation loops
argument-hint: <path/to/plan.md>
---

# Plan Executor

**Input**: $ARGUMENTS (plan file path, required)

Execute a plan file increment by increment under one non-negotiable rule: **green to green**. The repo is verified working before an increment starts and verified working when it ends. Broken state is never carried forward into the next increment.

## Startup

1. Read the plan file in full. If `$ARGUMENTS` is blank or the file does not exist, list available plans in `PRPs/plans/` and stop.
2. Read every file in the plan's Context capsule.
3. Find the first unchecked increment; this makes the command resumable after an interruption.
4. Run the plan's validation commands once to establish the baseline. If the baseline is already red, stop and report: the plan assumed a green repo.

## Increment loop

For each unchecked increment, in order:

1. **Apply**: make the changes described, following the Mirror file's shape and the capsule's conventions.
2. **Validate**: run the increment's Validate command exactly as written.
3. **Settle**:
   - Green: mark the increment's checkbox in the plan file, then continue.
   - Red: enter the failure protocol below.

Never start increment N+1 while increment N is red.

## Failure protocol

On a red validation:

1. Read the full error output; fix the actual cause, not the symptom.
2. Re-validate. If still red, try **one** structurally different approach (not the same edit again).
3. Still red after the second attempt: stop. Revert the increment's changes so the repo returns to green, mark the increment as blocked in the plan file, and write a partial report (format below) describing what was tried and the exact error. Do not brute-force a third variation; a plan that fails twice has a wrong assumption that the user should see.

## Completion

When every increment is checked:

1. Run the **full** validation suite from the Context capsule (lint, typecheck, tests, build).
2. Check the plan's "Done means" list item by item.
3. Write the report to:

```text
PRPs/reports/{plan-name}-report.md
```

4. Move the finished plan to:

```text
PRPs/plans/completed/{plan-name}.plan.md
```

Create both directories if needed.

### Report format

```markdown
# Report: {plan name}

executed: {date}
result: complete | blocked at increment {N}

## What changed

{file list with one-line purpose each}

## Validation evidence

| Check | Command | Result |
|---|---|---|
| Lint | {command} | pass/fail |
| Typecheck | {command} | pass/fail |
| Tests | {command} | pass/fail |
| Build | {command} | pass/fail |

## Deviations from plan

{Anything done differently than written, and why. "None" if faithful.}

## Blocked (only when result is blocked)

{Increment, both attempted approaches, exact error output, suspected wrong assumption.}
```

## Handoff

```text
Report: PRPs/reports/{name}-report.md
Next: /prp-commit  (then /prp-pr when ready)
```
