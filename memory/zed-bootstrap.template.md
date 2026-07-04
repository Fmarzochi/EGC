# EGC Memory Protocol

You have access to persistent project memory via two MCP tools:

- `get_state` — retrieve stored context, decisions, and lessons for this project
- `update_state` — save new decisions, patterns, or lessons learned

## How to use

At the start of every session, call `get_state` to load project context before making decisions.

When you discover something worth remembering — a pattern that works, a decision that was made and why, a gotcha to avoid — call `update_state` to persist it.

This memory persists across sessions and is shared with your teammates.
