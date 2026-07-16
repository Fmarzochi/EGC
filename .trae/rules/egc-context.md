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

**Context:** EGC main: PR #769 mergeado (squash e25baa74) fechando a auditoria de seguranca EGC-128 por completo (47/47 achados: 8 criticos, 10 altos, todos os medios exceto 2 refactors de manutenibilidade adiados de proposito, todos os baixos). 2825 testes JS + 114 Python verdes em main.

**Active decisions:**
- EGC-128 encerrada. Branch fix/guardian-audit-critical-security deletada (local e remota) apos squash-merge.
- 2 refactors medios de manutenibilidade (resolveInstallPlan em install-manifests.js, funcao grande em install-lifecycle.js) permanecem pendentes, recomendados para sessao dedicada.

**Next session:**
- Se Felipe autorizar, abrir sessao dedicada para os 2 refactors medios de complexidade.
- Nenhuma pendencia critica ou de seguranca restante do EGC-128.
<!-- egc:end -->
