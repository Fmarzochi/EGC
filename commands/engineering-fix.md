---
description: Applies engineering corrections from the last /engineering-audit run. Creates an isolated branch, applies changes incrementally, runs lint + typecheck + tests after each file, and reverts on failure. Requires explicit user confirmation before any modification.
argument-hint: [--severity <critical|high|medium|low> | --file <path> | blank for CRITICAL only]
---

# Engineering Fix

**Input**: $ARGUMENTS

Applies the remediation plan produced by `/engineering-audit`. Operates exclusively on an isolated branch. Never modifies files directly on the current branch. Always requires explicit user confirmation before starting.

---

## Pre-conditions

Before running any fix:

1. **Confirm audit exists**:
```bash
ls .egc/audits/engineering-audit-*.md 2>/dev/null | sort | tail -1
```
If no audit report exists, stop: "Run `/engineering-audit` first."

2. **Confirm working tree is clean**:
```bash
git status --porcelain
```
If uncommitted changes exist, stop: "Stash or commit your changes before running engineering-fix."

3. **Confirm user intent** — print the scope and ask explicitly:

```
Ready to apply engineering fixes.

Scope: <CRITICAL only | CRITICAL + HIGH | etc. based on $ARGUMENTS>
Branch: engineering-fix/<date>
Files to modify: N

This will:
  1. Create branch engineering-fix/<date>
  2. Apply each fix incrementally
  3. Run lint + typecheck + tests after each file
  4. Revert and stop if any check fails

Confirm? (yes / no)
```

Do NOT proceed without a "yes" response.

---

## Argument Handling

| Argument | Behavior |
|---|---|
| `--severity critical` | Apply CRITICAL fixes only (default) |
| `--severity high` | Apply CRITICAL + HIGH fixes |
| `--severity medium` | Apply CRITICAL + HIGH + MEDIUM fixes |
| `--severity all` | Apply all findings |
| `--file <path>` | Apply fixes to one specific file only |
| blank | CRITICAL fixes only |

---

## Execution

### Step 1 — Create Isolated Branch

```bash
git checkout -b engineering-fix/$(date +%Y-%m-%d)
```

### Step 2 — Load Remediation Plan

Read the most recent audit report:
```bash
cat .egc/audits/engineering-audit-$(ls .egc/audits/ | grep engineering-audit | sort | tail -1 | sed 's/engineering-audit-//' | sed 's/\.md//')
```

Extract the list of files and fixes matching the requested severity.

### Step 3 — Apply Fixes Incrementally

For each file in the plan (CRITICAL first, then HIGH, etc.):

**3a. Show the planned change:**
```
Fixing: <file>:<line>
Technique: <Extract Method | Early Return | etc.>
Before: <brief description of current code>
After: <brief description of target state>
```

**3b. Apply the fix** — modify the file using the specific refactoring technique from the plan.

**3c. Validate immediately:**
```bash
npm run lint -- --quiet 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -10
npm test 2>&1 | tail -20
```

**3d. On failure — revert and stop:**
```bash
git checkout -- <file>
```
Report:
```
Fix FAILED on <file>
Check: <lint|typecheck|test>
Error: <error output>
Reverted. Stopping.

Remaining fixes not applied: N files
Run /engineering-audit to re-assess.
```

**3e. On success — commit the file:**
```bash
git add <file>
git commit -s -m "refactor(<file>): <technique> to reduce <metric>"
```

### Step 4 — Final Validation

After all fixes applied:
```bash
npm run lint
npx tsc --noEmit
npm test
```

If all pass:
```
Engineering fix complete.

Applied: N fixes across M files
Branch: engineering-fix/<date>
All checks: lint ✓ typecheck ✓ tests ✓

Next: Review the branch and open a PR when ready.
gh pr create --title "refactor: engineering fixes <date>" --body "Automated engineering health improvements from /engineering-audit"
```

### Step 5 — Report

Append a fix summary to the audit report:

```markdown
## Fix Session — <timestamp>

Applied N fixes. Branch: engineering-fix/<date>.

| File | Technique | Result |
|---|---|---|
| src/foo.ts | Extract Method | success |
| src/bar.ts | Early Return | success |
```

---

## Safety Guarantees

- Isolated branch: current branch is never touched
- Incremental commits: each file is its own commit — easy to revert individually
- Signed commits (`-s`): DCO compliance
- Automatic revert on any check failure
- No force-push, no destructive operations
- Full audit trail in `.egc/audits/`

---

## Edge Cases

- **No audit report**: Redirect to `/engineering-audit`
- **Fix fails lint but not tests**: Still revert — all checks must pass
- **Large file (> 500 lines)**: Warn that manual review is recommended before applying automated fixes
- **Merge conflict on branch creation**: Stop and report — do not attempt to resolve automatically
