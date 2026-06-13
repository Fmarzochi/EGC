# EGC Roadmap

This document describes the planned development direction for EGC (Extended Global Context).

## v1.1.0: Memory Expansion (Released 2026-06-13)

- `working_memory`: transient key-value store with TTL (issue #138)
- `lessons`: cross-session knowledge with confidence decay (issue #140)
- `detect_patterns`: behavioral analysis from hook events (issue #141)
- `compress_observations`: rule-based observation compression (issue #142)
- `search_history`: BM25 full-text search over decisions (issue #139)
- Branch-aware project state: `get_state`/`update_state` scope per git branch (issue #137)
- State consolidation pipeline on each `update_state` call (issue #143)
- SessionStart hook runs idempotently across harness reinstalls

## v1.2.0: Ecosystem Expansion

- Support for additional AI harnesses (Zed, Windsurf, Continue)
- Plugin system for community-contributed agents and skills
- Per-project skill profiles and overrides

## v1.3.0: Governance and Security

- Formal security review by an independent party
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)
- SBOM (Software Bill of Materials) generation

## v2.0.0: Production Runtime

- Stable MCP server API with versioned interfaces
- egc-guardian and egc-memory promoted to GA
- Cross-project memory federation
- Team and organization-level installations

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
