# Antigravity Setup and Usage Guide

Google's [Antigravity](https://antigravity.dev) is an AI coding IDE that uses a `.agents/` directory convention for configuration. egc provides first-class support for Antigravity through its selective install system.

## Quick Start

```bash
# Install egc with Antigravity target
sh scripts/install.sh --target antigravity typescript

# Or with multiple language modules
sh scripts/install.sh --target antigravity typescript python go
```

This installs egc components into your project's `.agents/` directory, ready for Antigravity to pick up.

## How the Install Mapping Works

egc remaps its component structure to match Antigravity's expected layout:

| egc Source | Antigravity Destination | What It Contains |
|------------|------------------------|------------------|
| `rules/` | `.agents/rules/` | Language rules and coding standards (flattened) |
| `commands/` | `.agents/workflows/` | Slash commands become Antigravity workflows |
| `agents/` | `.agents/agents/` | Agent definitions become Antigravity subagents |

> **Note on the repository's `.agents/` vs `agents/`**: The installer maps `rules` → `.agents/rules/`, `commands` → `.agents/workflows/`, `agents` (no dot prefix) → `.agents/agents/` and `skills` → `.agents/skills/<name>/` in your project. The dot-prefixed `.agents/` directory in the egc repository is a **static layout** for Codex skill definitions and `openai.yaml` configs: it is not what the installer deploys.

### Key differences from the home install (`egc` target)

- **Rules are flattened**: Antigravity expects a flat `rules/` directory (`~/.gemini/config/rules/` for the home install): the installer names each file `<group>-<rule>.md`.
- **Commands become workflows**: egc's `/command` files land in `.agents/workflows/`, which is Antigravity's equivalent of slash commands.
- **Agents become subagents**: egc agent definitions land in `.agents/agents/` (`~/.gemini/config/agents/` for the home install), where Antigravity reads custom subagents, with the frontmatter rewritten to the subagent format: Antigravity tool names, `model: pro`, `flash` or inherited.

## Directory Structure After Install

```
your-project/
├── .agents/
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
│   ├── agents/
│   │   ├── planner.md
│   │   ├── code-reviewer.md
│   │   ├── tdd-guide.md
│   │   └── ...
│   ├── skills/
│   │   ├── tdd-workflow/SKILL.md
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

The installer writes `.agents/egc-install-state.json` to track which files egc owns. This enables safe uninstall and repair: egc will never touch files it didn't create.

## Adding Custom Skills for Antigravity

If you're contributing a new skill and want it available on Antigravity:

1. Create the skill under `skills/<category>/your-skill-name/SKILL.md` as usual: the installer copies it to `.agents/skills/your-skill-name/`, where Antigravity reads workspace skills
2. Add the Codex interface metadata at `.agents/skills/your-skill-name/agents/openai.yaml`: this is a static repo layout consumed by Codex for implicit invocation metadata
3. Run `node scripts/ci/codex-mirror.js --write`: it creates `.agents/skills/your-skill-name/SKILL.md` (or regenerates it) from your catalog `SKILL.md` with the frontmatter reduced to the keys Codex accepts (`name`, `description`, `license`, `metadata`, `allowed-tools`). Never edit that copy by hand: `tests/ci/codex-mirror-parity.test.js` fails when it differs from the catalog
4. Mention in your PR that you added Antigravity support

> **Key distinction**: The installer deploys `skills/` → `.agents/skills/<name>/` and `agents/` (no dot) → `.agents/agents/`. The `.agents/` (dot-prefixed) directory of the egc repository is a separate static layout for Codex `openai.yaml` configs and is not deployed by the installer.

See [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) for the full contribution guide.

## Comparison with Other Targets

| Feature | Home install (`egc`) | Cursor | Codex | Antigravity |
|---------|-------------|--------|-------|-------------|
| Install target | `egc` | `cursor-project` | `codex-home` | `antigravity` |
| Config root | `~/.gemini/` | `.cursor/` | `~/.codex/` | `.agents/` |
| Scope | User-level | Project-level | User-level | Project-level |
| Rules format | Flat (`config/rules/`) | Flat | Flat | Flat |
| Commands | `commands/` | N/A | N/A | `workflows/` |
| Agents | `config/agents/` | N/A | N/A | `agents/` |
| Install state | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` |

## Troubleshooting

### Skills not loading in Antigravity

- Verify the `.agents/` directory exists in your project root (not home directory)
- Check that `egc-install-state.json` was created: if missing, re-run the installer
- Ensure files have `.md` extension and valid frontmatter

### Rules not applying

- Rules must be in `.agents/rules/`, not nested in subdirectories
- Run `node scripts/doctor.js --target antigravity` to verify the install

### Workflows not available

- Antigravity looks for workflows in `.agents/workflows/`, not `commands/`
- If you manually copied egc commands, rename the directory

## Related Resources

- [Selective Install Architecture](./SELECTIVE-INSTALL-ARCHITECTURE.md): how the install system works under the hood
- [Selective Install Design](./SELECTIVE-INSTALL-DESIGN.md): design decisions and target adapter contracts
- [CONTRIBUTING.md](../../.github/CONTRIBUTING.md): how to contribute skills, agents, and commands
