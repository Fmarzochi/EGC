# Copilot instructions for EGC

EGC is a local-first MCP runtime that gives every AI coding agent a shared
persistent memory (egc-memory), a safety layer that validates commands and
writes before they run (egc-guardian), and shell-output compression (Token
Crusher). It installs into 23 AI coding tools from one npm package
(@egchq/egc). Memory lives encrypted in ~/.egc on the user's machine and must
never reach the repository.

## Repository conventions

- All repository content is written in English, except the files under
  translations/.
- Flag any populated memory content in AGENTS.md, GEMINI.md,
  .cursor/rules/egc-context.mdc or .trae/rules/egc-context.md: those
  propagation files must ship with an empty structure only, and CI enforces
  it.

## README and translations

- README.md must keep the exact catalog sentence matching "access to N
  agents, N skills, and N commands" and the "Works natively with ..."
  provider sentence: CI validates both.
- The 7 translations (ar, es, hi, ja, ko, pt, ru) must mirror the heading
  levels of README.md in the same order; adding or removing a section in one
  language only is a defect.
- The Support EGC section and everything below it (sponsors, backers,
  OpenSSF footer) changes only when the maintainer edits it deliberately.

## Code review priorities

- Commits need a DCO Signed-off-by line and follow conventional commits.
- New code never uses Math.random for anything security-adjacent: use
  crypto.randomInt (SonarCloud S2245 gates the merge).
- Binaries invoked from scripts are resolved from fixed paths with a PATH
  fallback, not bare names (S4036 pattern used across scripts/).
- Any change touching files shared across concurrent EGC processes
  (~/.egc state, encryption key, install-state, lockfiles) requires a
  concurrent-access regression test; check for read-merge-write races and
  lock steal in upserts.
- Shell-facing features must be fail-open: a broken hook or missing binary
  must never block the user's command.
- Version bumps happen only in dedicated release PRs that update the whole
  release surface (11 files); flag any stray version change elsewhere.
