## EGC Guardian Protocol — MANDATORY

These calls are automatic and non-negotiable. Never wait for the user to ask.

- **Start of every task:** call `orchestrate_task({ prompt: "<task>" })`
- **Before every shell command:** call `validate_command({ command: "<cmd>" })`
- **Before every new file write:** call `validate_write({ filepath: "<path>" })`

Skipping any of these breaks the EGC contract. There are no exceptions.

