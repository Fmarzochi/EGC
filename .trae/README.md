# EGC - Extended Global Context for Trae

Bring Extended Global Context (EGC) workflows to Trae IDE. This repository provides custom commands, agents, skills, and rules that can be installed into any Trae project with a single command.

## Quick Start

### Local Installation (Current Project Only)

```bash
cd /path/to/your/project
egc install --target trae --profile full
```

This creates `.trae/` in your project directory.

### Global Installation (All Projects)

```bash
cd ~
egc install --target trae --profile full
```

This creates `~/.trae/`, which applies to all Trae projects. `egc install --prompt-library` does the same for every detected tool at once.

## Environment Support

- **Default**: Uses the `.trae` directory
- **CN Environment**: Uses the `.trae-cn` directory (set via `TRAE_ENV=cn`)

```bash
TRAE_ENV=cn egc install --target trae --profile full
```

**Note**: `TRAE_ENV` is read when the installer runs; use the same value for `egc doctor`, `egc repair` and `egc uninstall`.

## Uninstall

The installer records everything it writes in an install-state (`egc-install-state.json` under the Trae directory), so removal only touches files EGC installed:

```bash
# From the project (or from ~ for a global installation)
egc uninstall --target trae

# CN environment
TRAE_ENV=cn egc uninstall --target trae
```

`egc doctor` reports drift in the installed files and `egc repair` restores them.
## What's Included

### Commands

Commands are on-demand workflows invocable via the `/` menu in Trae chat. All commands are reused directly from the project root's `commands/` folder.

### Agents

Agents are specialized AI assistants with specific tool configurations. All agents are reused directly from the project root's `agents/` folder.

### Skills

Skills are on-demand workflows invocable via the `/` menu in chat. All skills are reused directly from the project's `skills/` folder.

### Rules

Rules provide always-on rules and context that shape how the agent works with your code. All rules are reused directly from the project root's `rules/` folder.

## Usage

1. Type `/` in chat to open the commands menu
2. Select a command or skill
3. The agent will guide you through the workflow with specific instructions and checklists

## Project Structure

```
.trae/ (or .trae-cn/)
├── commands/           # Command files (reused from project root)
├── agents/             # Agent files (reused from project root)
├── skills/             # Skill files (reused from skills/)
├── rules/              # Rule files (reused from project root)
├── egc-install-state.json  # Install state tracking
└── README.md           # This file
```

## Customization

The installed files belong to EGC: `egc doctor` reports edits to them as drift and `egc repair` restores them. Keep your own commands, agents and rules in files of your own next to them; the installer never touches files it did not write.

## Recommended Workflow

1. **Start with planning**: Use `/plan` command to break down complex features
2. **Write tests first**: Invoke `/tdd` command before implementing
3. **Review your code**: Use `/code-review` after writing code
4. **Check security**: Use `/code-review` again for auth, API endpoints, or sensitive data handling
5. **Fix build errors**: Use `/build-fix` if there are build errors

## Next Steps

- Open your project in Trae
- Type `/` to see available commands
- Enjoy the EGC workflows!
