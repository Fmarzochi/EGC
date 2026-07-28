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

## EGC Auto-Intuition

Act on user intent, not keywords. When what the user says implies an EGC action, call the right tool immediately -- no explicit command needed.

- Session ending (goodbye, break, sleep, done, closing) → call `update_state`
- Session starting or resuming → call `get_state`
- Save/remember this decision → call `lesson_save` or `store_decision`
- What failed? What did we decide? → call `search_history` or `query_history`
- Review code or a PR → spawn `/review-pr` agents
- Context is heavy or slow → call `reduce_context`
- How much did I save? How many tokens did this session save or cost? → run `egc gain` (short form: `egc saved`)
- What savings am I missing? What is wasting my tokens? → run `egc discover`
- Show me the savings history → run `egc gain --history`
- I need the full/raw output of that command → rerun it through `egc run --raw`
- Did another session/tab leave me anything? What are the others doing? → call `session_events` (and `session_peers`)
- Tell the other session/tab something, hand work off → call `session_send`
- Join session / announce presence → call `session_announce`
- Lock / claim a file path to avoid conflicts with other sessions → call `claim_path`
- Unlock / release a claimed file path → call `release_path`
- Read shared working memory → call `working_memory_get`
- Save a key/value to shared working memory → call `working_memory_set`
- List shared working memory keys → call `working_memory_list`

Judge by the full conversation context, never by literal words. A remark to someone nearby is not a command. When intent is ambiguous, keep working.

## EGC Guardian Protocol

These calls are automatic and non-negotiable. Never wait for the user to ask.

**Start of every non-trivial task:** call `orchestrate_task({ prompt: "<task>" })`
**Before every shell/Bash command:** call `validate_command({ command: "<cmd>" })`
**Before every new file Write or Edit on a file not yet read:** call `validate_write({ filepath: "<path>" })`
**At the end of every significant work block:** call `auto_learn({ project_path: "<cwd>" })`

Skipping any of these breaks the EGC contract. There are no exceptions for "simple" tasks.
