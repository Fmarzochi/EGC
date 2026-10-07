---
name: cost-tracking
description: Report token usage and estimated cost from the files EGC's own hooks write, metrics/costs.jsonl and cost-tracker.log in the EGC directory. Use when the user asks about costs, spending, tokens, usage, or a breakdown by session, model or date.
origin: community
---

# Cost Tracking

Use this skill to answer cost and usage questions from the two files EGC's
hooks append to. EGC keeps no cost database: there is no SQLite file to query.

Source: salvaged from stale community PR #1304 by `MayurBhavsar`, rewritten to
read what EGC actually writes.

## When to Use

- The user asks "how much have I spent?", "what did this session cost?", or
  "what is my token usage?"
- The user wants usage broken down by session, model, or date.
- The user wants to compare today against previous days.
- The user asks how many shell commands the agent ran, or which ones.

## What EGC Writes

Both files live in the EGC directory of the tool the hooks ran in: `$EGC_DIR`
when it is set, otherwise that tool's own directory (`~/.claude`, `~/.cursor`,
`~/.gemini`, ...), otherwise `~/.egc`.

| File | Written by | One line per |
| --- | --- | --- |
| `metrics/costs.jsonl` | the `stop:cost-tracker` hook (`scripts/hooks/cost-tracker.js`) | session stop, as a JSON object |
| `cost-tracker.log` | the Bash dispatcher, `post:bash:command-log-cost` (`scripts/hooks/post-bash-command-log.js`) | Bash command the agent ran |

A `metrics/costs.jsonl` line has exactly these fields:

| Field | Meaning |
| --- | --- |
| `timestamp` | ISO 8601 time, UTC |
| `session_id` | `EGC_SESSION_ID`, or `default` when it is not set |
| `model` | the model the tool reported, or `unknown` |
| `input_tokens` | input tokens the tool reported, `0` when it reported none |
| `output_tokens` | output tokens the tool reported, `0` when it reported none |
| `estimated_cost_usd` | an estimate from EGC's per-tier rates (`scripts/lib/llm-costs.js`), not the provider's bill |

A `cost-tracker.log` line is `[<ISO timestamp>] tool=Bash command=<command>`,
with secrets in the command already replaced by `<REDACTED>`. It carries no
cost and no token count.

Not every tool runs these hooks: Claude Code and Cursor run the cost tracker,
and the Bash log comes from the hooks that run the Bash dispatcher. Either hook
can be turned off with `EGC_DISABLED_HOOKS`.

## How It Works

First find the files. Inline interpreters (`node -e`, `python -c`) are refused
by the EGC Guardian, so the steps below use the shell and `jq`.

```bash
for dir in "${EGC_DIR:-}" ~/.egc ~/.claude ~/.cursor ~/.gemini ~/.codeium/windsurf ~/.config/opencode ~/.kiro ~/.trae ~/.codebuddy; do
  [ -n "$dir" ] || continue
  [ -f "$dir/metrics/costs.jsonl" ] && echo "costs: $dir/metrics/costs.jsonl"
  [ -f "$dir/cost-tracker.log" ] && echo "bash log: $dir/cost-tracker.log"
done
command -v jq >/dev/null && echo "jq available" || echo "jq missing"
```

If neither file exists, cost tracking is not active for this tool: say so and
do not invent figures. If `jq` is missing, read the last lines with `tail` and
total them in the answer instead of guessing.

## Examples

Set `COSTS` to the `costs.jsonl` path found above.

### Quick Summary

```bash
jq -s '{
  rows: length,
  sessions: (map(.session_id) | unique | length),
  input_tokens: (map(.input_tokens) | add),
  output_tokens: (map(.output_tokens) | add),
  estimated_cost_usd: (map(.estimated_cost_usd) | add)
}' "$COSTS"
```

### Today

```bash
jq -s --arg day "$(date -u +%F)" '
  map(select(.timestamp | startswith($day)))
  | {rows: length, estimated_cost_usd: (map(.estimated_cost_usd) | add // 0)}
' "$COSTS"
```

### Last Seven Days

```bash
jq -s 'group_by(.timestamp[0:10])
  | map({date: .[0].timestamp[0:10], rows: length, estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | reverse | .[0:7]' "$COSTS"
```

### By Model

```bash
jq -s 'group_by(.model)
  | map({model: .[0].model, rows: length, input_tokens: (map(.input_tokens) | add),
         output_tokens: (map(.output_tokens) | add), estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | sort_by(-.estimated_cost_usd)' "$COSTS"
```

### By Session

```bash
jq -s 'group_by(.session_id)
  | map({session: .[0].session_id, started: (map(.timestamp) | min), ended: (map(.timestamp) | max),
         estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | sort_by(.started) | reverse | .[0:10]' "$COSTS"
```

### Bash Commands Per Day

Set `BASHLOG` to the `cost-tracker.log` path found above.

```bash
cut -c2-11 "$BASHLOG" | sort | uniq -c | tail -7
tail -n 20 "$BASHLOG"
```

## Reporting Guidance

When presenting the figures:

1. Call the dollar amounts estimates, priced by model tier, not billed amounts.
2. Give today's estimate and the recent days next to it.
3. Break down by model and by session when there is more than one.
4. Say how many rows report zero tokens: those are stops where the tool sent
   no usage, so the estimate undercounts them.
5. Use four decimal places for small amounts and two for larger ones.

## Anti-Patterns

- Do not query `sqlite3` or look for a `usage.db`: EGC writes no database.
- Do not present `estimated_cost_usd` as the provider's bill.
- Do not report a per-project breakdown: neither file records the project.
- Do not read token counts or costs from `cost-tracker.log`: it holds commands
  only.
- Do not assume the files exist without checking.

## Related

- `cost-aware-llm-pipeline` - Model-routing and budget-design patterns.
- `token-budget-advisor` - Context and token-budget planning.
- `strategic-compact` - Context compaction to reduce repeated token spend.
- `egc gain` - Token Crusher savings, a separate ledger from these costs.
