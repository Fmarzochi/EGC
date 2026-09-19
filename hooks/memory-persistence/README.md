# Memory persistence hooks

This directory holds the slice of [hooks.json](../hooks.json) that keeps project memory alive across sessions and compactions: the lifecycle entries that load the project state when a session starts and save it before the context is compacted, when the assistant stops, and when the session ends.

`hooks.json` here is a verbatim subset of the root file, kept in sync by `tests/hooks/memory-persistence-parity.test.js`: every entry in it must exist, byte for byte, under the same event in the root `hooks.json`. Edit the root file; the test tells you when this slice has to follow.

| Event | Script | What it does |
|---|---|---|
| `SessionStart` | `scripts/hooks/egc-memory-load.js` | Loads the previous project state and briefs the session |
| `PreCompact` | `scripts/hooks/egc-memory-save.js`, `scripts/hooks/pre-compact.js`, `scripts/hooks/session-memory-miner.js` | Saves the state before compaction and mines the transcript for decisions |
| `Stop` | `scripts/hooks/egc-memory-save.js`, `scripts/hooks/session-end.js` | Persists the state after each response when a transcript path is available |
| `SessionEnd` | `scripts/hooks/session-memory-miner.js`, `scripts/hooks/session-auto-learn.js`, `scripts/hooks/session-end-marker.js` | Mines the transcript, turns recurring tool failures into recommendations, and writes the end marker |

Use this slice when a project wants only the memory guarantees and none of the other hooks: merge it into the tool's hook settings the same way [hooks/README.md](../README.md#installing-these-hooks-manually) describes for the root file. The runtime controls (`EGC_DISABLED_HOOKS`, `EGC_HOOK_PROFILE`) apply to these entries exactly as they apply to the root file.
