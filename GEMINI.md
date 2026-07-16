# EGC: Session Memory Protocol

This project has persistent cross-session memory via the `egc-memory` MCP server.

## At the start of every session

Call `get_state` with no arguments: it uses the current working directory automatically:

```
get_state({})
```

If the AI is running from outside the project directory, pass the path explicitly:

```
get_state({ project_path: "/absolute/path/to/this/project" })
```

Read the returned Markdown. It contains the decisions already made, what failed, coding preferences, and what to pick up next. Do not ask the user to re-explain any of that.

## At the end of every session

Call `update_state` with a summary of this session:

```
update_state({
  project_path: "/absolute/path/to/project",
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

`update_state` merges with existing state: it does not erase previous memory. Only include fields that changed this session. Leave out fields with nothing new.

## Where state is stored

`~/.egc/state/<project-slug>/<branch>.md`: one file per project branch (flat `<project-slug>.md` files from older versions are still read). Files are encrypted at rest with AES-256-GCM (key at `~/.egc/encryption.key`); the memory server and session hooks decrypt them transparently.

## MCP servers required

Both servers must be registered in your MCP config (`.mcp.json`):

- `egc-guardian`: `validate_command`, `validate_write`, `reduce_context`, `orchestrate_task`
- `egc-memory`: `get_state`, `update_state`, `store_decision`, `query_history`, `search_history`

Run `sh install.sh` to build the servers. Run `egc doctor` to verify they are registered and running.

## EGC Guardian Protocol — MANDATORY

These calls are automatic and non-negotiable. Never wait for the user to ask.

**Start of every task (non-trivial):**
```
orchestrate_task({ prompt: "<task description>" })
```

**Before every shell/Bash command:**
```
validate_command({ command: "<command>" })
```

**Before every new file Write or Edit on a file not yet read:**
```
validate_write({ filepath: "<path>" })
```

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
