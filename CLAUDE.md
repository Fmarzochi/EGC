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

## Where state is stored

`~/.egc/state/<project-slug>.md`: one file per project, plain Markdown, human-readable.

## MCP servers required

Both servers must be registered in your MCP config (`.mcp.json`):

- `egc-guardian`: `validate_command`, `validate_write`, `reduce_context`, `orchestrate_task`
- `egc-memory`: `get_state`, `update_state`, `store_decision`, `query_history`, `search_history`

Run `sh install.sh` to build the servers. Run `egc doctor` to verify they are registered and running.
