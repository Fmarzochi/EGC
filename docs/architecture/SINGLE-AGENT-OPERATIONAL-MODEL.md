# Single-Agent Operational Model

This document establishes the official and permanent operational governance for the EGC - Extended Global Context project. It strictly enforces a single-agent execution paradigm, explicitly prohibiting automatic orchestration, recursive delegation, and any modification of the host system's global state.

## Core Directives

### 1. Absolute Immutability of Global State
Agents and processes operating within this repository **MUST NEVER** modify:
- `~/.gemini` (Global Gemini configurations)
- `~/.npm-global` (Global NPM modules)
- Global system configurations or environment variables.
- The Google internal bundle or CLI internal policies.
- Global runtimes or global plugins.

### 2. Strict Project Locality
All behaviors, scripts, and executions must be:
- **Repo-scoped:** Confined entirely within the `EGC` repository boundaries.
- **Project-local:** All file reads, writes, and execution paths must be relative to the project root.
- **Self-contained:** The project must not rely on external, non-standard system dependencies that aren't explicitly declared in the package manager.

### 3. Localization of Resources
All operational resources must reside exclusively within the project directory structure:
- `./agents`
- `./skills`
- `./scripts`
- `./docs`
- `./research`

### 4. Prohibited Behaviors
The following runtime behaviors are strictly forbidden to prevent compounding quota consumption, infinite loops, and operational unpredictability:
- `invoke_agent` (Delegation to sub-agents via the main loop).
- Automatic orchestration loops.
- Recursive planners.
- Auto-investigation or runtime archaeology.
- Bundle forensics.
- Self-modifying governance (agents altering these core rules).

### 5. Official Operational Mode
The standard operating mode is **Single-Agent Execution Mode**. Tasks must be executed directly by the active agent within a single, linear thread of execution.

### 6. Future Multi-Agent Capabilities
Any future implementation of multi-agent workflows must adhere to the following constraints:
- Require explicit authorization (opt-in by the user).
- Be implemented entirely local to the project (e.g., via local scripts orchestrating separate CLI processes, not internal runtime recursion).
- Never alter the global environment.
- Never create dependencies on the host machine's specific layout or HOME directory.

### 7. Universal Portability
The repository is designed to be fully portable. It must function correctly:
- On any operating system (Linux, macOS, Windows).
- In any directory path.
- Without any dependency on the user's `HOME` directory path.
