# scripts/runtime

`router.js`, `mount-all.js`, `unmount-all.js`, and
`activator.js` implement a dynamic skill router that would materialize
skills into `.agents/skills/`.

**Status: DORMANT.**

`discovery.js` is **ACTIVE** and serves as the Topology Hot Cache compiler. It compiles the runtime map into `internal/registry/runtime-map.json`.

The dormant scripts resolve the registry as `registry/runtime-map.json` (top-level) which doesn't exist, and fail with `ENOENT`. CI does not call them, `package.json` `bin` entries do not reference them, and the static plugin manifests plus the install adapters under `scripts/lib/install-targets/` drive the runtime instead.

To inspect the catalog without this subsystem:

```bash
node scripts/ci/catalog.js --text
```

To materialize skills into a target harness:

```bash
./install.sh --target <harness> [modules...]
npx egc-install --target <harness> [modules...]
```

This subsystem (excluding `discovery.js`) is preserved for design reference. Do not revive opportunistically. See `docs/governance/SUBSYSTEM-MAP.md` for the full classification.

Direct invocation of the dormant scripts exits with code 2 and a DORMANT notice.
