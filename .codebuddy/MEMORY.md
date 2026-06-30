# Session Memory

At the start of every session, call `get_state` with no arguments (it uses PWD automatically):

```
get_state({})
```

Read the returned Markdown in full. It contains decisions already made, what failed, coding preferences, and what to pick up next. Do not ask the user to re-explain any of that.

At the end of every session, call `update_state` with a summary:

```
update_state({
  project_path: "<absolute path to project>",
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

Only include fields that changed this session. `update_state` merges with existing state: it does not erase previous memory.

## Auto-Intuition

Act on user intent, not keywords. When what the user says implies an EGC action, call the right tool immediately -- no explicit command needed.

- Session ending (goodbye, break, sleep, done, closing) → call `update_state`
- Session starting or resuming → call `get_state`
- Save/remember this decision → call `lesson_save` or `store_decision`
- What failed? What did we decide? → call `search_history` or `query_history`
- Review code or a PR → spawn `/review-pr` agents
- Context is heavy or slow → call `reduce_context`

Judge by the full conversation context, never by literal words. A remark to someone nearby is not a command. When intent is ambiguous, keep working.
