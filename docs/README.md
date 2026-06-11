# EGC Documentation

This directory is the canonical entry point for everything that is not the
user-facing `README.md` at the repository root.

If you are unsure where to look first, start at `governance/SUBSYSTEM-MAP.md`
for the formal classification of every subsystem.

## Layout

| Folder | Purpose | Start here |
|---|---|---|
| `architecture/` | Long-form architecture, current and target | `architecture/README.md` |
| `governance/` | Subsystem classification, skill/agent policies | `governance/README.md` |
| `guides/` | Operational and contributor walk-throughs | `guides/README.md` |
| `installation/` | Setup playbooks for downstream stacks | `installation/HERMES-SETUP.md` |
| `runtime/` | Runtime contracts (command/agent map, session adapter) | direct files |

## Cross-references

- Root `README.md` — user-facing project overview and quickstart.
- `.github/CONTRIBUTING.md` — engineering governance and contribution workflow.
- `docs/RULES.md` — engine governance rules.
- `.github/SECURITY.md` — vulnerability disclosure.

## Reading order for a new contributor

1. Root `README.md` — what EGC is and how to install it.
2. `governance/SUBSYSTEM-MAP.md` — what every directory is for.
3. `architecture/README.md` — the layered runtime model.
4. `.github/CONTRIBUTING.md` — how to propose changes.
5. `guides/SKILL-DEVELOPMENT-GUIDE.md` if authoring a skill, or
   `guides/ANTIGRAVITY-GUIDE.md` for a worked installer example.
