# Working Context

Last updated: 2026-04-02

## Purpose

Public ECC plugin repo for agents, skills, commands, hooks, rules, install surfaces, and ECC 2.0 platform buildout.

## Current Truth

- Default branch: `main`
- Immediate blocker addressed: CI lockfile drift and hook validation breakage fixed in `a273c62`
- Local full suite status after fix: `1723/1723` passing
- Main active operational work:
  - keep default branch green
  - continue issue-driven fixes from `main` now that the public PR backlog is at zero
  - continue ECC 2.0 control-plane and operator-surface buildout

## Current Constraints

- No merge by title or commit summary alone.
- No arbitrary external runtime installs in shipped ECC surfaces.
- Overlapping skills, hooks, or agents should be consolidated when overlap is material and runtime separation is not required.

## Active Queues

- PR backlog: currently cleared on the public queue; new work should land through direct mainline fixes or fresh narrowly scoped PRs
- Product:
  - selective install cleanup
  - control plane primitives
  - operator surface
  - self-improving skills
- Skill quality:
  - rewrite content-facing skills to use source-backed voice modeling
  - remove generic LLM rhetoric, canned CTA patterns, and forced platform stereotypes
  - continue one-by-one audit of overlapping or low-signal skill content
  - move repo guidance and contribution flow to skills-first, leaving commands only as explicit compatibility shims
  - add operator skills that wrap connected surfaces instead of exposing only raw APIs or disconnected primitives
  - land the canonical voice system, network-optimization lane, and reusable Manim explainer lane
- Security:
  - keep dependency posture clean
  - preserve self-contained hook and MCP behavior

## Open PR Classification

- Closed on 2026-04-01 under backlog hygiene / merge policy:
  - `#1069` `feat: add everything-claude-code ECC bundle`
  - `#1068` `feat: add everything-claude-code-conventions ECC bundle`
  - `#1080` `feat: add everything-claude-code ECC bundle`
  - `#1079` `feat: add everything-claude-code-conventions ECC bundle`
  - `#1064` `chore(deps-dev): bump @eslint/js from 9.39.2 to 10.0.1`
  - `#1063` `chore(deps-dev): bump eslint from 9.39.2 to 10.1.0`
- Closed on 2026-04-01 because the content is sourced from external ecosystems and should only land via manual ECC-native re-port:
  - `#852` openclaw-user-profiler
  - `#851` openclaw-soul-forge
  - `#640` harper skills
- Native-support candidates to fully diff-audit next:
  - `#1055` Dart / Flutter support
  - `#1043` C# reviewer and .NET skills
- Direct-port candidates landed after audit:
  - `#1078` hook-id dedupe for managed Claude hook reinstalls
  - `#844` ui-demo skill
  - `#1110` install-time Claude hook root resolution
  - `#1106` portable Codex Context7 key extraction
  - `#1107` Codex baseline merge and sample agent-role sync
  - `#1119` stale CI/lint cleanup that still contained safe low-risk fixes
- Port or rebuild inside ECC after full audit:
  - `#894` Jira integration
  - `#814` + `#808` rebuild as a single consolidated notifications lane for Opencode and cross-harness surfaces

## Interfaces

- Public truth: GitHub issues and PRs
- Internal execution truth: linked Linear work items under the ECC program
- Current linked Linear items:
  - `ECC-206` ecosystem CI baseline
  - `ECC-207` PR backlog audit and merge-policy enforcement
  - `ECC-208` context hygiene
  - `ECC-210` skills-first workflow migration and command compatibility retirement

## Update Rule

Keep this file detailed for only the current sprint, blockers, and next actions. Summarize completed work into archive or repo docs once it is no longer actively shaping execution.

## Latest Execution Notes

- 2026-04-02: `ECC-Tools/main` shipped `9566637` (`fix: prefer commit lookup over git ref resolution`). The PR-analysis fire is now fixed in the app repo by preferring explicit commit resolution before `git.getRef`, with regression coverage for pull refs and plain branch refs. Mirrored public tracking issue `#1184` in this repo was closed as resolved upstream.
- 2026-04-02: Direct-ported the clean native-support core of `#1043` into `main`: `agents/csharp-reviewer.md`, `skills/dotnet-patterns/SKILL.md`, and `skills/csharp-testing/SKILL.md`. This fills the gap between existing C# rule/docs mentions and actual shipped C# review/testing guidance.
- 2026-04-02: Direct-ported the clean native-support core of `#1055` into `main`: `agents/dart-build-resolver.md`, `commands/flutter-build.md`, `commands/flutter-review.md`, `commands/flutter-test.md`, `rules/dart/*`, and `skills/dart-flutter-patterns/SKILL.md`. The skill paths were wired into the current `framework-language` module instead of replaying the older PR's separate `flutter-dart` module layout.
- 2026-04-02: Closed `#1081` after diff audit. The PR only added vendor-marketing docs for an external X/Twitter backend (`Xquik` / `x-twitter-scraper`) to the canonical `x-api` skill instead of contributing an ECC-native capability.
- 2026-04-02: Direct-ported the useful Jira lane from `#894`, but sanitized it to match current supply-chain policy. `commands/jira.md`, `skills/jira-integration/SKILL.md`, and the pinned `jira` MCP template in `mcp-configs/mcp-servers.json` are in-tree, while the skill no longer tells users to install `uv` via `curl | bash`. `jira-integration` is classified under `operator-workflows` for selective installs.
- 2026-04-02: Closed `#1125` after full diff audit. The bundle/skill-router lane hardcoded many non-existent or non-canonical surfaces and created a second routing abstraction instead of a small ECC-native index layer.
- 2026-04-02: Closed `#1124` after full diff audit. The added agent roster was thoughtfully written, but it duplicated the existing ECC agent surface with a second competing catalog (`dispatch`, `explore`, `verifier`, `executor`, etc.) instead of strengthening canonical agents already in-tree.
- 2026-04-02: Closed the full Argus cluster `#1098`, `#1099`, `#1100`, `#1101`, and `#1102` after full diff audit. The common failure mode was the same across all five PRs: external multi-CLI dispatch was treated as a first-class runtime dependency of shipped ECC surfaces. Any useful protocol ideas should be re-ported later into ECC-native orchestration, review, or reflection lanes without external CLI fan-out assumptions.
- 2026-04-02: The previously open native-support / integration queue (`#1081`, `#1055`, `#1043`, `#894`) has now been fully resolved by direct-port or closure policy. The active public PR queue is currently zero; next focus stays on issue-driven mainline fixes and CI health, not backlog PR intake.
- 2026-04-01: `main` CI was restored locally with `1723/1723` tests passing after lockfile and hook validation fixes.
- 2026-04-01: Auto-generated ECC bundle PRs `#1068` and `#1069` were closed instead of merged; useful ideas must be ported manually after explicit diff audit.
- 2026-04-01: Major-version ESLint bump PRs `#1063` and `#1064` were closed; revisit only inside a planned ESLint 10 migration lane.
- 2026-04-01: Notification PRs `#808` and `#814` were identified as overlapping and should be rebuilt as one unified feature instead of landing as parallel branches.
- 2026-04-01: External-source skill PRs `#640`, `#851`, and `#852` were closed under the new ingestion policy; copy ideas from audited source later rather than merging branded/source-import PRs directly.
- 2026-04-01: The remaining low GitHub advisory on `ecc2/Cargo.lock` was addressed by moving `ratatui` to `0.30` with `crossterm_0_28`, which updated transitive `lru` from `0.12.5` to `0.16.3`. `cargo build --manifest-path ecc2/Cargo.toml` still passes.
- 2026-04-01: Safe core of `#834` was ported directly into `main` instead of merging the PR wholesale. This included stricter install-plan validation, antigravity target filtering that skips unsupported module trees, tracked catalog sync for English plus zh-CN docs, and a dedicated `catalog:sync` write mode.
- 2026-04-01: Repo catalog truth is now synced at `36` agents, `68` commands, and `142` skills across the tracked English and zh-CN docs.
- 2026-04-01: Legacy emoji and non-essential symbol usage in docs, scripts, and tests was normalized to keep the unicode-safety lane green without weakening the check itself.
- 2026-04-01: The remaining self-contained piece of `#834`, `docs/zh-CN/skills/browser-qa/SKILL.md`, was ported directly into the repo. After commit, `#834` should be closed as superseded-by-direct-port.
- 2026-04-01: Content skill cleanup started with `content-engine`, `crosspost`, `article-writing`, and `investor-outreach`. The new direction is source-first voice capture, explicit anti-trope bans, and no forced platform persona shifts.
- 2026-04-01: `node scripts/ci/check-unicode-safety.js --write` sanitized the remaining emoji-bearing Markdown files, including several `remotion-video-creation` rule docs and an old local plan note.
- 2026-04-01: Core English repo surfaces were shifted to a skills-first posture. README, AGENTS, plugin metadata, and contributor instructions now treat `skills/` as canonical and `commands/` as legacy slash-entry compatibility during migration.
- 2026-04-01: Follow-up bundle cleanup closed `#1080` and `#1079`, which were generated `.claude/` bundle PRs duplicating command-first scaffolding instead of shipping canonical ECC source changes.
- 2026-04-01: Ported the useful core of `#1078` directly into `main`, but tightened the implementation so legacy no-id hook installs deduplicate cleanly on the first reinstall instead of the second. Added stable hook ids to `hooks/hooks.json`, semantic fallback aliases in `mergeHookEntries()`, and a regression test covering upgrade from pre-id settings.
- 2026-04-01: Collapsed the obvious command/skill duplicates into thin legacy shims so `skills/` now hold the maintained bodies for NanoClaw, context-budget, DevFleet, docs lookup, E2E, evals, orchestration, prompt optimization, rules distillation, TDD, and verification.
- 2026-04-01: Ported the self-contained core of `#844` directly into `main` as `skills/ui-demo/SKILL.md` and registered it under the `media-generation` install module instead of merging the PR wholesale.
- 2026-04-01: Added the first connected-workflow operator lane as ECC-native skills instead of leaving the surface as raw plugins or APIs: `workspace-surface-audit`, `customer-billing-ops`, `project-flow-ops`, and `google-workspace-ops`. These are tracked under the new `operator-workflows` install module.
- 2026-04-01: Direct-ported the real fix from the unresolved hook-path PR lane into the active installer. Claude installs now replace `${CLAUDE_PLUGIN_ROOT}` with the concrete install root in both `settings.json` and the copied `hooks/hooks.json`, which keeps PreToolUse/PostToolUse hooks working outside plugin-managed env injection.
- 2026-04-01: Replaced the GNU-only `grep -P` parser in `scripts/sync-ecc-to-codex.sh` with a portable Node parser for Context7 key extraction. Added source-level regression coverage so BSD/macOS syncs do not drift back to non-portable parsing.
- 2026-04-01: Targeted regression suite after the direct ports is green: `tests/scripts/install-apply.test.js`, `tests/scripts/sync-ecc-to-codex.test.js`, and `tests/scripts/codex-hooks.test.js`.
- 2026-04-01: Ported the useful core of `#1107` directly into `main` as an add-only Codex baseline merge. `scripts/sync-ecc-to-codex.sh` now fills missing non-MCP defaults from `.codex/config.toml`, syncs sample agent role files into `~/.codex/agents`, and preserves user config instead of replacing it. Added regression coverage for sparse configs and implicit parent tables.
- 2026-04-01: Ported the safe low-risk cleanup from `#1119` directly into `main` instead of keeping an obsolete CI PR open. This included `.mjs` eslint handling, stricter null checks, Windows home-dir coverage in bash-log tests, and longer Trae shell-test timeouts.
- 2026-04-01: Added `brand-voice` as the canonical source-derived writing-style system and wired the content lane to treat it as the shared voice source of truth instead of duplicating partial style heuristics across skills.
- 2026-04-01: Added `connections-optimizer` as the review-first social-graph reorganization workflow for X and LinkedIn, with explicit pruning modes, browser fallback expectations, and Apple Mail drafting guidance.
- 2026-04-01: Added `manim-video` as the reusable technical explainer lane and seeded it with a starter network-graph scene so launch and systems animations do not depend on one-off scratch scripts.
- 2026-04-02: Re-extracted `social-graph-ranker` as a standalone primitive because the weighted bridge-decay model is reusable outside the full lead workflow. `lead-intelligence` now points to it for canonical graph ranking instead of carrying the full algorithm explanation inline, while `connections-optimizer` stays the broader operator layer for pruning, adds, and outbound review packs.
- 2026-04-02: Applied the same consolidation rule to the writing lane. `brand-voice` remains the canonical voice system, while `content-engine`, `crosspost`, `article-writing`, and `investor-outreach` now keep only workflow-specific guidance instead of duplicating a second Affaan/ECC voice model or repeating the full ban list in multiple places.
- 2026-04-02: Closed fresh auto-generated bundle PRs `#1182` and `#1183` under the existing policy. Useful ideas from generator output must be ported manually into canonical repo surfaces instead of merging `.claude`/bundle PRs wholesale.
- 2026-04-02: Ported the safe one-file macOS observer fix from `#1164` directly into `main` as a POSIX `mkdir` fallback for `continuous-learning-v2` lazy-start locking, then closed the PR as superseded by direct port.
- 2026-04-02: Ported the safe core of `#1153` directly into `main`: markdownlint cleanup for orchestration/docs surfaces plus the Windows `USERPROFILE` and path-normalization fixes in `install-apply` / `repair` tests. Local validation after installing repo deps: `node tests/scripts/install-apply.test.js`, `node tests/scripts/repair.test.js`, and targeted `yarn markdownlint` all passed.
- 2026-04-02: Direct-ported the safe web/frontend rules lane from `#1122` into `rules/web/`, but adapted `rules/web/hooks.md` to prefer project-local tooling and avoid remote one-off package execution examples.
- 2026-04-02: Adapted the design-quality reminder from `#1127` into the current ECC hook architecture with a local `scripts/hooks/design-quality-check.js`, Claude `hooks/hooks.json` wiring, Cursor `after-file-edit.js` wiring, and dedicated hook coverage in `tests/hooks/design-quality-check.test.js`.
- 2026-04-02: Fixed `#1141` on `main` in `16e9b17`. The observer lifecycle is now session-aware instead of purely detached: `SessionStart` writes a project-scoped lease, `SessionEnd` removes that lease and stops the observer when the final lease disappears, `observe.sh` records project activity, and `observer-loop.sh` now exits on idle when no leases remain. Targeted validation passed with `bash -n`, `node tests/hooks/observer-memory.test.js`, `node tests/integration/hooks.test.js`, `node scripts/ci/validate-hooks.js hooks/hooks.json`, and `node scripts/ci/check-unicode-safety.js`.
- 2026-04-02: Fixed the remaining Windows-only hook regression behind `#1070` by making `scripts/lib/utils.js#getHomeDir()` honor explicit `HOME` / `USERPROFILE` overrides before falling back to `os.homedir()`. This restores test-isolated observer state paths for hook integration runs on Windows. Added regression coverage in `tests/lib/utils.test.js`. Targeted validation passed with `node tests/lib/utils.test.js`, `node tests/integration/hooks.test.js`, `node tests/hooks/observer-memory.test.js`, and `node scripts/ci/check-unicode-safety.js`.
- 2026-04-02: Direct-ported NestJS support for `#1022` into `main` as `skills/nestjs-patterns/SKILL.md` and wired it into the `framework-language` install module. Synced the repo catalog afterward (`38` agents, `72` commands, `156` skills) and updated the docs so NestJS is no longer listed as an unfilled framework gap.
