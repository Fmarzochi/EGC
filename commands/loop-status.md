---
description: Inspect active loop state, progress, failure signals, and recommended intervention.
---

# Loop Status Command

Inspect active loop state, progress, and failure signals.

This slash command can only run after the current session dequeues it. If you
need to inspect a wedged or sibling session, run the packaged CLI from another
terminal:

```bash
npx --package egc-universal egc loop-status --json
```

The CLI scans local Gemini transcript JSONL files under
`~/.gemini/projects/**` and reports stale `ScheduleWakeup` calls or `Bash`
tool calls that have no matching `tool_result`.

## Usage

`/loop-status [--watch]`

## What to Report

- active loop pattern
- current phase and last successful checkpoint
- failing checks (if any)
- estimated time/cost drift
- recommended intervention (continue/pause/stop)

## Cross-Session CLI

- `egc loop-status --json` emits machine-readable status for recent local
  Gemini transcripts.
- `egc loop-status --home <dir>` scans a different home directory when
  inspecting another local profile or mounted workspace.
- `egc loop-status --transcript <session.jsonl>` inspects one transcript
  directly.
- `egc loop-status --bash-timeout-seconds 1800` adjusts the stale Bash
  threshold.
- `egc loop-status --exit-code` exits `2` when stale loop or tool signals are
  found, or `1` when transcripts cannot be scanned.
- `--exit-code` with `--watch` requires `--watch-count` so watchdog scripts do
  not wait forever for a process exit.
- `egc loop-status --watch` refreshes status until interrupted.
- `egc loop-status --watch --watch-count 3 --exit-code` refreshes a bounded
  number of times, then exits with the highest status seen.
- `egc loop-status --watch --watch-count 3` emits a bounded watch stream for
  scripts and handoffs.
- `egc loop-status --watch --write-dir ~/.gemini/loops` maintains
  `index.json` and per-session JSON snapshots for sibling terminals or
  watchdog scripts.

## Watch Mode

When `--watch` is present, refresh status periodically. With `--json`, each
refresh is emitted as one JSON object per line so another terminal or script can
consume the stream.

## Snapshot Files

Use `--write-dir <dir>` when a separate process needs to inspect loop state
without waiting for the current Gemini session to dequeue `/loop-status`. The
CLI writes:

- `index.json` with one row per inspected session.
- `<session-id>.json` with the full status payload for that session.

These files are snapshots of local transcript analysis. They do not control or
timeout the runtime tool calls of your AI coding tool.

## Arguments

$ARGUMENTS:
- `--watch` optional
