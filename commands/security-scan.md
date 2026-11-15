---
description: Run the EGC harness audit on the agent, hook, MCP, permission and secret surfaces and turn the findings into a remediation plan.
agent: everything-Gemini-code:security-reviewer
subtask: true
---

# Security Scan Command

Run the harness audit that ships with EGC against the current project or a target path, review the surfaces it does not read, and turn the findings into a prioritized remediation plan.

## Usage

`/security-scan [path] [--format text|json]`

- `path` (optional): defaults to the current project. Use a repo root or a checked-in template directory.
- `--format`: `text` for a terminal report, `json` for CI and handoffs.

## Deterministic Engine

Always run the audit that ships with EGC; it installs nothing:

```bash
egc harness-audit repo --root "${TARGET_PATH:-.}" --format json
```

Inside this repository, `node scripts/harness-audit.js repo --format json` is the same engine. Do not invent findings: the audit output is the source of truth for what is missing, the review below is the source of truth for what a file says, and the report keeps the two apart.

## Review Checklist

1. Identify active runtime findings first:
   - hardcoded secrets
   - broad permissions
   - executable hooks
   - MCP servers with shell, filesystem, remote transport, or unpinned `npx`
   - agent prompts that handle untrusted content without defenses
2. Separate lower-confidence inventory:
   - docs examples
   - template examples
   - plugin manifests
   - project-local optional settings
3. For each critical or high finding, return:
   - file path
   - severity
   - runtime confidence
   - why it matters
   - exact remediation
   - whether it is safe to fix now
4. Before editing, state the planned edits; the Guardian judges each write.
5. Re-run the audit after the fixes and report the before/after score.

## Output Contract

Return:

1. Security grade and score.
2. Counts by severity and runtime confidence.
3. Critical/high findings with exact paths.
4. Lower-confidence findings grouped separately.
5. A remediation order.
6. Commands run and whether the scan was local or in CI.

## CI Pattern

```yaml
- run: npm install -g @egchq/egc
- run: egc harness-audit repo --format json > harness-audit.json
- run: jq -e '(.overall_score / .max_score) >= 0.75' harness-audit.json
```

The audit exits 0 even when checks fail; the last step fails the job under the floor (75 percent of the points here).

## Links

- Skill: `skills/security/security-scan/SKILL.md`
- Agent: `agents/security-reviewer.md`
- Audit engine: `scripts/harness-audit.js`

## Arguments

$ARGUMENTS:
- optional target path
- optional `--format text|json`
