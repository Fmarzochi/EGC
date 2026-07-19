## EGC Guardian Protocol — MANDATORY

These calls are automatic and non-negotiable. Never wait for the user to ask.

- **Start of every non-trivial task:** call `orchestrate_task({ prompt: "<task>" })`
- **Before every shell/Bash command:** call `validate_command({ command: "<cmd>" })`
- **Before every new file Write or Edit on a file not yet read:** call `validate_write({ filepath: "<path>" })`

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

<!-- egc:start -->
## EGC Project Memory

## EGC Natural Language Interface

Detect user intent in any language and call the matching EGC tool — no keywords required:

**Session**
- User resumes work (any language) → `get_state`
- User ends session (any language) → `update_state`

**Diagnosis — when AI seems confused or hallucinating**
- User questions whether things are working → `get_project_state`
- User asks what mistakes keep repeating → `detect_patterns`
- User asks what was learned in past sessions → `lesson_recall`

**Memory — user forces a save**
- User asks to record a decision → `store_decision`
- User asks AI not to repeat a mistake → `lesson_save`
- User confirms a past lesson happened again → `lesson_reinforce`
- User wants to store something temporarily → `working_memory_set`
- User asks what is in temporary memory → `working_memory_get` / `working_memory_list`

**Search — when AI forgot something**
- User asks about past decisions on a topic → `search_history`
- User asks for recent decisions chronologically → `query_history`

**Context — when heavy**
- User says context is full or heavy → `reduce_context`
- User asks to compress session observations → `compress_observations`

**Safety — when user is suspicious**
- User asks if a shell command is safe → `validate_command`
- User asks if a file path is safe to write → `validate_write`
- User asks to organize a complex task → `orchestrate_task`
- User asks AI to learn from session errors → `auto_learn`
<!-- egc:end -->
