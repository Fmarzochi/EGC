# Skill Router

The **Skill Router** is the dynamic orchestration layer of EGC. It allows you to search, activate, and deactivate skills and agents from the massive EGC library (180+ components) into the active Gemini CLI runtime.

## When to Use
- When you need a specific capability that is not currently loaded in the session.
- When you want to find the best tool for a task within the EGC library.
- When the session context is crowded and you need to deactivate unused skills.

## How it Works
The router interacts with the `registry/runtime-map.json` and uses symlinks to materialise components in `.agents/skills/` and `.agents/agents/`.

### Core Commands
You can execute these commands via `run_shell_command`:

1. **Search**: `node scripts/runtime/router.js search <keyword>`
2. **Activate**: `node scripts/runtime/router.js activate <id>`
3. **Deactivate**: `node scripts/runtime/router.js deactivate <id>`
4. **Sync Registry**: `node scripts/runtime/router.js sync`
5. **List Skills**: `node scripts/runtime/router.js list skills`
6. **List Agents**: `node scripts/runtime/router.js list agents`

## Examples

### Scenario: Implementing a feature with TDD
If you realize you don't have the TDD skill active:
1. **Search**: `node scripts/runtime/router.js search tdd`
2. **Activate**: `node scripts/runtime/router.js activate testing-tdd-workflow`
3. **Result**: The skill becomes immediately available for the next turns.

### Scenario: Cleaning up the session
If many skills are active but you only need a few:
1. **List**: `node scripts/runtime/router.js list skills`
2. **Deactivate**: `node scripts/runtime/router.js deactivate backend-patterns` (and others)

## Safety Rules
- **Non-Destructive**: Never delete physical files in `skills/` or `agents/`.
- **Registry Driven**: Always use the router script; don't create symlinks manually to avoid path mismatches.
- **Runtime Awareness**: Some skills require specific runtimes (Python/Node). Activation handles the link, but you must ensure dependencies are met.
