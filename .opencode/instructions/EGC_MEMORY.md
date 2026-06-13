# EGC Session Memory

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
