# Changelog

All notable changes to EGC are documented here.

## [Unreleased]

## [1.1.21] - 2026-09-05

### Added

- **EGC Scrubber**: an automatic, deterministic hygiene pass that strips AI provenance marks from content you own. The guaranteed layer removes invisible Unicode carriers and long dashes and strips AI co-authorship from commit messages; an opt-in metadata pass cleans structured text (Markdown/HTML/SVG), PNG/JPEG images, and PDF Document Info dictionaries, fail-safe and honest about partial coverage; and a best-effort rewrite workflow ships as the `content-scrubber` skill and CLI. The Write/Edit hook is registered in the shared hooks runtime so content is cleaned before it reaches disk. Pure Node, additive with no install-engine changes, and fail-open (#1301, #1302, #1304, #1305, #1306, #1307).
- **Scrubber Layer B rewrite**: the statistical-mark layer becomes a measured tool. A rewrite engine builds the reword instruction (paraphrase, humanize, code, back-translate, structural), scores lexical divergence, keeps the strongest candidate, escalates toward a target, and re-applies the deterministic layer; a `rewrite` subcommand on the scrubber CLI carries it in relay mode (no network, no bundled model). Best-effort and honest: it reduces statistical token-sampling marks and reports the divergence, never certifying a vendor detector will fail (#1312).

### Fixed

- **`egc install` survives a root-owned global npm prefix** (#1348): `sudo npm install -g @egchq/egc` followed by `egc install` as the regular user ended with a bare exit 243 (npm's EACCES) and no message, because the installer ran `npm ci --silent` inside the root-owned MCP server directories. A read-only server directory now confirms its dependencies are present in the package root and continues with a note; an `npm ci` failure elsewhere is reported with the directory and exit code; the `.mcp.egc.json` convenience copy and the topology cache are skipped with a note when the install directory is read-only. Found by running the documented sequence end to end in a Debian 12 container.
- **The MCP servers fall back to the portable sql.js engine when native sqlite3 cannot load** (#1350): the sqlite3 6.x prebuilt binary needs glibc 2.38, so on Debian 12, Ubuntu 22.04 and similar hosts both servers died at startup with `GLIBC_2.38 not found` while the CLI kept working through its own fallback. Each server now opens its database through `sqlite-compat`: native first, sql.js behind the same async API on a native load failure, persisted to the same file, with a one-line notice. `EGC_SQLITE_ENGINE=native|wasm` pins either engine.
- **`egc help` exits 0 for `crusher-shim`, `session-inspect`, `prompt` and `claw`** (#1349): the first two printed their usage and exited 1, `prompt` died on a spawn ENOENT when the Python bridge's virtualenv was missing, and `claw` opened the REPL. A missing virtualenv is now reported by name.
- **Windsurf GateGuard and Guardian coexist on `pre_run_command`** (#1340): the flat hooks.json merge treated any EGC-owned entry as the stale version of the script being registered, so registering the Guardian displaced the GateGuard, `egc doctor` reported `hooks.json` as drifted on every healthy install, and `egc repair` only swapped the two entries back and forth. A stale entry now has to carry the same script basename before it is migrated in place.
- **`egc doctor` prints the state-db consolidation hint as an absolute path** (#1341, reported by @Akisolu): the repo-relative `node scripts/maintenance/merge-fragmented-state-dbs.js` only worked from the package root, which a global npm install on Windows never is.
- **The InsAIts monitor test uses the shared subprocess budget** (#1339): a cold Python start on a busy Windows runner overran the file's private 30s budget and surfaced as a mute `spawnSync ETIMEDOUT`.
- **A codex-target install no longer reports 24 healthy skills as drifted forever** (#1295): the native `.agents` tree and the flattened skill catalog both recorded a copy-file operation for the same destination with sources that differed by one frontmatter line, so `egc doctor` could never be satisfied and every `egc repair` pass flipped the files between the two flavors. Plans now keep exactly one copy-file owner per destination, and states already recorded with the shared destination are healed on the next repair.
- **Busy sessions no longer go deaf on the session mesh** (#1296): the cognitive protocol moves to v5 with a busy-sessions-drain-too rule (drain `session_events` at the start of every turn, autonomous-loop ticks and scheduled wakeups included, before any stay-silent decision); the `[egc-mesh]` notice and the integration map state the same rule.

### Changed

- **Every open code-quality finding cleared** (#1344, #1345, #1346): 117 findings in the new-code period and 25 older ones in the installers, all behavior-preserving. Long functions in the Guardian validator, the memory server, doctor, install-apply, repair, the scrubber and the dashboard parsers were split into named helpers; super-linear regexes were replaced by procedural parsers that keep exactly the tolerance of the patterns they replaced; loosely typed session-bus rows are rendered explicitly. Every rewrite was checked against the original code on the same inputs, and the PowerShell path resolver was exercised in a container.
- **`sh scripts/install.sh` works when `sh` is dash**: the installer re-executes itself under bash (which it always needed) and stops with a plain message when bash is not installed, instead of failing later on the first bash-only construct (#1344).
- **The crusher-metrics suite is hermetic on machines with a live session** (#1297): the unknown-session fallback case used to read the real metrics marker and resolve the machine's own session id, failing locally while passing in CI; it now points the marker at a nonexistent path and restores it afterwards.
- **The mesh-transport tests keep writing until the parked waiter wakes** (#1298): the two cases that relied on a single write could miss a filesystem event on a brand-new macOS watcher; they now repeat the write until the wake arrives, so the suite no longer flakes there.

### Security

- **Hardening round across the memory server, the installer, the hooks and the dashboard** (#1356 to #1363, #1365 to #1373): an eighteen-step pass in seventeen pull requests, planned in August and landed in September, with tighter defaults and stricter checks on what EGC accepts from disk, from the network and from the tools it talks to. Every step carries its own tests and went through review on its pull request; no documented command changes.
- **Open advisories cleared in every lockfile** (#1338): browserslist 4.28.8 in the root lockfile, fast-uri 3.1.7 and qs 6.16.0 across the root, egc-guardian and egc-memory lockfiles, plus pip 26.2 in the test requirements. The dashboard lockfile clears its own qs advisory by dropping the stale express tree it no longer declares.

## [1.1.20] - 2026-08-16

### Fixed

- **PowerShell install suite adopts the shared Windows subprocess budgets** (#1286): the dry-run delegation case ran the full Node planning pipeline under a hardcoded 30s cap, which starved a slow cold runner during the v1.1.19 tag validation; the shared 90s win32 full-install budget now applies, and the detection probe uses the shared CLI budget.
- **Chaos harness cleanup guarantees** (#1284, @Tyr1onX): workers exit when the parent dies and the temp directory is removed on every failure path.

### Changed

- **Release checklist codifies the missing gates** (#1286): the tag-ref CI run must finish green, the inbox must be swept, and the published artifact must be verified end to end before a release is announced.

## [1.1.19] - 2026-08-16

### Added

- **Real-time session mesh, end to end**: wake-on-write delivery over the session-bus store with the `session_wait` long-poll tool, **ON by default** (`EGC_MESH_PUSH=0` opts out); cognitive protocol **v4** teaches every install to announce presence, drain events on the `[egc-mesh]` notice, claim paths before shared edits, and park when idle; and a native turn-boundary wake signal ships for Claude Code, Antigravity (project and global), Codex CLI, Trae, Amp, and Kiro, each wiring verified against the vendor's current documentation or source (#1273, #1274, #1275, #1277, #1278, #1281). Measured: 26ms wake, p95 11ms, zero loss or duplication at 1000 events across 10 subscribers; the per-harness delivery map lives in `docs/spec/integration-tiers.md` behind a parity test.
- **Multi-process chaos harness for the session bus** (expert audition #1254): SIGKILL lock recovery within TTL, contested claims with a single winner, writer-death atomicity, and per-sender ordering under concurrent writers, barrier-based with no sleep synchronization (#1271, #1284, @Tyr1onX).
- **Operable session bus view in the dashboard**: live sessions, path locks, and handoffs surfaced through the shared operations registry (#1265, @Maqbool61).

### Changed

- **Gemini CLI, Continue.dev, and Roo Code retired from the install package** after their vendors discontinued them: 20 supported tools, with the adapters kept in the tree for rollback, the public counts moved together behind the parity test, and the registry explaining a retirement instead of calling a formerly valid id unknown. Antigravity succeeds Gemini CLI on the same `~/.gemini` home (#1279).

### Fixed

- **Session event delivery is exactly-once across overlapping readers**: a real double-delivery race surfaced by the chaos harness, closed with a compare-and-swap on the event cursor so a losing reader safely re-reads (#1271, @Tyr1onX).
- **`egc auto-update` skips retired or unknown targets** with an honest notice instead of crashing the whole run (#1279).
- The misleading npm-link note in the install docs, found during a real-day Linux test mission, ships corrected (#1231, reported by @rathaur-ankit).

## [1.1.18] - 2026-08-06

### Added

- **Guardian command validation extended across the tool ecosystem**: real pre-action blocking hooks wired into Cursor, OpenCode, Kiro CLI, Cline, Amp, Amazon Q Developer CLI, Goose, and OpenHands, each through a host-specific adapter over shared parsing and merge libraries (#1067-#1092); an earlier viability report that wrongly classified three of those hosts as prompt-only was corrected against each project's own source.
- **Token Crusher PATH-level binary shim** (`egc crusher-shim install|uninstall|status`): transparently compresses output from git, npm, gh, pip and friends without an explicit `egc run` wrapper, with full passthrough on TTYs and clean degradation on any resolution failure (#1107, #1110, #1112, #1114).
- **NLI session bus and memory protocol coverage extended** to Aider, Warp, Windsurf, Zed and more, completing the 23-tool surface (#1059-#1062).
- **`egc gain` scoped savings breakdown**: today, current session, current project, since install, and rolling 7/30-day windows, with local-calendar-day boundaries (#1118, @Tyr1onX).
- **Claude Code re-injects project context after compaction** (#1069), and OpenCode restores project context on session creation instead of starting cold (#1115, @Tyr1onX).
- **`doctor`, `repair`, and `auto-update` accept `--repo-root`**, and the cognitive protocol marker is versioned across all 11 install targets so existing installs pick up new protocol sections on the next update (#1093, #1095).

### Security

- **Guardian no longer denies reading paths it only protects against writes**: legitimate diagnostics of EGC's own install were blocked; now six operational directories are readable and everything else stays denied by default, a design that went through two independent security audits before merging (#1205).
- **Prompt-injection scanning wired into the WebFetch path**: every fetched page is scanned automatically by the advisory heuristic scanner instead of requiring a manual call (#1123, #1126, #1127).

### Bug Fixes

- **Token Crusher PATH shim could fork-bomb the host under an isolated HOME** (sandboxed installs, CI, containers): shim identity is now anchored to the launcher's physical directory with realpath checks and a circuit breaker, covered by POSIX and Windows regression tests (#1191).
- **Installers now do what the docs say**: Claude Code MCP registration goes through the real CLI instead of a dead config file (#1193), the bare install merges the project `.mcp.json` of the directory you ran it from (#1195), one registration list serves all three entry points so Continue.dev and Zed are finally registered by the shell installers (#1197), and the installation guide matches actual behavior (#1196, #1206).
- **Token Crusher compresses JSON with nested lists**, the shape almost every real API returns; measured on a real payload: 637 KB down to 31 KB (#1204).
- **`egc repair` rebuilds what it can** and reports what it cannot, with the cause, instead of abandoning the whole target over one orphaned file (#1210); `egc doctor` reports state stores honestly instead of a blanket divergence warning (#1194).
- **MCP server builds are self-contained and cross-platform**, no longer reaching outside the package or requiring `chmod` on Windows (#1211).
- **Windows reliability**: the session bridge no longer drops events on slow cold starts (#1203), and subprocess test budgets are sized per platform (#1209, #1212).
- **Learned skills with a `When to Activate` section are summarized correctly** at session start instead of falling back to the intro paragraph (#1213); the devfleet catalog entry points at the repository that exists (#1214).
- **Memory corruption from an orphaned marker fixed at the root**: a stale marker left behind in propagated context files (`.cursor`, `.trae`, `AGENTS.md`, `GEMINI.md` and 10 more) could delete real user content instead of just the EGC-managed section; an outdated MCP runtime made it worse by overwriting `.cursor` with no marker at all. Reported directly by Helal Ferrari Cabral (@helalferrari). 57 new tests, CI green on all 3 OSes (#1102, #1103).
- **`egc doctor` / state-store divergence fixed**: a bare terminal invocation of `getEGCDir()` fell back to the first harness directory that happened to exist on disk (for example OpenCode) instead of the tool-agnostic `~/.egc` default, silently routing commands to the wrong `state.db`. Reported directly by Helal Ferrari Cabral (@helalferrari) (#1104).

### Changed

- **Cloning the repository or installing the Codex plugin no longer auto-bundles six third-party MCP servers** (close to 1 GB of RAM combined); the root `.mcp.json` stays for the plugin contract but declares nothing, the Cursor install stops injecting them, and the `mcp-configs/` catalog remains the documented path for installing any of them by hand (#1215). Personal tooling entries left the published package earlier in the same effort (#1202).

## [1.1.17] - 2026-07-27

### Bug Fixes

- **Windows install fixed at the actual root cause**: `install.sh` wrote MCP server paths in the POSIX form Git Bash exposes (`/c/Users/...`), which native Windows MCP clients such as Claude Desktop and Cursor cannot resolve. `install.sh` now detects `MINGW*`/`MSYS*` via `uname -s` and rewrites those paths through `pwd -W` before they reach the MCP config JSON, closing the item left open since the 2026-07-25 install audit and the real reason the project's "one script, one install" design was not holding on Windows (#1045).
- **`install.ps1` brought back in line with `install.sh`** after drifting silently for weeks: the Node version floor was still 18 instead of 20; dependency installs had no lockfile-aware path (`npm ci` when a lockfile is present, nothing otherwise, exactly matching `install.sh`); an existing MCP config that failed to parse as JSON was silently overwritten instead of left untouched, which could have discarded a user's real configuration; Codex CLI TOML paths were not escaped, so a raw Windows backslash path could corrupt the TOML file through an accidental `\U` Unicode escape; and the guardian/memory builds were not guarded behind a `src/` check for the published tarball (#1045).
- Installation guide skill/command counts corrected to 230 skills and 77 commands (#1045).

## [1.1.16] - 2026-07-26

### Security

- **Destructive-CLI hard blocks in the Guardian validator**: `docker system prune`, `docker rm/rmi`, `docker run --privileged` or host mounts, `gh repo delete`, `gh api -X DELETE`, and `prisma migrate reset` / `--force-reset` / `db execute` now return a hard DANGEROUS verdict instead of an advisory warning, closing a gap where the enforcement hook let these commands run with nothing but a warning (#1041, @fuentes71).
- **Guardian validator hardened against an absolute-path bypass**: `/bin/rm`, `/usr/bin/mv` and similar path-qualified forms are now matched against the destructive command list instead of slipping through as an allowlist miss (#1012); path resolution and log file permissions were hardened at the same time (#1011).
- **Bash hook dispatcher fails closed**: an error in the dispatcher's own plumbing used to fail open, silently disabling every guard (Guardian validate, GateGuard) for that command. It now fails closed, the most critical finding of the latest security audit (#1019).
- **`auto_learn` validates its write target**: `target_file` is now checked against protected paths and must stay inside the project root, closing a write-outside-sandbox path (#1009). Two more destructive filesystem paths were guarded in the plugin and orchestration lib (#1016).
- **`core.hooksPath` no-verify bypass closed**: git hook-path overrides are now matched case-insensitively (#1013).
- **`republish.yml` command injection closed**: the version input is now validated instead of interpolated directly into a shell command (#1027).
- **Docker hardened**: images run as a non-root user via a multi-stage build that keeps the build toolchain out of the final image (#1036), and a `.dockerignore` keeps `.git`, `.env` and `node_modules` out of the build context (#1028).
- **All remaining Dependabot and Scorecard advisories cleared**: `tar` and `brace-expansion` across the root and both mcp-server lockfiles (#992, #994, #995).

### Bug Fixes

- **Crowdin translation sync corruption fixed at the root**: `upload_translations` re-uploaded the post-processed export back to Crowdin, and Crowdin does not sentence-segment Chinese, so a whole paragraph collapsed onto the first segment. Sync is now one-way (Crowdin to repo only); the poisoned zh-CN strings were cleaned up via the Crowdin API (#1038, #1039, #1040).
- **Chinese Simplified Crowdin path fixed end to end**: mapped to the canonical `zh-CN` path with existing repo translations seeded (#988, closes #483), root-relative asset and doc links rewritten in downloaded translations (#1004), and sync commits signed so the DCO check passes (#1006).
- **Three runtime bugs from the #987 deep audit fixed**: an `orchestrate_task` TOCTOU gap, lesson decay reading the wrong timestamp, and the integrity key loader silently regenerating on a malformed key (#989, @aryamirani).
- **`get_state` no longer time-travels on feature branches**: the default-branch fallback now prefers the hashed main state file over the legacy plain `main.md` left behind by pre-hash versions (#1005).
- **Bare `egc install` fixed on the published npm package**: `install.sh` falls back to `npm install` when the published tarball ships no root lockfile, and only builds when `src/` is present (#985, #986, closes #643).
- **Team sync no longer deletes local state files** absent from the remote (#1015); the state store falls back to the jsonl store on a `state.db` error (#1014).
- **`egc` CLI subcommand forwarding fixed** for `plugin`, `budget` and `team`, and `gain` / `install-apply` output corrected (#1024).
- **Telemetry ping is time-bound** so it never delays CLI exit (#1023).
- **Fuzz harness actually fuzzes**: the validator is bundled to CommonJS so `jsfuzz` can instrument it instead of running blind (#1029); CI now builds the MCP servers before the test suite, closing a false-green gap where roughly 20 defense tests were silently skipped (#1030).
- **Catalog indexer fixed**: only `SKILL.md` files are indexed, and YAML block scalars in frontmatter parse correctly (#1025).
- **Windows fixes**: the TypeScript check hook runs via `node`, and Zed JSON bin paths are escaped correctly (#1021); `install.sh` aligns the Node version floor, keeps dev dependencies, and hardens config writes (#1017).
- **OpenAI provider fallback redacts unmapped SDK errors** instead of leaking them (#1022).

### Maintenance

- **CodeRabbit reviews contributor PRs automatically** and skips the maintainer's own to save review credits; the manual first-time-contributor gate workflows were retired (#997).
- **Supported AI coding tool count synced** across docs, translations and plugin manifests (#984, #1018, #1020, #1031).
- **Test coverage added** for the dispatcher, tool executor and prompt builder (#1037).
- **Catalog keyword router memoizes token sets** for faster search (#1026).

## [1.1.15] - 2026-07-21

### New Features

- **Token Crusher on every hook-capable host**: the compression hook now reaches all six harnesses. Codex and CodeBuddy (#959), Copilot, Antigravity and Continue (#964), plus pipelines and compound commands crushed through `egc run --shell` (#956). The core bug that silently dropped every rewrite is fixed: the dispatcher now emits `hookSpecificOutput.updatedInput`, so the host actually applies the compressed command (#958).
- **Three new install targets**: Roo Code (#957), Qwen Code (#962) and Cline (#965), bringing EGC to 23 supported AI coding harnesses.
- **Ranked keyword search for the catalog**: `egc` scores skills and components by relevance instead of listing them flat (#939).
- **Two new README translations**: Italian (#933) and French (#948), wired into every language selector, bring EGC to 11 languages.
- **Agent Memory Interchange draft specification**: a first draft of the cross-tool memory interchange format (#947).
- **Configurable dashboard port**: the dashboard honors `EGC_PORT` instead of hardcoding 7890 (#963).
- **Explicit HTTP timeouts on every provider**: all native LLM provider clients set a connect/read timeout (#961), and the remaining native providers gained a `stream=True` guard that raises `NotImplementedError` instead of silently returning a blocking response (#912, #924).

### Security

- **Two high-severity advisories patched**: `fast-uri` (GHSA-4c8g-83qw-93j6, host confusion via failed IDN canonicalization) and `linkify-it` (GHSA-v245-v573-v5vm, quadratic DoS in the `mailto:` validator) bumped across the root and both mcp-server lockfiles (#967).
- **`@hono/node-server` serve-static advisory cleared** (GHSA-frvp-7c67-39w9): a transitive pin under `@modelcontextprotocol/sdk` with no patched 1.x release is forced to 2.x via an npm override, clearing the Dependabot alerts and the Scorecard finding. Both mcp servers use stdio transport, so the HTTP adapter never loads.
- **Earlier advisory rounds**: `tar`, `js-yaml` and `brace-expansion` (#952), the mcp and fuzz lockfiles (#955), and `body-parser` (#954).

### Bug Fixes

- **Dashboard serves late-added static files without a restart**: files dropped into `public/` after an in-place upgrade are served immediately, with a symlink guard and a debounced manifest rebuild that keeps the path-traversal protection intact (#928).
- **Multi-byte UTF-8 preserved across TCP chunks** on `POST /event` (#960); malformed JSON now returns 400 instead of crashing the handler (#917).
- **Dashboard resilience**: ping polling survives a dead WebSocket (#943), the offline badge reacts to a dead socket and to consecutive poll failures (#911, #919), reconnect attempts are capped (#951), replay file paths are preserved (#950), a watcher stat-open race is closed (#953), and zombie shim processes can no longer linger (#907).
- **Providers share a single `generate()` error wrapper** across the OpenAI-compatible subclasses, removing duplicated redaction paths (#944).

### Maintenance

- **License migrated from MIT to Apache License 2.0** (#906).
- **Leaner repository root**: configs relocated and the redundant `VERSION` file dropped in favor of `package.json` as the single version source (#908, #940, #946).
- **Bare `egc install` runs the shipped onboarding installers** (#937).

## [1.1.14] - 2026-07-19

### New Features

- **First Chinese Simplified README**: full zh-CN translation contributed by first-time contributor jackmcwin, rewritten from scratch against the repositioned README and wired into every language selector and the translation-structure CI gate. 简体中文 is the 8th language of EGC. (#870, #878, #879)
- **Dashboard launches right after `egc install`**: the launcher is now a shared module used by both `install` and `init`; on an interactive terminal the dashboard is pinged, started detached when absent, and the browser opened, never failing the install. (#893)
- **`egc claw` and `egc harness-audit` promoted to first-class commands**: the NanoClaw REPL and the harness scoring audit are registered in the CLI router and documented in the command reference. (#889)

### Security

- **Guardian validator arg-parsing bypasses closed**: eval flags glued to their value (`--eval=`, `-c` glued, `:` forms) now match in both checkpoints; `grep -f` pattern files are checked against protected paths; `--flag=/path` forms no longer slip past the path checks in cat/find/dev-tool validators. (#882)
- **Provider errors never leak API keys**: claude, cohere, gemini and ollama now redact SDK exception text before raising, and the redaction net gained Google-style `AIza` keys and `key=` query parameters. (#883)
- **Memory commit-privacy guards extended from 4 to all 11 propagation targets**, including non-markdown files like `.cursorrules` and `llms.txt`, across the pre-commit hook, the CI tree check and the git clean filter. (#881)

### Bug Fixes

- **Token Crusher keeps ANSI-colored error lines**: terminal color codes broke the keep-line word boundary and colored errors were silently dropped from compressed output. (#887)
- **Team sync degrades to offline instead of crashing**: a missing or unreachable remote now reports an error in the sync result rather than throwing out of the MCP server. (#890)
- **Hardened scripts**: `harness-audit` no longer crashes on a corrupt `package.json`, `consolidate` handles a state file deleted mid-run, and `init` cannot die on an unhandled dashboard-launch rejection. (#884)
- **OpenCode plugin version drift fixed permanently**: the plugin reported 1.0.0/1.1.6; both constants are realigned and the release script now bumps them in lockstep. (#885)
- **Expired Discord invite replaced** across the README in all 8 languages, contributing docs and the issue templates. (#886)

### Maintenance

- **Leaner repository root**: CODE_OF_CONDUCT and codecov config moved to `.github/`, Dockerfile to `docker/`, installers to `scripts/` (re-anchored), and the stale duplicate Sonar properties file consolidated. (#891)

## [1.1.13] - 2026-07-18

### New Features

- **Commit privacy completed with a git clean filter**: `egc init` now configures `filter.egc-memory.clean` in the local repo config and binds the four memory propagation files (AGENTS.md, GEMINI.md, `.cursor/rules/egc-context.mdc`, `.trae/rules/egc-context.md`) in `.git/info/attributes`. `git add` stages a zeroed blob even when local hooks are bypassed with `--no-verify`, while the working tree keeps the populated memory. Everything stays local to `.git`, nothing tracked is modified, the installer prints the action plan before applying it, and `--dry-run` is honored. Outside a git repository the step is skipped with a reason. (#863)

## [1.1.12] - 2026-07-18

### New Features

- **User-wide global memory**: `update_state` accepts `scope: "global"` to share transversal preferences and lessons across every project; `get_state` and the session-start hooks append a deduplicated `Global Memory` section with strict project-over-global precedence. (#855)
- **Token Crusher**: native shell-output compression built into the package. `egc run <cmd>` crushes long `git log`/`git diff` output, test-runner noise, package-manager installs and large `gh --json` payloads by up to 90% while always preserving errors and warnings; `egc saved` reports accumulated savings locally at zero token cost; on hook-capable harnesses the bash dispatcher silently routes eligible simple commands through `egc run`, strictly fail-open, opt-out via `EGC_DISABLED_HOOKS=pre:bash:crusher-rewrite`. Announced once at the end of `egc init`. (#857, #859, #860)
- **Session Bus MVP**: `session_announce`, `session_peers`, `claim_path` and `release_path` let parallel sessions register presence, split territory and take fail-fast cooperative path locks; sessions silent for 10 minutes are swept and their locks released. (#858)

### Security

- **Commit privacy enforced in layers**: `check-state-leak.js` blocks populated memory in staged blobs (pre-commit hook) and in the tracked tree (CI guard); the public baseline of the propagation files now ships zeroed. (#856)

### Bug Fixes

- **Multi-session SQLite write arbitration hardened**: equal jitter (via `crypto.randomInt`) and deeper retries eliminate lock-step collisions between concurrent sessions. (#853)
- **Zero-friction DCO finally works**: the `prepare-commit-msg` hook had shipped without its executable bit since #719; restored with mode 100755. (#854)

## [1.1.11] - 2026-07-16

### Bug Fixes

- **Dashboard telemetry and cost showing zero in nearly every session**: traced to four root causes: missing PreToolUse/PostToolUse hook wiring for `claude.running`, the Stop hook not forwarding the model field, Claude Code omitting token usage from the Stop payload (now read from the session transcript instead), and the `/stats` regexes never matching the real state-file format (now queried directly from SQLite).

### Maintenance

- **Cyclomatic complexity reduced** in `resolveInstallPlan` and `analyzeRecord`, the two largest functions flagged by the EGC-128 security audit, each split into focused single-purpose helpers with the full test suite kept green.

## [1.1.9] - 2026-07-11

### Security

- **`egc-memory`: TOCTOU race in encryption key generation eliminated**: `loadOrCreateEncKey` used to leave a window where a concurrent process (e.g. a background agent's own `egc-memory` server starting before `~/.egc/encryption.key` existed) could read a key file that was created but not yet fully written. In the original exclusive-write approach, it could also silently generate and cache its own discarded key for the rest of the process lifetime. Key publication is now atomic (write-to-temp plus `fs.linkSync`), so a racing reader either sees no file or a fully-written one, never a partial write. (#696)
- **`resolveProjectPath`: cwd/PWD fallback fixed**: `process.cwd() || process.env.PWD` never reached the `PWD` fallback, because `process.cwd()` throws rather than returning a falsy value when the working directory is unavailable. Now wrapped in try/catch so the documented fallback actually triggers. (#696)

### New Features

- **`update_state`: recovery path for undecryptable state files**: a state file that fails to decrypt (corrupted, or encrypted under an orphaned key from a race) used to permanently block every future `get_state`/`update_state` call for that project, with no sanctioned way to recover: not through the tool itself, and not through the EGC Guardian, which blocks raw shell access to `~/.egc/state/**` by design. `update_state` now accepts an optional `force: true`: when the existing file cannot be decrypted, it is quarantined (renamed to a `.corrupted-backup-<timestamp>` sibling, never deleted) and the call proceeds as a fresh write instead of aborting forever. (#697)

### Contributing

- **Concurrent-access regression tests required**: `CONTRIBUTING.md` and the PR template now require a concurrent-access regression test for any change touching a file shared across concurrent EGC processes (encryption key, state files, install-state, lockfiles under `~/.egc/`), citing the TOCTOU bug above as the motivating example. This bug class is invisible to CodeQL, SonarCloud, and the full test matrix, since none of them reason about interleaving between separate process executions. (#697)

## [1.1.10] - 2026-07-11

### Bug Fixes

- **`egc status`: install health now reflects reality**: `egc status` always reported "Install health: missing" regardless of actual install state, because `upsertInstallState()`, the function that populates the SQLite table `status` reads, was never called anywhere in the install pipeline. `doctor`, `repair`, `auto-update`, and `list-installed` were unaffected, since they read the JSON install-state files directly. Both real completion points (a fresh install and repair/auto-update) now sync into the status store right after writing the JSON file, fire-and-forget so a status-store write failure can never block or fail a real install. Verified end-to-end in a sandboxed environment: status went from "missing" to "healthy" immediately after a real install. (#699)

## [1.1.8] - 2026-07-11

### New Features

- **Continue.dev support**: added as the 14th supported harness (Tier 1). Skills install flat at `~/.continue/skills/<name>/` in both home and project scope, matching the layout of the other Tier 1 targets. (#693)
- **`autonomous-lesson-learning` skill**: orchestrates `continuous-agent-loop` patterns with the `egc-memory` lesson tools (`lesson_recall`, `lesson_save`, `lesson_reinforce`) so long-running autonomous loops recall known failure modes before acting and record new ones as they happen. (#692)

### Security

- **EGC Guardian: granular credential denylist**: whole-directory blocks on `~/.claude`, `~/.cursor`, `~/.gemini`, and `~/.config` were replaced with a denylist of the specific credential files each AI tool actually stores (OAuth tokens, session files, API keys). The old whole-directory block was breaking legitimate functionality (native memory, skills, and EGC's own install) in several harnesses without any real security gain, since the actual secret was always one specific file, never the whole directory. (#691)
- **`runCommand`**: `execSync` replaced with `spawnSync` plus argv tokenization, removing a shell-injection surface in command execution. (#690)
- **`reduce_context`**: file reads now go through a single file handle (open, stat, read, close) instead of separate `statSync`/`readFile` calls, closing a TOCTOU race on the byte-size limit check. (#690)
- **`auto_learn`**: `project_path` is now resolved with `realpathSync` and checked against the protected-path list before use. (#690)

### Bug Fixes

- **State-store write debounce**: writes to the SQLite-backed state store are now debounced (50ms) with a synchronous flush on the first write, restoring error logging that a prior debounce attempt had dropped silently. (#690)

## [1.1.7] - 2026-07-06

### Bug Fixes

- **stress-tests: null guards in db-adapter**: `.get()` results are now checked before property access in all db-adapter stress test assertions. (#635)
- **stress-tests: null guards in state-store and telemetry**: snapshot existence guard added before `.workers.length` access; `!= null` replaces `!== null` to cover `undefined` returns. (#636)
- **telemetry: `ping()` refactored to `Promise.resolve().then().catch()`**: the previous `try/catch` wrapping a `fetch().catch()` was flagged by SonarCloud S4822 as redundant: promise rejection is already handled by the inner `.catch()`. Ping now uses `Promise.resolve().then(() => fetch(...)).catch(() => {})` which also fixes a subtle timing issue in tests. (#637)
- **Windows crash fix consolidated**: idempotent DB close, BOM-safe JSON parsing, `ping()` async fix, and graceful process exit from the Windows libuv crash patch are combined in one clean commit with co-authorship credited to @fuentes71. (#634)

## [1.1.6] - 2026-07

### New Features

- **`egc replay`**: session playback with timeline scrubbing. Replay any past session event by event with full timeline control. Files added: `scripts/replay.js`, `dashboard/public/replay.html`. (#618, contributed by @Maqbool61)
- **`egc budget`**: per-session token and cost limits enforced at the PreToolUse hook. Commands are blocked when the budget is exceeded. (#610, contributed by @Kunall7890)
- **`egc plugin`**: community plugin registry. Install, list, remove, and update skills/agents/rules from npm or a local path: `egc plugin install <name>`. (#611, contributed by @Kunall7890)
- **Team memory sync via git backend**: `egc-memory` now supports syncing lessons and decisions across teammates via a git remote. Context that was previously trapped in a single developer's local session is now shareable. (#606, contributed by @Kunall7890)
- **Native Zed IDE integration**: `egc install --target zed` registers `egc-guardian` and `egc-memory` directly into `~/.config/zed/settings.json` under `context_servers`. Paths are resolved at install time. Closes #602. (#626, contributed by @Maqbool61)
- **AES-256-GCM encryption for state files at rest**: every `.egc/state/` file is now encrypted. Key lives at `~/.egc/egc.key` (mode 0600, auto-generated). Transparent to all existing workflows: `get_state` and `update_state` handle encryption/decryption automatically. Pure Node.js built-in crypto. Closes #579. (#627, contributed by @Maqbool61)
- **HMAC-SHA256 integrity check on state files**: a per-user key at `~/.egc/integrity.key` (mode 0600) and a sidecar `.hmac` file are written alongside every state file. `get_state` verifies on read (warns on mismatch, never blocks). Closes #580. (#625, contributed by @Maqbool61)
- **Guardian enforcement at the harness level**: every Bash command and every Write/Edit/MultiEdit target is validated by the egc-guardian validator through PreToolUse hooks before it executes. A new UserPromptSubmit hook (`prompt-router.js`) routes every prompt through the component catalog and injects recommended skills and agents into context. (#568, #633)
- **`orchestrate_task` now performs real skill/agent/rule routing**: a build-time generator indexes the full component catalog and the guardian classifies each task prompt against it. LLM-based semantic routing available when a provider API key is set; falls back to local keyword scorer otherwise. (#566)
- **Dashboard session export**: session data can now be exported as CSV or JSON directly from the EGC Dashboard. (#595, contributed by @Kunall7890)
- **Continue.dev native MCP registration**: `egc install` auto-detects Continue.dev and registers `egc-guardian` and `egc-memory` via standalone YAML block files in `~/.continue/mcpServers/`. (#564, contributed by @Maqbool61)
- **Community translations**: Korean (#518, @minus43), Russian (#543, @Vile93), Japanese (#614, @VIUK-XV), Arabic, Hindi, Portuguese, Spanish (8 languages total).
- **VS Code + GitHub Copilot installation guide**: setup section added to all 8 language READMEs. (#631)

### Security

- **`egc-guardian` scoped rate limiter per project path**: prevents DoS via request flooding from a single project. (#544, contributed by @developmentwithparth1311)
- **POST /event body capped at 256 KB**: prevents memory exhaustion from oversized event payloads. (#551, contributed by @developmentwithparth1311)
- **Path traversal guard**: static file server in the dashboard is protected against `../` traversal attacks. (#537, contributed by @Vile93)
- **`audit.log` chmod 600**: audit log file now created with restrictive permissions. (#534, contributed by @Maqbool61)
- **Guard clause against missing `ide` field in `accumulateEvent`**: prevents silent telemetry state corruption. 8 regression tests added. (#536, contributed by @BlackPool25)

### Bug Fixes

- **`egc install` now wires all four Claude Code hooks correctly**: UserPromptSubmit (auto-intuition) and PreToolUse (guardian enforcement) were never registered in `~/.claude/settings.json`. All four hooks are now active after `egc install` or `egc repair`. (#596)
- **codebuddy-adapter: hybrid debounce and extension filter**: fires immediately on first event, coalesces follow-ups with 200 ms trailing edge, filters temp files and restricts to recognized log extensions. Closes #506. (#562, contributed by @Maqbool61)
- **VS Code Copilot log detection by modification time**: EGC now picks the newest Copilot log file by `mtimeMs` instead of the first match, fixing incorrect session attribution. (#565, contributed by @Vile93)
- **`egc replay` strict CLI flag validation**: unrecognized flags now surface a clear error message. Closes #620. (#621, contributed by @developmentwithparth1311)
- **`egc replay` JSON output streamed to stdout**: fixes SonarCloud S5145 log-injection finding; `--json` branch now writes to `process.stdout.write` directly. (#622)

## [1.1.5] - 2026-06-24

### Bug Fixes

- **SessionStart hook no longer crashes on startup**: the install plan now copies `propagate-state.js` and `project-detect.js` into `~/.claude/egc/lib/` alongside the hook script. Both `require()` calls are also wrapped in try/catch so existing installs degrade gracefully until `egc repair` runs.
- **`egc init` opens the browser automatically** after starting the dashboard, and also when the dashboard was already running.
- **ESLint now ignores `.claude/worktrees/` and `dashboard/`**: eliminates lint CI failures caused by Claude Code agent worktrees being scanned and service-worker browser globals in the dashboard files.

## [1.1.4] - 2026-06-24

### Bug Fixes

- **npm package corrected**: `dashboard/` directory and the `ws` dependency were missing from the v1.1.3 npm tarball. Users who installed v1.1.3 globally and saw `EGC Dashboard not found. Expected: .../dashboard/server.js` should run `npm install -g @egchq/egc` to get the fix.

## [1.1.3] - 2026-06-24

### New Features

- **EGC Dashboard** (`egc dashboard`): real-time Mission Control panel at `http://localhost:7890`. Shows live tool calls, file edits, shell commands, token usage, memory state, and agent status as your AI works. Auto-starts after `egc init`. Runs as a background WebSocket server; stop with `egc dashboard stop` and check status with `egc dashboard status`.
- **IDE hook emitters**: Cursor, Kiro, and OpenCode now emit structured hook events to the dashboard over WebSocket. Tool calls, file writes, and shell commands appear in real time in the Mission Control panel.

### Bug Fixes

- Fixed OpenAI tool serialization: `parameters` is now always emitted as an object, preventing schema validation errors with strict OpenAI-compatible endpoints.
- Fixed async `ReActAgent` iteration: the agent loop now correctly awaits each tool call result before continuing.
- Fixed stale `X-Title` header in the OpenRouter provider: the header is now derived from the live session title instead of a startup-time snapshot.
- Fixed `GeminiProvider` null content crash: provider now skips `null` content parts instead of throwing on `.text` access.

## [1.1.2] - 2026-06-20

### New Features

- **`egc watch`**: bidirectional sync daemon. Watches all EGC-managed tool config files in the project. When context is edited directly in any tool file (Cursor, Gemini CLI, GitHub Copilot, Windsurf, etc.), the change is extracted from the EGC block and synced to all other tools and back to `~/.egc/state/` automatically. Handles atomic saves (VS Code, Cursor, Windsurf rename-based writes) and Windows EPERM events.
- **`auto_learn`**: new `egc-guardian` MCP tool. Mines session failures from hook event history, identifies recurring errors, and reinforces actionable lessons automatically so they are available to the AI on the next session.

### Memory Improvements

- **`update_state` propagates to 11 tool config files**: calling `update_state` now writes the new context to every EGC-managed file found in the project: `.cursor/rules/egc-context.mdc`, `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurf/rules/egc-context.md`, `.trae/rules/egc-context.md`, `.rules` (Zed), `.clinerules` (Cline), `CONVENTIONS.md` (Aider), `.cursorrules`, `AGENTS.md`, and `llms.txt`. One call keeps every tool in sync.
- **Natural language interface triggers** added to the EGC block in all propagated files. AI tools that read the block now understand natural language phrases ("remember this", "save to memory", etc.) as EGC tool invocations.

### Guardian Pipeline

- **CacheAligner**: normalizes repeated context blocks before compression to reduce redundancy.
- **ContentRouter**: detects payload type and routes to the appropriate compressor.
- **SmartCrusher**: deduplicates JSON arrays structurally, preserving semantic meaning while cutting token count.
- **Headroom Phase 2**: optional deep compression pass for large payloads that exceed the primary budget.
- All modules are wired into `reduce_context` transparently.

### Infrastructure

- **sql.js replaces better-sqlite3**: the state store now uses a pure-JavaScript/WebAssembly SQLite build. No native compilation, no node-gyp, no build tools required. Works on Linux, macOS, Windows, ARM, and Alpine out of the box.
- **GitLab CI and mirror**: full pipeline with lint and tests on Node 20/22, mirroring automatically from GitHub. Pinned actions and workflow-level `permissions: {}` for security.
- **Code of Conduct**: Contributor Covenant added. All contributors and community members are expected to follow it.

### Bug Fixes

- Fixed `update_state` propagation to GitHub Copilot: guard now correctly detects the existing EGC block before inserting.
- Fixed multi-line Context section replacement in bidirectional sync merge.
- Fixed state file path resolution in detached HEAD / non-git directories.
- Fixed `StateWatcher.start()` to return the count of successfully attached watchers rather than the count of discovered files.
- Fixed `egc doctor` to remove stale `better-sqlite3` references after the sql.js migration.
- Pinned `undici` to 6.27.0 in both MCP servers, patching a known CVE.
- Fixed session start hook: the AI had no way to know which agents applied to each project. Session start now detects the project stack and emits a briefing with relevant agents at the start of every session, closing the gap between what EGC promised and what it actually delivered.

## [1.1.1] - 2026-06-19

### New Tools

- **`lesson_recall`** upgraded to BM25 full-text search via FTS5 virtual table. Searching for related lessons now ranks results by relevance instead of doing plain substring matching. Existing lessons are backfilled on first startup.

### Bug Fixes

- Fixed state DB path: `state-db-writer.js`, `runtime-snapshot.js`, and `detect_patterns` now resolve the path via `getEGCDir()` instead of hardcoding `~/.gemini`. Claude Code, Cursor, and VS Code users whose memory pipeline was silently broken are now fixed.
- Fixed hook commands to use `process.execPath` instead of bare `node`, eliminating PATH resolution failures with nvm, mise, fnm, and GUI app launchers.
- Fixed `egc init` to warn clearly when `better-sqlite3` native module is unavailable; `egc doctor` also reports missing `state.db`.
- Fixed `detect_patterns` to probe known harness locations for `state.db` instead of hardcoding `~/.gemini`.

### New Models (community contribution by [@muhammadhasnain3031](https://github.com/muhammadhasnain3031))

- Added 7 OpenRouter model mappings to `ModelResolver`: DeepSeek R1, DeepSeek Chat V3, Qwen3 235B, Qwen3 32B, Llama 4 Maverick, Llama 4 Scout, Llama 3.3 70B Instruct. Each entry includes capability metadata, fallback chains, context window, vision and tool support flags.

## [1.1.0] - 2026-06-13

### New Tools

- **`compress_observations`** - Compresses raw hook observations into structured typed summaries (`tool_failure`, `tool_success`, `file_edit`, etc.) using rule-based analysis. Reduces token usage when injecting observation history into new sessions. Contributed by [@Kunall7890](https://github.com/Kunall7890).

- **`detect_patterns`** - Analyzes runtime events from the state-store database to surface repeated commands and recurring errors across sessions. Helps identify automation candidates and structural issues that persist between conversations.

- **`working_memory`** - Stores transient context within a session with configurable TTL. Entries expire automatically so the memory store does not accumulate stale data across sessions. Exposed as `working_memory_set`, `working_memory_get`, and `working_memory_list`.

- **`lessons`** - Records cross-session knowledge with confidence decay. Each lesson tracks how many times it was reinforced and when it was last seen; confidence degrades over time so stale lessons surface for review rather than being applied forever. Exposed as `lesson_save`, `lesson_recall`, and `lesson_reinforce`.

- **`search_history`** - Full-text search over stored observations using FTS5 with BM25 ranking. Returns results ordered by relevance rather than recency.

### Memory Improvements

- **Branch-aware project state** - `get_state` and `update_state` scope memory per git branch. Switching branches restores the context for that branch automatically.

- **State consolidation pipeline** - A rule-based layering pipeline compresses and consolidates observations on each `update_state` call, keeping the memory store compact without losing important signals.

- **Deterministic SessionStart hook** - The SessionStart hook that writes context into the active harness settings file now runs idempotently. Re-running install or switching adapters does not duplicate entries.

### Infrastructure

- Upgraded CI matrix to Node 20/22/24; dropped Node 18 (EOL).
- Added Windows bun and yarn test jobs.
- SonarCloud AutoScan enabled; all Reliability D and Security Hotspot issues resolved.
- CodeQL Advanced scanning added.
- Dependency Review workflow added for supply chain visibility.

## [1.0.8] - 2024-12-XX

- Initial public release with `npx @egchq/egc` install flow.
- ChatMCP catalog entry (`egc@egc`).
- OIDC Trusted Publishing for npm.
- SessionStart and PreCompact hooks for Claude Code.
