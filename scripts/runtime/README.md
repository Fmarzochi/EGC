# scripts/runtime

Three files here are part of a running EGC; the rest belong to a Python
orchestration runtime that nothing starts. `tests/docs/subsystem-map-docs.test.js`
fails when a file in this folder is missing from this page, or when this page
names a file that is not here.

## Active

- `discovery.js` builds the topology cache `internal/registry/runtime-map.json`
  from the install manifests. `scripts/install-apply.js` calls it after an
  install; `internal/` is gitignored.
- `session_bridge.py` is started by the `sessionstart:egc-session-bridge` hook
  (`scripts/hooks/egc-session-bridge.js`) with the plugin's Python.
- `tracer.py` records the events `session_bridge.py` emits.

## Dormant

- `async_task_queue.py`, `doctor_core.py`, `egc_orchestrate_cli.py`,
  `event_bus.py`, `exceptions.py`, `memory_mesh.py`, `profiler.py`,
  `runtime_context.py` and `session_manager.py` belong to the orchestration
  runtime in `scripts/orchestration/`, `scripts/execution/` and
  `scripts/workflows/`. No CLI command, hook or npm script starts that
  runtime, and its tests in `scripts/tests/` sit outside the `pytest tests/`
  step of CI.

`scripts/ci/runtime-topology.js` and `scripts/ci/runtime-snapshot.js` read
these files for the CI smoke checks; they do not run them.

To inspect the catalog:

```bash
node scripts/ci/catalog.js --text
```

To install skills into a tool:

```bash
egc install --target <tool> --profile full
```

See `docs/governance/SUBSYSTEM-MAP.md` for the full classification. Do not
revive the dormant files opportunistically.
