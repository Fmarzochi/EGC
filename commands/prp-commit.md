---
description: "Quick commit with natural language file targeting: describe what to commit in plain English"
argument-hint: "[target description] (blank = all changes)"
---

# Smart Commit

**Input**: $ARGUMENTS

Turn "commit the parser fix" into the right `git add` set and a clean conventional commit, without the user naming a single path.

## Step 1: Inventory

```bash
git status --porcelain
git diff --stat
```

If there is nothing to commit, say so and stop.

## Step 2: Resolve the target

| `$ARGUMENTS` | Selection |
|---|---|
| Blank | All modified and untracked files |
| Plain-English description | Files whose path, directory, or diff content match the description |

Matching is semantic, not string-based: "the parser fix" selects the files whose diff touches parsing logic, even if no path contains the word "parser". When the description matches nothing, show the changed files and ask; never guess into an empty commit.

## Step 3: Split into atomic commits

One commit = one concern. If the selected files mix concerns (a bug fix plus an unrelated rename), propose a split and create the commits in sequence. Never bundle unrelated changes to save a step.

## Step 4: Guard

Before staging, scan the selected diff for:

- Secrets: keys, tokens, passwords, `.env` content. Finding one aborts the commit for that file with a warning.
- Debug leftovers: `console.log`, commented-out blocks, stray TODO added by this change. Flag them; commit only if the user confirms.
- Files that are clearly accidental: lockfile churn without dependency changes, editor artifacts.

## Step 5: Commit

Write a conventional commit message derived from the diff, not from the user's phrasing:

```text
{type}({scope}): {what changed, imperative, under 72 chars}

{body only when the diff does not speak for itself: the why, not the what}
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`.

Sign-off: run `git commit -s` when the repository enforces DCO (a DCO check in CI or a CONTRIBUTING requirement); plain `git commit` otherwise.

## Output

```text
{n} commit(s) created:
  {short-hash} {message}
Not committed: {files left out and why, or "nothing"}
```
