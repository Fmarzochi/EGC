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

**Context:** EGC branch fix/guardian-audit-critical-security: correção completa dos 47 achados da auditoria EGC-128 (8 críticos, 10 altos, todos os médios exceto 2 refactors de manutenibilidade adiados, quase todos os baixos). 28 commits, 2825 testes JS + 114 Python verdes. Auditoria final via Antigravity (agy) em andamento antes de decidir push/PR.

**Active decisions:**
- Todos os itens baixos da auditoria resolvidos: DANGEROUS list (dd/shred/truncate), dead code render-template removido, pip-audit no CI, JA/KO/RU traducoes ja estavam corretas, resolver-bleed dedup (tag_as param em ModelResolver.model_infos), cwd threading no guardian (isProtectedPath/validateCommand agora resolvem paths relativos contra o cwd real do hook, nao process.cwd()), tags do lesson_save aceitam array alem de string (sem migracao destrutiva, 81 linhas existentes preservadas).
- 2 refactors medios (funcao de 166 linhas em install-manifests.js resolveInstallPlan, funcao grande em install-lifecycle.js) deliberadamente NAO feitos nesta sessao.

**Next session:**
- Aguardar resultado da auditoria final via agy --print (rodando em background) sobre o diff completo main...fix/guardian-audit-critical-security.
- Decidir com Felipe: push + PR da branch fix/guardian-audit-critical-security.
- Se Felipe autorizar, fazer os 2 refactors medios pendentes em sessao dedicada.
<!-- egc:end -->
