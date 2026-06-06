# Hook Bug Workarounds

Community-tested workarounds for current gemini Code bugs that can affect egc hook-heavy setups.

This page is intentionally narrow: it collects the highest-signal operational fixes from the longer troubleshooting surface without repeating speculative or unsupported configuration advice. These are upstream gemini Code behaviors, not egc bugs.

## When To Use This Page

Use this page when you are specifically debugging:

- false `Hook Error` labels on otherwise successful hook runs
- earlier-than-expected compaction
- MCP connectors that look authenticated but fail after compaction
- hook edits that do not hot-reload
- repeated `529 Overloaded` responses under heavy hook/tool pressure

For the fuller egc troubleshooting surface, use [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## High-Signal Workarounds

### False `Hook Error` labels

What helps:

- Consume stdin at the start of shell hooks (`input=$(cat)`).
- Keep stdout quiet for simple allow/block hooks unless your hook explicitly requires structured stdout.
- Send human-readable diagnostics to stderr.
- Use the correct exit codes: `0` allow, `2` block, other non-zero values are treated as errors.

```bash
input=$(cat)
echo "[BLOCKED] Reason here" >&2
exit 2
```

### Earlier-than-expected compaction

What helps:

- Remove `gemini_AUTOCOMPACT_PCT_OVERRIDE` if lowering it causes earlier compaction in your build.
- Prefer manual `/compact` at natural task boundaries.
- Use egc's `strategic-compact` guidance instead of forcing a lower threshold.

### MCP auth looks live but fails after compaction

What helps:

- Toggle the affected connector off and back on after compaction.
- If your gemini Code build supports it, add a lightweight `PostCompact` reminder hook that tells you to re-check connector auth.
- Treat this as a recovery reminder, not a permanent fix.

### Hook edits do not hot-reload

What helps:

- Restart the gemini Code session after changing hooks.
- Advanced users sometimes use shell-local reload helpers, but egc does not ship one because those approaches are shell- and platform-dependent.

### Repeated `529 Overloaded`

What helps:

- Reduce tool-definition pressure with `ENABLE_TOOL_SEARCH=auto:5` if your setup supports it.
- Lower `MAX_THINKING_TOKENS` for routine work.
- Route subagent work to a cheaper model such as `gemini_CODE_SUBAGENT_MODEL=haiku` if your setup exposes that knob.
- Disable unused MCP servers per project.
- Compact manually at natural breakpoints instead of waiting for auto-compaction.

## Related egc Docs

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- [token-optimization.md](./token-optimization.md)
- [hooks/README.md](../hooks/README.md)
- [issue #644](https://github.com/Fmarzochi/EGC-code/issues/644)
