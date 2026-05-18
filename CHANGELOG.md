# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog (<https://keepachangelog.com/en/1.1.0/>),
and this project adheres to Semantic Versioning (<https://semver.org/spec/v2.0.0.html>).

## [Unreleased]

## [1.0.0] — 2026-05-18

### Added

- ExecutionOrchestrator queue with `submit_task`, `await_task`, dispatch loop,
  dead-letter handling, and snapshot accessors for cross-runtime visibility.
- Dashboard Execute tab supporting both subprocess and orchestrator-backed
  execution modes, including a Node-to-Python ReAct bridge entry point.
- Cross-runtime telemetry CLIs: `scripts/ci/runtime-topology.js`,
  `scripts/ci/runtime-snapshot.js`, and `scripts/ci/capability-graph.js`.
- WorkflowEngine parallel execution mode with deterministic JSON workflow
  records under `.sessions/workflows/`.
- Plugin runtime catalog covering 62 agents, 228 skills, and 74 commands,
  validated by the CI catalog gate.
- Phase 7 high-concurrency runtime maturation hooks, Python CI lane, and
  bridge smoke tests for the multi-provider ReAct runtime.
- Architecture entry-point index, SUBSYSTEM-MAP, and dormant/archival
  breadcrumbs for governance discoverability.

### Changed

- Consolidated the canonical project name to EGC (Everything Gemini Code)
  and migrated the hero/logo asset to `assets/images/egc-logo.png`.
- README and plugin manifests synchronized with the validated repository
  state (agent, skill, and command inventories).
- Architecture narrative corrected to describe EGC as a steady-state
  multi-harness runtime rather than a transitional surface.

### Fixed

- Windows PowerShell quoting in `install.ps1` so inner quotes are no longer
  shelled into Node/Python version checks.
- Converted 486 absolute symlinks to relative paths and removed the broken
  Yarn release plus orphan hook to make the tree portable across machines.
- Windows test timeouts raised from 10s to 30s on `win32` to absorb slower
  subprocess startup, plus a dashboard Python smoke test for parity.
- Restored `.cursor/` and `.codex/` source files and narrowed `.gitignore`
  so harness install targets ship with their seed configuration.
- Added the `markdownlint-cli` devDependency and resolved the remaining
  markdown violations and the final `eslint` `no-empty` failure.
- Normalized backslashes when matching baseline-absent paths in tests so
  Windows lanes no longer false-fail on path comparison.
