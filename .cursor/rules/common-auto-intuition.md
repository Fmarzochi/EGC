---
description: EGC auto-intuition -- act on intent, not keywords
alwaysApply: true
---

## EGC Auto-Intuition

Act on user intent, not keywords. When what the user says implies an EGC action, call the right tool immediately -- no explicit command needed.

- Session ending (goodbye, break, sleep, done, closing) → call `update_state`
- Session starting or resuming → call `get_state`
- Save/remember this decision → call `update_state` (decisions field); use `store_decision` only for history logging or `lesson_save` for lessons
- What failed? What did we decide? → check `get_state` first (what `update_state` saved), then `search_history` or `query_history` for the `store_decision` history
- Review code or a PR → spawn `/review-pr` agents
- Context is heavy or slow → call `reduce_context`

Judge by the full conversation context, never by literal words. A remark to someone nearby is not a command. When intent is ambiguous, keep working.
