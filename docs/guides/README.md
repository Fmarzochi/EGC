# EGC Guides

Operational and contributor walk-throughs. These are tutorial-shaped
documents; for architecture or governance see `../architecture/` and
`../governance/`.

| File | Scope |
|---|---|
| `SKILL-DEVELOPMENT-GUIDE.md` | End-to-end walk-through for authoring a new skill (frontmatter, structure, namespace placement) |
| `MANUAL-ADAPTATION-GUIDE.md` | How to manually port a skill or hook into another harness layout |
| `ANTIGRAVITY-GUIDE.md` | Worked example: selective install into the Antigravity harness via `install.sh --target antigravity` |
| `TROUBLESHOOTING.md` | Recovery procedures for common runtime/install issues |
| `hook-bug-workarounds.md` | Documented workarounds for upstream hook behavior quirks |
| `token-optimization.md` | Token-budget guidance and EGC-side MCP-disable mechanics |
| `preflight.md` | `npm run preflight`: the lint findings a branch adds against `origin/main`, before you push |

The `examples/` subfolder ships templates referenced from the guides
(currently `product-capability-template.md`,
`project-guidelines-template.md`).
