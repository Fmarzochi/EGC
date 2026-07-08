---
description: Code review: local uncommitted changes or GitHub PR (pass PR number/URL for PR mode)
argument-hint: [pr-number | pr-url | blank for local review]
---

# Code Review

**Input**: $ARGUMENTS

---

## Mode Selection

If `$ARGUMENTS` contains a PR number, PR URL, or `--pr`:
→ Jump to **PR Review Mode** below.

Otherwise:
→ Use **Local Review Mode**.

---

## Local Review Mode

Comprehensive security and quality review of uncommitted changes.

### Phase 1: GATHER

```bash
git diff --name-only HEAD
```

If no changed files, stop: "Nothing to review."

### Phase 2: REVIEW

Read each changed file in full. Check for:

**Security Issues (CRITICAL):**
- Hardcoded credentials, API keys, tokens
- SQL injection vulnerabilities
- XSS vulnerabilities
- Missing input validation
- Insecure dependencies
- Path traversal risks

**Code Quality (HIGH):**
- Functions > 50 lines
- Files > 800 lines
- Nesting depth > 4 levels
- Missing error handling
- console.log statements
- TODO/FIXME comments
- Missing JSDoc for public APIs

**Best Practices (MEDIUM):**
- Mutation patterns (use immutable instead)
- Emoji usage in code/comments
- Missing tests for new code
- Accessibility issues (a11y)

### Phase 3: REPORT

Generate report with:
- Severity: CRITICAL, HIGH, MEDIUM, LOW
- File location and line numbers
- Issue description
- Suggested fix

Block commit if CRITICAL or HIGH issues found.
Never approve code with security vulnerabilities.

---

## PR Review Mode

Review a GitHub pull request through an evidence ledger: every finding carries proof (file, line, failure scenario), and the final decision is computed from the ledger, never from overall impression.

### Stage A: Resolve the PR

| `$ARGUMENTS` contains | Resolution |
|---|---|
| A number | That PR number |
| A GitHub URL | The number extracted from the URL |
| A branch name | `gh pr list --head <branch>` |

```bash
gh pr view <NUMBER> --json title,body,author,baseRefName,headRefName,isDraft,additions,deletions
```

Unresolvable input stops the command with the list of open PRs as a hint.

### Stage B: Absorb the change

1. Read the PR description for stated intent and linked issues; the review judges the diff against that intent.
2. Read the project's contributing rules and agent instructions if present.
3. Read `.gemini/PRPs/reports/` and `.gemini/PRPs/plans/` for artifacts related to this branch; a plan explains choices the diff alone cannot.
4. Pull the diff and read every touched source file **at the head revision, in full**; diff hunks without surrounding context hide bugs:

```bash
gh pr diff <NUMBER>
gh pr checkout <NUMBER>  # preferred when a local checkout is possible
```

### Stage C: Build the findings ledger

Hunt in two sweeps, recording each finding as a ledger row.

**Sweep 1, will it break**: logic errors, unhandled inputs, race conditions, security holes (injection, secret exposure, path traversal, missing authorization), data loss paths, performance cliffs on real data sizes.

**Sweep 2, will it rot**: convention drift from the surrounding code, missing tests for the new behavior, dead code, unclear naming, documentation the change makes stale.

Ledger row format:

```text
[severity] file:line
  claim: what is wrong, one sentence
  proof: input or state that triggers it, and the wrong result
  fix: the smallest correct change
```

A finding without a concrete proof is an opinion; either construct the failing scenario or drop the row. Severity scale: `blocker` (exploitable or data-destroying), `major` (wrong behavior a user will hit), `minor` (quality debt), `note` (style, optional).

### Stage D: Independent verification

Run the repository's own checks locally on the PR head when checked out (detect commands from the project's config files; run what exists: lint, typecheck, tests, build). Record each command and its result in the ledger footer. When a local run is impossible, record the CI status from `gh pr checks <NUMBER>` instead and mark it as second-hand evidence.

### Stage E: Decide and deliver

The decision is a function of the ledger:

| Ledger state | Verdict |
|---|---|
| Any `blocker` | Request changes, listing blockers first |
| Any `major`, or any failed check | Request changes |
| Only `minor`/`note`, checks pass | Approve, findings attached as comments |
| Empty ledger, checks pass | Approve |
| PR is a draft | Comment only, regardless of ledger |

Save the ledger to `.gemini/PRPs/reviews/pr-<NUMBER>-review.md`, then publish:

```bash
gh pr review <NUMBER> --approve --body "<ledger summary>"
gh pr review <NUMBER> --request-changes --body "<ledger summary, blockers first>"
gh pr review <NUMBER> --comment --body "<ledger summary>"
```

For line-anchored comments, submit one review carrying all inline comments:

```bash
gh api "repos/{owner}/{repo}/pulls/<NUMBER>/reviews" \
  -f event="COMMENT" \
  -f body="<summary>" \
  --input comments.json
```

Close by telling the user the verdict, the ledger counts per severity, the verification results, and the saved ledger path.

### Degraded situations

- **`gh` missing or unauthenticated**: produce the ledger from a local diff only, skip publishing, and say so.
- **PR far behind its base**: note it in the review and recommend a rebase before merge.
- **Very large PR**: review source files first and say explicitly which files were not reviewed; a silent partial review is worse than a declared one.
