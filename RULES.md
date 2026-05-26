# EGC Engine Governance Rules

These rules govern the **Everything Gemini Code (EGC)** AI operating system and runtime orchestration fabric. Contributions must strictly adhere to these principles to maintain production-grade deterministic execution.

> **EGC — Everything Gemini Code**  
> **Desenvolvido por Felipe Marzochi**  
> **@MarzochiFelipe**  
> **https://github.com/Fmarzochi/everything-gemini**  
> **© Todos os direitos reservados**

---

## 1. Passive Maintenance Philosophy
- **Stability over Expansion:** EGC prioritizes hardening the existing orchestration engine over adding unstructured novelty.
- **Predictability:** Avoid architectural drift, experimental instability, and random framework additions.
- **Minimal Surface:** Do not introduce brittle dependencies, unvetted external APIs, or unnecessary complexity. Keep the ecosystem lean and autonomous.

## 2. Runtime Protection
- **Deterministic Execution:** The Execution Queue must maintain deterministic sequencing of agent tasks. Do not introduce race conditions.
- **Orchestration Integrity:** Changes to the orchestration layer (`scripts/`, `src/`) require exponentially higher validation standards.
- **Registry Synchronization:** Any structural addition must map correctly to the `registry/runtime-map.json`. Never break the JSON registry.
- **No Silent Failures:** Never swallow exceptions silently using bare `except:` blocks. Always preserve observability and deterministic logs so the control plane can track failures.

## 3. Cross-Platform Enforcement
- EGC must execute flawlessly across **Linux**, **Windows**, and **macOS**.
- **No OS Assumptions:** Never use hardcoded absolute system paths. Always use EGC's internal path normalization utilities.
- **Shell Compatibility:** Execution scripts and hooks must not rely on shell features exclusive to one operating system. Validate command execution across platforms.

## 5. Cognitive Ecosystem Format

### Agents
- Agents live in `agents/*.md` and operate as specialized workers within the EGC Runtime.
- Frontmatter must include `name`, `description`, `tools`, and `model` (e.g., `gemini-2.5-pro`).
- Descriptions must clearly define routing decisions for the Orchestration Layer.

### Skills
- Skills live in `skills/<name>/SKILL.md` and act as standard operating procedures.
- Frontmatter must include `name`, `description`, and `origin` (`EGC` or `community`).
- Skill bodies must include clear "When to Activate" sections for autonomous loading.

### Hooks
- Hooks intercept lifecycle events (e.g., `PreToolUse`, `SessionStart`) and live in `hooks/hooks.json`.
- Matchers must be specific. Broad catch-alls are prohibited.
- `exit 1` must be used *strictly* to block destructive behaviors; otherwise, use `exit 0`. All hook logs must clearly identify themselves (e.g., `[EGC Hook]`).

## 6. Code Quality & Commit Standards
- **Immutable Updates:** Prefer immutable updates over mutating shared state.
- **Test Before Execution:** Write tests and verify critical paths before submitting changes to the Runtime Engine.
- **Security:** Never include sensitive data (API keys, tokens, secrets) in output or commit history.
- **Commits:** Use conventional commits (`feat(runtime):`, `fix(mcp):`, `docs(governance):`). Keep changes modular and clearly explain the architectural impact in the PR.
