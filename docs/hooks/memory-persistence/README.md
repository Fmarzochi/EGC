# Memory persistence hooks

This directory holds the slice of [hooks/hooks.json](../../../hooks/hooks.json) that keeps project memory alive across sessions and compactions: the lifecycle entries that load the project state when a session starts and save it before the context is compacted, when the assistant stops, and when the session ends.

`hooks.json` here is a verbatim subset of the root file, kept in sync by `tests/hooks/memory-persistence-parity.test.js`: every hook in it, with the fields of its group, must exist byte for byte under the same event in the root `hooks.json`, and every root hook that runs a memory script must be here. Edit the root file; the test tells you when this slice has to follow.

| Event | Script | What it does |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-start-bootstrap.js`, `scripts/hooks/egc-memory-load.js` | Loads the previous project state and briefs the session |
| `PreCompact` | `scripts/hooks/pre-compact.js`, `scripts/hooks/egc-memory-save.js`, `scripts/hooks/session-memory-miner.js` | Saves the state before compaction and mines the transcript for decisions |
| `Stop` | `scripts/hooks/session-end.js`, `scripts/hooks/egc-memory-save.js` | Persists the state after each response when a transcript path is available |
| `SessionEnd` | `scripts/hooks/session-end-marker.js`, `scripts/hooks/session-memory-miner.js`, `scripts/hooks/session-auto-learn.js` | Writes the end marker, mines the transcript, and turns recurring tool failures into recommendations |

The commands in this file are the repository's own, written against the plugin root the way the root file is. This copy is documentation and nothing installs it: no tool reads a hooks file nested under its hooks directory, so shipping it would only leave a file on every machine that nobody reads. The installer gets the memory hooks from `hooks/hooks.json` through the `hooks-runtime` module, rewritten against the real tool root, and that is the supported way to get them onto a machine. Read this slice to know which hooks carry the memory guarantees, and use it as the source when a tool of your own needs only those entries. The runtime controls (`EGC_DISABLED_HOOKS`, `EGC_HOOK_PROFILE`) apply to these entries exactly as they apply to the root file.
