---
name: skill-router
description: Describes how skills and agents from the EGC library are surfaced to a target harness, and how to inspect or install the catalog. Use when the user asks which skills/agents EGC ships, or wants to discover or install a curated profile.
origin: EGC
---

# Skill Router

The **Skill Router** describes how skills and agents from the EGC library
(180+ components) are surfaced to a target harness.

## When to Use

- When you need to discover which skills and agents EGC ships.
- When you want to install a curated profile or specific modules into a target
  harness (Cursor, Codex, Gemini, compatible harness, etc.).
- When you want to understand how the runtime composes the active skill set.

## Status

The dynamic skill router (`scripts/runtime/router.js`) is not active in the
current v1.x release. The runtime is fully driven by the static plugin
manifests (`.gemini-plugin/plugin.json`, `.codex-plugin/plugin.json`) and the
install adapters in `scripts/lib/install-targets/`.

To inspect the available skill catalog, run:

```bash
node scripts/ci/catalog.js --text
```

To install a profile or specific modules into a target harness:

```bash
./install.sh --target cursor --dry-run typescript
npx egc-install --target codex typescript
```

## Safety Rules

- **Non-Destructive**: Never delete physical files in `skills/` or `agents/`.
- **Manifest Driven**: Treat the plugin manifests and install adapters as the
  source of truth; do not create ad-hoc symlinks that bypass them.
- **Runtime Awareness**: Some skills require specific runtimes (Python/Node).
  Ensure required dependencies are installed in the target environment.
