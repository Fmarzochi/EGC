# EGC Vision

EGC is a local engine that gives every AI coding tool on a machine the same brain: one persistent memory, one live bus between open sessions, one safety layer in front of every command, and one filter that keeps noisy output away from the model. Twenty tools, one package, nothing leaving the machine.

This document is the direction. The release-by-release record lives in [ROADMAP.md](ROADMAP.md).

## What EGC is

- **Memory.** Decisions, session context, working memory and lessons, encrypted at rest with AES-256-GCM, kept per project and branch in the person's home directory, shared by every tool through the `egc-memory` MCP server.
- **Session Mesh.** A local bus where open sessions announce themselves, claim paths, exchange events and hand work to each other.
- **Guardian.** Command validation, write gating and context reduction through the `egc-guardian` MCP server and each tool's own hooks.
- **Token Crusher.** Compression of shell output before it reaches the model, with a local ledger of what it saved.

The prompt library (agents, skills, commands and rules) ships in the same package and stays optional: `egc install` delivers the engine, the library is one flag away, and the engine works exactly the same without it.

## Principles

1. **Engine first.** The engine is what EGC is; the library is content that rides on it. Positioning, defaults and documentation lead with the engine.
2. **Local first, private by default.** Memory never leaves the machine and is never committed. No cloud is required for a local install.
3. **One package.** `@egchq/egc` ships the engine and the library together, and that does not change. Splitting the package would double the maintenance surface and split the community; opt-in flags and profiles give the same choice without it.
4. **Honest integrations.** Every supported tool has a documented install path, and its support level says what the maintainers guarantee: see [support levels](governance/support-levels.md).
5. **Free engine.** The engine is Apache-2.0 and stays free. If EGC ever offers something paid, it will be a team layer on top of the engine (Team Brain below), never the memory on the machine.

## Where EGC is going

- **Agent Memory Interchange.** A specification for how memory moves between agents and tools, so EGC's memory is readable and writable by anything that speaks the format; `egc export` is the first reference implementation (see [spec/](spec/README.md)).
- **Team Brain.** Shared memory across a team: organization-level installs, role-based scoping, cross-project federation and a stable, versioned MCP API. This is the only layer where a commercial offer is ever considered, and only after the engine has the adoption to justify it.
- **Public savings.** The Token Crusher's ledger, `egc gain`, as a number people can compare and publish.
- **One-command onboarding.** With the library opt-in, the three-stage install (bare install, project setup, optional library) folds into a single guided `egc install`.

## Sustainability

EGC is maintained by one developer. The plan against a bus factor of one is people before money: area stewards who own an integration or a subsystem ([governance/stewards.md](governance/stewards.md)), community missions for the work that does not need the maintainer, and sponsors who keep the lights on. The engine stays free through all of it.

## Milestones

### v1.2.0: Teams

Multi-developer workflows and shared context:

- Shared state between team members (multi-user installations beyond git-backend team memory)
- Organization-level installations and role-based context scoping
- Cross-project memory federation
- Stable MCP server API with versioned interfaces
- `egc-guardian` and `egc-memory` promoted to GA with backward-compatibility guarantees

### v1.3.0: Growth

- Community translations: Ukrainian, Malay (German, French, Italian, and Turkish shipped across v1.1.14 and v1.1.15)
- Per-project skill profiles and overrides
- OSS-Fuzz integration for continuous fuzz testing

### v2.0.0: Enterprise

- Formal security review by an independent party
- SBOM (Software Bill of Materials) generation
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
