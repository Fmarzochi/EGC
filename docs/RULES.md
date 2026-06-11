# EGC Governance Rules

These rules govern contributions to **Extended Global Context (EGC)** — a local-first MCP runtime with persistent memory, shared context, and plug-and-play integration for AI coding tools.

> **EGC - Extended Global Context**  
> **Desenvolvido por Felipe Marzochi**  
> **@MarzochiFelipe**  
> **https://github.com/Fmarzochi/EGC**  
> **© Todos os direitos reservados**

---

## 1. Stability First

- **Stability over Expansion:** Harden what exists before adding new surface area.
- **Predictability:** Avoid architectural drift and unvetted framework additions.
- **Minimal Surface:** Do not introduce brittle dependencies or unnecessary complexity. Keep the ecosystem lean.

## 2. Runtime Integrity

- **MCP servers are the core:** Changes to `mcp/servers/egc-guardian/` or `mcp/servers/egc-memory/` require higher validation standards — both servers must build and pass tests before merging.
- **State schema:** Do not break the egc-memory state file format (`~/.egc/state/<slug>.md`). Existing state files must remain readable after any change.
- **No Silent Failures:** Never swallow exceptions silently. Always preserve error observability so failures are traceable.

## 3. Cross-Platform Enforcement

- EGC must work across **Linux**, **Windows**, and **macOS**.
- **No OS Assumptions:** Never hardcode absolute system paths. Use dynamic path resolution.
- **Shell Compatibility:** Scripts and hooks must not rely on shell features exclusive to one OS. The CI matrix covers all three platforms — all jobs must pass.

## 4. Cognitive Ecosystem Format

### Agents

- Agents live in `agents/*.md` and define AI persona and behavior.
- Frontmatter must include `name`, `description`, `tools`, and `model`.
- Descriptions must be specific enough to inform tool routing.

### Skills

- Skills live in `skills/<name>/SKILL.md` and act as workflow runbooks.
- Frontmatter must include `name`, `description`, and `origin` (`EGC` or `community`).
- Skill bodies must include a clear "When to Activate" section.

### Hooks

- Hooks intercept lifecycle events (e.g., `PreToolUse`, `SessionStart`) and live in `hooks/hooks.json`.
- Matchers must be specific. Broad catch-alls are prohibited.
- Use `exit 1` strictly to block destructive behaviors; use `exit 0` otherwise.
- All hook logs must identify themselves (e.g., `[EGC Hook]`).

## 5. Code Quality & Commit Standards

- **Immutable Updates:** Prefer immutable updates over mutating shared state.
- **Test Before Merging:** Run `npm test` and verify all 2156 tests pass before submitting changes.
- **Security:** Never include API keys, tokens, or secrets in output or commit history.
- **Commits:** Use conventional commits (`feat(mcp):`, `fix(hooks):`, `docs(rules):`). Keep changes modular.
