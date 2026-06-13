---
description: Full-spectrum engineering health audit: scores Maintainability, Security, Testing, Architecture, Documentation, Lint, Type Safety, and Build Health. Produces a ranked issue list and remediation plan. Never modifies files.
argument-hint: [--threshold <score> | --focus <dimension> | blank for full audit]
---

# Engineering Audit

**Input**: $ARGUMENTS

Runs a full engineering health assessment of the current project. Produces an Engineering Score (0–10), a ranked issue list (CRITICAL / HIGH / MEDIUM / LOW), and a concrete remediation plan.

This command NEVER modifies files. Use `/engineering-fix` to apply corrections after reviewing the plan.

---

## Argument Handling

Parse `$ARGUMENTS`:

| Argument | Behavior |
|---|---|
| `--threshold <N>` | Only report issues where score < N (e.g. `--threshold 7` shows scores below 7) |
| `--focus <dimension>` | Run only one dimension (e.g. `--focus security`, `--focus complexity`) |
| `--quick` | Skip slow checks (coverage, duplicate detection): fast scan only |
| blank | Full audit, all dimensions |

---

## Execution

### Step 1: Detect Project

```bash
ls package.json tsconfig.json pyproject.toml go.mod Cargo.toml 2>/dev/null
```

Identify: Node/TypeScript, Python, Go, Rust, or mixed. Adjust tool selection accordingly.

### Step 2: Run Audit

Invoke the `engineering-auditor` agent with the project context and parsed arguments.

The agent will:
1. Collect metrics across all 12 dimensions (or the focused dimension if `--focus` was passed)
2. Score each dimension 0–10
3. Compute the weighted Engineering Score
4. Rank all findings: CRITICAL → HIGH → MEDIUM → LOW

### Step 3: Display Report

Print the full report:

```
═══════════════════════════════════════════════
  ENGINEERING AUDIT: <project name>
  <timestamp>
═══════════════════════════════════════════════

Engineering Score: X.X / 10

  Maintainability  X.X  [████████░░]
  Security         X.X  [█████████░]
  Testing          X.X  [██████░░░░]
  Architecture     X.X  [████████░░]
  Documentation    X.X  [█████░░░░░]
  Lint Health      X.X  [█████████░]
  Type Safety      X.X  [████████░░]
  Build Health     X.X  [██████████]

───────────────────────────────────────────────
CRITICAL  (N)
───────────────────────────────────────────────
  ▸ [file:line] description
    Root cause: ...
    Fix: Extract Method: split into X and Y

HIGH  (N)
───────────────────────────────────────────────
  ▸ [file:line] description

MEDIUM  (N)
───────────────────────────────────────────────
  ▸ [file:line] description

LOW  (N)
───────────────────────────────────────────────
  ▸ [file:line] description

───────────────────────────────────────────────
To apply fixes: /engineering-fix
───────────────────────────────────────────────
```

### Step 4: Write Audit Report

Save report to `.egc/audits/engineering-audit-<YYYY-MM-DD>.md`:

```bash
mkdir -p .egc/audits
```

The report includes:
- Full score breakdown
- All findings with file paths and line numbers
- Remediation plan
- Timestamp and tool versions used

### Step 5: Summarize

Print a one-line summary:

```
Engineering Score: X.X/10: N critical, N high, N medium, N low issues. Report: .egc/audits/engineering-audit-<date>.md
```

Then ask: "Run `/engineering-fix` to apply corrections, starting with CRITICAL issues?"

---

## Edge Cases

- **No package.json**: Adjust tooling to detected language. If no language detected, scan for common source files.
- **ESLint not installed**: Fall back to manual AST analysis for CC metrics.
- **No tests found**: Score Testing as 0, note that no test suite was detected.
- **CI environment**: If `$CI=true`, suppress the interactive prompt at Step 5.
