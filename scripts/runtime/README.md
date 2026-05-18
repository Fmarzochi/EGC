# scripts/runtime — DORMANT

`router.js`, `discovery.js`, `mount-all.js`, `unmount-all.js`, and
`activator.js` implement a dynamic skill router that would materialize
skills into `.agents/skills/` based on `runtime-map.json`.

**Status: DORMANT.**

Each script resolves the registry as `registry/runtime-map.json`
(top-level), but the real path is `internal/registry/runtime-map.json`.
There is no `registry/` directory and no script regenerates it, so every
entry point fails with `ENOENT` when invoked. CI does not call them,
`package.json` `bin` entries do not reference them, and the static plugin
manifests (`.gemini-plugin/plugin.json`, `.codex-plugin/plugin.json`)
plus the install adapters under `scripts/lib/install-targets/` drive the
runtime instead.

To inspect the catalog without this subsystem:

```bash
node scripts/ci/catalog.js --text
```

To materialize skills into a target harness:

```bash
./install.sh --target <harness> [modules...]
npx egc-install --target <harness> [modules...]
```

This subsystem is preserved for design reference. Do not revive
opportunistically. See `docs/governance/SUBSYSTEM-MAP.md` for the full
classification.

Direct invocation of these scripts now exits with code 2 and a DORMANT
notice. The source is preserved for architectural reference per
`docs/governance/SUBSYSTEM-MAP.md`.
