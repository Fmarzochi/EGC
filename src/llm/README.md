# src/llm: Python LLM Bridge

Python bridge invoked by `egc prompt` via `scripts/gemini.js`.

Spawned as a subprocess: `python -m llm.cli.prompt`. Requires a `.venv/` in the project root.

Not part of the MCP runtime. The two MCP servers (`egc-guardian`, `egc-memory`) live in `mcp/servers/`.
