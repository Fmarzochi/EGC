---
description: Report estimated token cost and usage from metrics/costs.jsonl, the ledger EGC's cost-tracker hook writes.
argument-hint: [csv]
---

# Cost Report

Present a spending and usage report from `metrics/costs.jsonl`, the file EGC's
`stop:cost-tracker` hook (`scripts/hooks/cost-tracker.js`) appends one JSON line
to at every session stop. EGC keeps no cost database. The `cost-tracking` skill
covers the file in depth; this command is the short report.

## What This Command Does

1. Find `metrics/costs.jsonl` and check that `jq` is available.
2. Summarize today, yesterday, the total, the rows and the sessions.
3. Break the estimate down by model and by session, and list the last seven days.
4. With the `csv` argument, export the most recent rows.

## Find the Ledger

```bash
for dir in "${EGC_DIR:-}" ~/.claude ~/.cursor ~/.gemini ~/.codeium/windsurf ~/.config/opencode ~/.config/zed \
  ~/.agents ~/.amp ~/.continue ~/.github ~/.kiro ~/.trae ~/.trae-cn ~/.codebuddy; do
  [ -n "$dir" ] || continue
  [ -f "$dir/metrics/costs.jsonl" ] && echo "costs: $dir/metrics/costs.jsonl"
done
test -f ~/.egc/metrics/costs.jsonl && echo "costs: ~/.egc/metrics/costs.jsonl"
command -v jq >/dev/null && echo "jq available" || echo "jq missing"
```

Set `COSTS` to the file found: `EGC_DIR` first, then the directory of the tool
you are running in, then `~/.egc`. If there is none, tell the user cost tracking
is not active for this tool (Claude Code and Cursor run the cost tracker, and
`EGC_DISABLED_HOOKS` can turn it off) and stop: do not invent figures. The
queries below read the file with `cat` and pipe it into `jq`, because the
Guardian lets the agent read `~/.egc/metrics` but refuses `jq` naming a path
there.

Each line holds `timestamp` (ISO 8601, UTC), `session_id`, `model`,
`input_tokens`, `output_tokens` and `estimated_cost_usd`.

## Summary

```bash
cat "$COSTS" | jq -s '(now | strftime("%Y-%m-%d")) as $today
  | ((now - 86400) | strftime("%Y-%m-%d")) as $yesterday
  | {
      today: (map(select(.timestamp | startswith($today)) | .estimated_cost_usd) | add // 0),
      yesterday: (map(select(.timestamp | startswith($yesterday)) | .estimated_cost_usd) | add // 0),
      total: (map(.estimated_cost_usd) | add // 0),
      rows: length,
      sessions: (map(.session_id) | unique | length),
      rows_without_tokens: (map(select(.input_tokens == 0 and .output_tokens == 0)) | length)
    }'
```

## By Model

```bash
cat "$COSTS" | jq -s 'group_by(.model)
  | map({model: .[0].model, rows: length, estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | sort_by(-.estimated_cost_usd)'
```

## By Session

```bash
cat "$COSTS" | jq -s 'group_by(.session_id)
  | map({session: .[0].session_id, started: (map(.timestamp) | min), estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | sort_by(.started) | reverse | .[0:10]'
```

## Last Seven Days

```bash
cat "$COSTS" | jq -s '((now - 6 * 86400) | strftime("%Y-%m-%d")) as $since
  | map(select(.timestamp[0:10] >= $since))
  | group_by(.timestamp[0:10])
  | map({date: .[0].timestamp[0:10], rows: length, estimated_cost_usd: (map(.estimated_cost_usd) | add)})
  | reverse'
```

## CSV Export

If the user asks for `/cost-report csv`, export the 100 most recent rows:

```bash
cat "$COSTS" | jq -rs '["timestamp","session_id","model","input_tokens","output_tokens","estimated_cost_usd"],
  (sort_by(.timestamp) | reverse | .[0:100][]
    | [.timestamp, .session_id, .model, .input_tokens, .output_tokens, .estimated_cost_usd])
  | @csv'
```

## Report Format

Format the response as:

1. Summary: today, yesterday, total, rows and sessions.
2. By model: models ranked by estimated cost.
3. By session: the ten most recent sessions.
4. Last seven days: date, estimated cost, row count.

Call every amount an estimate: `estimated_cost_usd` is priced from EGC's
per-tier rates (`scripts/lib/llm-costs.js`), not the provider's bill. Say how
many rows report no tokens, since those stops undercount. Use four decimal
places for sub-dollar amounts. Neither file records the project or the tool,
so do not offer those breakdowns.

## Source

Salvaged from stale community PR #1304 by `MayurBhavsar`, rewritten to read the
ledger EGC actually writes (#1701).
