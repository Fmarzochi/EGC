# Antigravity Setup and Usage Guide

Google's [Antigravity](https://antigravity.dev) is an AI coding IDE that uses a `.agent/` directory convention for configuration. egc provides first-class support for Antigravity through its selective install system.

## Quick Start

```bash
# Install egc with Antigravity target
./install.sh --target antigravity typescript

# Or with multiple language modules
./install.sh --target antigravity typescript python go
```

This installs egc components into your project's `.agent/` directory, ready for Antigravity to pick up.

## How the Install Mapping Works

egc remaps its component structure to match Antigravity's expected layout:

| egc Source | Antigravity Destination | What It Contains |
|------------|------------------------|------------------|
| `rules/` | `.agent/rules/` | Language rules and coding standards (flattened) |
| `commands/` | `.agent/workflows/` | Slash commands become Antigravity workflows |
| `agents/` | `.agent/skills/` | Agent definitions become Antigravity skills |

> **Note on `.agents/` vs `.agent/` vs `agents/`**: The installer only handles three source paths explicitly: `rules` → `.agent/rules/`, `commands` → `.agent/workflows/`, and `agents` (no dot prefix) → `.agent/skills/`. The dot-prefixed `.agents/` directory in the egc repo is a **static layout** for Codex/Antigravity skill definitions and `openai.yaml` configs — it is not directly mapped by the installer. Any `.agents/` path falls through to the default scaffold operation. If you want `.agents/skills/` content available in the Antigravity runtime, you must manually copy it to `.agent/skills/`.

### Key Differences from gemini Code

- **Rules are flattened**: gemini Code nests rules under subdirectories (`rules/common/`, `rules/typescript/`). Antigravity expects a flat `rules/` directory — the installer handles this automatically.
- **Commands become workflows**: egc's `/command` files land in `.agent/workflows/`, which is Antigravity's equivalent of slash commands.
- **Agents become skills**: egc agent definitions map to `.agent/skills/`, where Antigravity looks for skill configurations.

## Directory Structure After Install

```
your-project/
├── .agent/
│   ├── rules/
│   │   ├── coding-standards.md
│   │   ├── testing.md
│   │   ├── security.md
│   │   └── typescript.md          # language-specific rules
│   ├── workflows/
│   │   ├── plan.md
│   │   ├── code-review.md
│   │   ├── tdd.md
│   │   └── ...
│   ├── skills/
│   │   ├── planner.md
│   │   ├── code-reviewer.md
│   │   ├── tdd-guide.md
│   │   └── ...
│   └── egc-install-state.json     # tracks what egc installed
```

## The `openai.yaml` Agent Config

Each skill directory under `.agents/skills/` contains an `agents/openai.yaml` file at the path `.agents/skills/<skill-name>/agents/openai.yaml` that configures the skill for Antigravity:

```yaml
interface:
  display_name: "API Design"
  short_description: "REST API design patterns and best practices"
  brand_color: "#F97316"
  default_prompt: "Design REST API: resources, status codes, pagination"
policy:
  allow_implicit_invocation: true
```

| Field | Purpose |
|-------|---------|
| `display_name` | Human-readable name shown in Antigravity's UI |
| `short_description` | Brief description of what the skill does |
| `brand_color` | Hex color for the skill's visual badge |
| `default_prompt` | Suggested prompt when the skill is invoked manually |
| `allow_implicit_invocation` | When `true`, Antigravity can activate the skill automatically based on context |

## Managing Your Installation

### Check What's Installed

```bash
node scripts/list-installed.js --target antigravity
```

### Repair a Broken Install

```bash
# First, diagnose what's wrong
node scripts/doctor.js --target antigravity

# Then, restore missing or drifted files
node scripts/repair.js --target antigravity
```

### Uninstall

```bash
node scripts/uninstall.js --target antigravity
```

### Install State

The installer writes `.agent/egc-install-state.json` to track which files egc owns. This enables safe uninstall and repair — egc will never touch files it didn't create.

## Adding Custom Skills for Antigravity

If you're contributing a new skill and want it available on Antigravity:

1. Create the skill under `skills/your-skill-name/SKILL.md` as usual
2. Add an agent definition at `agents/your-skill-name.md` — this is the path the installer maps to `.agent/skills/` at runtime, making your skill available in the Antigravity harness
3. Add the Antigravity agent config at `.agents/skills/your-skill-name/agents/openai.yaml` — this is a static repo layout consumed by Codex for implicit invocation metadata
4. Mirror the `SKILL.md` content to `.agents/skills/your-skill-name/SKILL.md` — this static copy is used by Codex and serves as a reference for Antigravity
5. Mention in your PR that you added Antigravity support

> **Key distinction**: The installer deploys `agents/` (no dot) → `.agent/skills/` — this is what makes skills available at runtime. The `.agents/` (dot-prefixed) directory is a separate static layout for Codex `openai.yaml` configs and is not auto-deployed by the installer.

See [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) for the full contribution guide.

## Comparison with Other Targets

| Feature | gemini Code | Cursor | Codex | Antigravity |
|---------|-------------|--------|-------|-------------|
| Install target | `gemini-home` | `cursor-project` | `codex-home` | `antigravity` |
| Config root | `~/.gemini/` | `.cursor/` | `~/.codex/` | `.agent/` |
| Scope | User-level | Project-level | User-level | Project-level |
| Rules format | Nested dirs | Flat | Flat | Flat |
| Commands | `commands/` | N/A | N/A | `workflows/` |
| Agents/Skills | `agents/` | N/A | N/A | `skills/` |
| Install state | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` |

## Troubleshooting

### Skills not loading in Antigravity

- Verify the `.agent/` directory exists in your project root (not home directory)
- Check that `egc-install-state.json` was created — if missing, re-run the installer
- Ensure files have `.md` extension and valid frontmatter

### Rules not applying

- Rules must be in `.agent/rules/`, not nested in subdirectories
- Run `node scripts/doctor.js --target antigravity` to verify the install

### Workflows not available

- Antigravity looks for workflows in `.agent/workflows/`, not `commands/`
- If you manually copied egc commands, rename the directory

## Related Resources

- [Selective Install Architecture](./SELECTIVE-INSTALL-ARCHITECTURE.md) — how the install system works under the hood
- [Selective Install Design](./SELECTIVE-INSTALL-DESIGN.md) — design decisions and target adapter contracts
- [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) — how to contribute skills, agents, and commands
