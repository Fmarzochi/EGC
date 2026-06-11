# EGC Roadmap

This document describes the planned development direction for EGC (Extended Global Context).

## v1.1.0 — Quality and Coverage

- Statement coverage >= 80% for all production scripts
- ESLint cyclomatic complexity violations eliminated across all files
- GPG-signed release tags
- Automated dependency audit in CI

## v1.2.0 — Ecosystem Expansion

- Support for additional AI harnesses (Zed, Windsurf, Continue)
- Plugin system for community-contributed agents and skills
- Per-project skill profiles and overrides

## v1.3.0 — Governance and Security

- Formal security review by an independent party
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)
- SBOM (Software Bill of Materials) generation

## v2.0.0 — Production Runtime

- Stable MCP server API with versioned interfaces
- egc-guardian and egc-memory promoted to GA
- Cross-project memory federation
- Team and organization-level installations

## Non-Goals

- EGC does not aim to replace AI providers — it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
