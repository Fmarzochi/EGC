# EGC Vision

EGC is a local engine that gives every AI coding tool on a machine the same brain: one persistent memory, one live bus between open sessions, one safety layer in front of every command, and one filter that keeps noisy output away from the model. Twenty-nine tools, one package, nothing leaving the machine unless the person sets up a team remote of their own, and then only sealed.

This document is the direction. The release-by-release record lives in [ROADMAP.md](ROADMAP.md).

## What EGC is

- **Memory.** Decisions, session context, working memory and lessons, encrypted at rest with AES-256-GCM, kept per project and branch in the person's home directory, shared by every tool through the `egc-memory` MCP server.
- **Session Mesh.** A local bus where open sessions announce themselves, claim paths, exchange events and hand work to each other.
- **Guardian.** Command validation, write gating and context reduction through the `egc-guardian` MCP server and each tool's own hooks.
- **Token Crusher.** Compression of shell output before it reaches the model, with a local ledger of what it saved.

The prompt library (agents, skills, commands and rules) ships in the same package and stays optional: `egc install` delivers the engine, the library is one flag away, and the engine works exactly the same without it.

## Principles

1. **Engine first.** The engine is what EGC is; the library is content that rides on it. Positioning, defaults and documentation lead with the engine.
2. **Local first, private by default.** Memory stays on the machine and is never committed to a project repository. The one way it travels is the team sync the person opts into, to a remote they own, sealed with the team key before it leaves the machine. No cloud is required for a local install.
3. **One package.** `@egchq/egc` ships the engine and the library together, and that does not change. Splitting the package would double the maintenance surface and split the community; opt-in flags and profiles give the same choice without it.
4. **Honest integrations.** Every supported tool has a documented install path, and its support level says what the maintainers guarantee: see [support levels](governance/support-levels.md).
5. **Free engine.** The engine is Apache-2.0 and stays free, Team Brain for one person included. What EGC will charge for is a hosted team service on top of the engine (Team Brain below), never the memory on the machine, and never a check inside the open-source code: anything placed there can be removed, so the line between free and paid lives in the service.

## Where EGC is going

- **Agent Memory Interchange.** A specification for how memory moves between agents and tools, so EGC's memory is readable and writable by anything that speaks the format; `egc export` and `egc import` are its reference implementations, the way out and the way back (see [spec/](spec/README.md)).
- **Team Brain.** Shared memory across machines and people. For one person it is part of the free engine: two or more machines on their own network, synchronized through a git remote they own, with no server of ours. For a team inside a company it becomes a paid service on top of the same code: a relay in real time, key distribution and rotation, SSO and SCIM, an audit trail and a dashboard, with organization-level installs, role-based scoping, cross-project federation and a stable, versioned MCP API. How a company buys it without touching the source code is designed once the single-person flow works.
- **Neural mesh, the next layers.** The real-time layer already ships on each machine: sessions in every supported tool announce what they work on, address each other and claim the files they edit through the session tools; a session parked in `session_wait` wakes the moment a peer writes to the bus, and the hosts whose hook can inject context (Claude Code, Antigravity, Codex, Trae, Amp, Kiro and OpenCode 2) get the notice at the turn boundary, with expiring events and a cap on what one sender can leave unread. Between the machines of one person the same bus now crosses the network through a central the person runs on one of their own machines (`egc mesh serve`, as a service of the session, found on the home network or reached by an address, with a new machine joining after a six-digit check on both screens that confirms an X25519 exchange, not a credential: digits that differ mean different exchanges, the same digits make an intermediary unlikely, not impossible), never a server of ours: a tab on one computer sees what another computer works on, events and locks cross, and the state documents of one machine reach the others sealed through the mesh, with no git between them, within the size the mesh carries and never what looks like a credential; the lessons, the decisions and the working memory travel with the git sync when it is on. It is part of the free engine, and the same bridge runs over a NATS server for whoever already has one (`egc mesh connect nats://...`), with the same seal: the server sees the subjects, the times and the sizes, never what is said, and a `tls://` address or a VPN covers a path that is not trusted, as `wss://` does for the central. Next: roles a group of sessions agrees on (conductor, worker, reviewer), handoffs in the middle of a task, locks that negotiate instead of refusing, and hop limits with a human circuit breaker as part of the protocol.
- **Public savings.** The Token Crusher's ledger, `egc gain`, as a number people can compare and publish.
- **One-command onboarding.** With the library opt-in, the three-stage install (bare install, project setup, optional library) folds into a single guided `egc install`.

## Sustainability

EGC is maintained by one developer. The plan against a bus factor of one is people before money: area stewards who own an integration or a subsystem ([governance/stewards.md](governance/stewards.md)), community missions for the work that does not need the maintainer, and sponsors who keep the lights on. The engine stays free through all of it.

## Milestones

### Next release (1.1.24): Team Brain for one person

Decided on 2026-11-01. Targeted at the next release; no date is promised until it ships. It builds on the `egc team` commands and the `team_init`, `team_sync` and `team_status` tools that already synchronize memory over a git remote, and turns them into something one person can trust between their own machines:

- The same repository is the same project on every machine: the state is keyed by the normalized `origin` remote when the checkout has one, under the home or the temp directory, and by the folder path otherwise (#2063)
- A merge of the memory documents with retire marks and caps instead of last-write-wins (#2055); the author of a document travels in its header, and a signature per member moved to the team service below (#2056)
- Secrets refused on the way out, and size and rate limits on the sync
- `egc team leave` next to `init`, `sync`, `autosync` and `status` (joining is `init --key`), a subcommand this release adds; `members` and key rotation belong to the team service below
- Pull and push through the hooks of the tools: around the session in Claude Code, OpenCode (#2059) and GitHub Copilot (its `SessionStart` hook pulls and hands the project memory to the session as `additionalContext`, its `Stop` hook pushes when a state document changed since the last run, the first run pushing whatever is new), at the turn boundary in Antigravity, Codex, Trae, Amp and Kiro; Cursor's prompt hook cannot inject context, so it reads the shared state when a session starts
- Team health in `egc doctor` (#2058) and a marker of the team key in the shared repository, so a wrong key fails at `init` (#2080)
- No feature flag: the Team Brain is on when `~/.egc/team.json` exists and off when it does not; the autosync, opt-in today (`init --autosync` or `egc team autosync on`), becomes on from `egc team init` in this release, with `egc team autosync off` to turn it off
- The session mesh between a person's machines in real time is part of the free engine, through a central the person runs on one of their own machines and never a server of ours; it ships in this release (the central, the bridge, events and locks, the state through the mesh, the discovery on the home network, the central as a service, the pairing by a short code), and the hosted relay is the team service below

### Later: Team Brain for companies, as a paid service

About three releases after the single-person Team Brain, on top of the same code and never as a lock inside it:

- A relay in real time between machines hosted by us, an identity per machine and a signature per member in the envelope (#2056), key distribution and rotation for a team with `members` and `rotate` commands, SSO and SCIM, an audit trail and a dashboard
- Organization-level installations and role-based context scoping
- Cross-project memory federation
- Stable MCP server API with versioned interfaces
- `egc-guardian` and `egc-memory` promoted to GA with backward-compatibility guarantees
- How a company buys it without touching the source code is designed once the single-person flow has shipped

### v1.3.0: Growth

- Community translations: Ukrainian, Malay (German, French, Italian and Turkish already shipped)
- Per-project skill profiles and overrides
- OSS-Fuzz integration for continuous fuzz testing

### v2.0.0: Enterprise

- Formal security review by an independent party
- SBOM (Software Bill of Materials) generation
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code or memory to any third party; the opt-in team sync sends only sealed memory to a remote the person chose
- EGC does not require cloud connectivity for local installations
