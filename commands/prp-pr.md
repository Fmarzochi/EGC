---
description: "Create a GitHub PR from current branch with unpushed commits: discovers templates, analyzes changes, pushes"
argument-hint: "[base-branch] (default: main)"
---

# Pull Request Creator

**Input**: `$ARGUMENTS`: optional base branch name and/or flags (e.g., `--draft`).

Open a pull request whose description a reviewer can trust: assembled from the actual commits and diff, with verification evidence, never from memory of the conversation.

## Step 1: Preflight

All four must hold before anything is pushed:

| Check | Command | On failure |
|---|---|---|
| Not on the base branch | `git branch --show-current` | Offer to create a feature branch from the current state |
| Base branch exists | `git rev-parse --verify {base}` | Ask for the correct base |
| There are commits to propose | `git log {base}..HEAD --oneline` | Stop: nothing to open a PR for |
| `gh` is authenticated | `gh auth status` | Stop with the login instruction |

Base branch: first word of `$ARGUMENTS` if present, otherwise `main`.

## Step 2: Understand the change

Build the PR narrative from evidence:

```bash
git log {base}..HEAD --format='%h %s%n%b'
git diff {base}...HEAD --stat
```

Identify: the user-visible outcome, the commits that carry it, breaking changes, and anything a reviewer will ask about (large diffs, deleted files, dependency changes).

## Step 3: Template discovery

Look for a PR template, in order:

```text
.github/PULL_REQUEST_TEMPLATE.md
.github/pull_request_template.md
.github/PULL_REQUEST_TEMPLATE/*.md
docs/pull_request_template.md
```

When one exists, fill its sections faithfully; empty template sections are deleted, not left as placeholder text. When none exists, use:

```markdown
## What

{the change, stated as its user-visible outcome}

## Why

{the problem or request behind it}

## Verification

{commands run and their results; screenshots for UI changes}

## Notes for review

{breaking changes, migration steps, or "none"}
```

## Step 4: Push and open

```bash
git push -u origin {current-branch}
gh pr create --base {base} --title "{conventional-commit style title}" --body "{assembled body}"
```

Add `--draft` when the flag was passed. The PR title follows the same conventional format as commit messages.

## Step 5: Output

```text
PR opened: {url}
  {base} <- {branch}: {n} commits, +{additions}/-{deletions}
CI: {link or "no checks configured"}
```

## Edge cases

- **Diverged from base**: warn and suggest `git fetch origin && git rebase origin/{base}` before opening.
- **Existing open PR for this branch**: do not create a duplicate; show the existing URL and offer to update its body instead.
- **Fork workflow**: when `origin` is a fork, push to `origin` and target the upstream repo with `--repo`.
