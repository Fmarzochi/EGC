# EGC: Session Memory Protocol

This project has persistent cross-session memory via the `egc-memory` MCP server.

## At the start of every session

Call `get_state` with no arguments: it uses the current working directory automatically:

```
get_state({})
```

If the AI is running from outside the project directory, pass the path explicitly:

```
get_state({ project_path: "/absolute/path/to/this/project" })
```

Read the returned Markdown. It contains the decisions already made, what failed, coding preferences, and what to pick up next. Do not ask the user to re-explain any of that.

## At the end of every session

> **COMPACTION RULE:** On `/compact`, call `update_state` to persist session state.
> Do not create compaction-summary files anywhere — not in the project, not in any external vault or notebook.
> `update_state` updates the existing project state file and may initialize it if it does not yet exist.

---

Call `update_state` with a summary of this session:

```
update_state({
  project_path: "/absolute/path/to/project",
  context: "One sentence: what this project is and its current phase.",
  decisions: [
    { what: "What was decided", why: "Why" }
  ],
  avoid: [
    { what: "What failed or was rejected", why: "Why to skip it next time" }
  ],
  preferences: [
    "Coding style or workflow preference discovered this session"
  ],
  next: [
    "First thing to pick up in the next session"
  ]
})
```

`update_state` merges with existing state: it does not erase previous memory. Only include fields that changed this session. Leave out fields with nothing new.

Pass `scope: "global"` to write to the user-wide memory shared across all projects; use it only for transversal preferences and lessons, never for project-specific state. `get_state` appends that global memory automatically, with project and branch entries taking precedence.

## Parallel sessions

When more than one session works on this project at the same time, coordinate through the session bus: call `session_announce` at start (registers presence and territory, doubles as heartbeat), check `session_peers` before picking work, and `claim_path` before editing shared files. A refused claim means another live session holds that path: coordinate or work elsewhere, never retry in a loop.

## Where state is stored

`~/.egc/state/<project-slug>/<branch>.md`: one file per project branch (flat `<project-slug>.md` files from older versions are still read). Files are encrypted at rest with AES-256-GCM (key at `~/.egc/encryption.key`); the memory server and session hooks decrypt them transparently.

## MCP servers required

Both servers must be registered in your MCP config (`.mcp.json`):

- `egc-guardian`: `validate_command`, `validate_write`, `reduce_context`, `orchestrate_task`
- `egc-memory`: `get_state`, `update_state`, `store_decision`, `query_history`, `search_history`, `session_announce`, `session_peers`, `claim_path`, `release_path`

Run `sh install.sh` to build the servers. Run `egc doctor` to verify they are registered and running.

## EGC Guardian Protocol — MANDATORY

These calls are automatic and non-negotiable. Never wait for the user to ask.

**Start of every task (non-trivial):**
```
orchestrate_task({ prompt: "<task description>" })
```

**Before every shell/Bash command:**
```
validate_command({ command: "<command>" })
```

**Before every new file Write or Edit on a file not yet read:**
```
validate_write({ filepath: "<path>" })
```

Skipping any of these breaks the EGC contract. There are no exceptions for "simple" tasks.

## EGC Auto-Intuition

Act on user intent, not keywords. When what the user says implies an EGC action, call the right tool immediately -- no explicit command needed.

- Session ending (goodbye, break, sleep, done, closing) → call `update_state`
- Session starting or resuming → call `get_state`
- Save/remember this decision → call `lesson_save` or `store_decision`
- What failed? What did we decide? → call `search_history` or `query_history`
- Review code or a PR → spawn `/review-pr` agents
- Context is heavy or slow → call `reduce_context`

Judge by the full conversation context, never by literal words. A remark to someone nearby is not a command. When intent is ambiguous, keep working.
