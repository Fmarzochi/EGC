# EGC Roadmap

This document describes the planned development direction for EGC (Extended Global Context).

## Unreleased

- The shared coding style now opens with a seven-rung minimal-change ladder (no change, deletion, one-line fix at the root cause, local change, existing seam, new unit, new abstraction last) plus The Floor, the list of guarantees a minimal change can never drop, and a routed `minimal-change` skill turns the ladder into a working protocol: rung selection, delivery contract, strictness modes (with The Floor explicitly non-waivable in every mode), worked examples and an anti-pattern table. The rule rides `rules-core` and the cursor/kiro condensations, the skill ships through `workflow-quality` and both generated catalog indices, real installs into scratch homes verified the landing for claude, cursor and codex, and the prompt-library counts moved to 61/231/77 across the README, both installers and the installation guide behind the existing three-way parity test; first-party implementation of the idea @fuentes71 opened in #1188, co-authored on the squash commit (#1256)
- `egc <command>` hands the caller's terminal to its subcommand (`stdio: 'inherit'`) instead of buffering everything through a captured pipe: the piped default made every subcommand non-interactive and held all output until exit, which is how the v1.1.18 Windows report (#1217) ended up with `install.ps1`'s prompt-library step silently skipped and `egc doctor` stuck at the previous version's install-state; the `install.ps1` interactivity gate now also detects a redirected stdin (`[Console]::IsInputRedirected`) and treats a `$null` `Read-Host` answer as the default Y, both installers announce the skip instead of vanishing, and the fossilized prompt-library counts (62/228/74) match the CI-tested README (61/230/77) again behind a new three-way parity test (#1228)
- The two Windows-only crashes from the same v1.1.18 report fixed by their reporter (@Akisolu, first code PR): the `install.ps1` inline `node -e` that Windows PowerShell 5.1's quote-stripping turned into a SyntaxError now lives in a dedicated `scripts/lib/apply-commit-privacy.js`, and the crusher-shim printers normalize `installWindowsPath()`'s single-object result through a shared `toPathResultArray` helper covering install and uninstall alike, so `egc crusher-shim install|uninstall` no longer throws on Windows and labels the registry-backed PATH update honestly; tested end-to-end on a real Windows 10 / PowerShell 5.1 machine before and after review (#1229)
- The new helper resolves the repo root from its own file location instead of `process.argv`, keeping externally influenced strings out of the git-config command it feeds, and the installer call drops the now-unused argument (#1230)
- `egc install` run from the globally installed npm package no longer attempts `npm link` there: both installers resolve the `npm root -g` package directory and compare it (symlink-safe) with their own root first, announcing the skip when they match, so the misleading `npm link failed ... from this checkout` note the #1218 Linux report hit (Ubuntu 26.04, root-owned distro prefix, with a perfectly working `egc` bin regardless) is gone, while git checkouts and unpacked tarballs keep linking exactly as before (#1231)
- The dashboard's first launch no longer dies silently on root-owned global installs (#1233, same Linux testing round): `express` joins the root dependencies (`ws` already was one) so the global install ships everything `dashboard/server.js` resolves, the on-demand `npm install` inside the package directory is gated on dependency resolution plus a writability check with an honest refusal (instead of npm's buried EACCES), and the init/install launcher now polls the detached server for readiness, opening the browser only when it answers and printing `EGC Dashboard did not start.` with the exact foreground command that reveals the real error when it does not (#1234)
- A fresh install now reads as healthy instead of broken, closing the misreading both recent testing rounds tripped over (first-time setup lifecycle from #1056, resurfaced in the #1218 round): the bare-install doctor report leads with `Core runtime: OK` instead of `No EGC install-state files found`, the not-yet-created MCP memory store is described as lifecycle (nothing to do, appears after the first session saves state) instead of absence, the event-store note no longer implies the just-finished `egc init` failed, and init frames its final doctor pass as a check instead of announcing `auto-repairing drift` on a healthy setup; doctor exit-code semantics intentionally untouched (#1242)
- The CLI and the dashboard now reach every operation through one shared library: a single registry (`scripts/lib/operations/index.js`) exposes `doctor`, `install`, `savingsLedger`, and `state` as named operations that return plain JSON and never write to the console, wrapping the existing lifecycle, metrics, and state-store code instead of rewriting it (slice 1 of the two-doors dashboard plan, #1233/#1235). The dashboard's `/stats` drops its private `sqlite3` shell-outs and hand-rolled state-file parsing for the shared `state()` operation, backed by new real count queries (`countDecisions`/`countLessons`/`countPatterns`) matching the previous SQL semantics instead of counting active sessions or capping lists; `egc gain --json` derives its entry count from a single ledger snapshot; and `applyInstallPlan` gains an injectable warning collector plus a non-enumerable sync handle so `egc install --json` output stays clean (#1240, community contribution by @Maqbool61; remaining seams tracked in #1245)
- The Token Crusher's savings ledger is session-aware again under the current harness: the harness session id reaches the ledger through a marker written at session start (`~/.egc/metrics/active-session.json`) with two clocks (an inactivity window by mtime and a lifetime cap by its startedAt stamp), bridging the id the Bash hook payload no longer carries, so `egc gain` attributes crushed runs to the live session instead of only to history (#1247)
- The `gain --json` report print is explicitly marked as intentional command output, closing the security-rule finding that had tripped the main quality gate after #1240, and the session-marker hook library now reaches installed layouts through the hook-library propagation list with a require fallback, so existing installs pick the marker up on the next update instead of waiting for a reinstall (#1248)
- The EGC Dashboard's session bus becomes operable instead of read-only, the flagship slice of the two-doors dashboard plan: `dashboard/ops.js` wires `session_peers`, `session_send`, and `session_events` into the shared operations registry from #1240, so the dashboard can show which sessions are live and send handoffs to them through the same UI that already displays doctor and savings data (#1238, community contribution by @Maqbool61)
- The real-time session mesh (design #1251, layer C2) gets its first core slice, behind a flag: a wake-on-write mesh transport in the egc-memory server (an `fs.watch` on the store's directory, where WAL appends and checkpoint rewrites both surface, with debounce, a tight db/sidecar name filter, an interval fallback for platforms where `fs.watch` is unavailable, and a `close()` that strands nobody) plus a new `session_wait` MCP tool that long-polls the bus and returns the moment events addressed to the session arrive, under the exact cursor semantics of `session_events`. The watcher is a wake signal only: every delivery re-reads the bus tables, so a lost or coalesced filesystem event can delay a round but never lose or duplicate one; the parked wait re-reads write-free, because the server's own presence writes would otherwise retrigger its watcher into a self-waking storm; and every sender-controlled field renders single-line so a crafted payload, kind, or session id cannot forge event headers for downstream parsers. Off unless `EGC_MESH_PUSH=1` (#1273)
- Audition mission #1252 delivered as the maintainer reference: a standalone Linux prototype under `tools/mesh-lab/watcher/` wakes 10 subscriber processes push-style on inotify when events land in the real `bus_events` shape, no polling loops, measured at p95 11ms delivery latency against the 250ms budget (p50 8ms, max 14ms across 10,000 deliveries) with zero loss, zero duplicates and per-sender ordering everywhere, a mid-run `wal_checkpoint(TRUNCATE)` captured and asserted rather than assumed, an LCG property test over 20 interleaved multi-writer schedules, and an fd baseline held across 40 create/park/close cycles (#1274)
- Audition mission #1253 delivered as the maintainer reference: a self-contained cross-platform file-watch benchmark plus a written report under `tools/mesh-lab/watch-bench/`, with real measurements from Linux (inotify wakes in 0.16ms p50 for `-wal` appends) and macOS (11.5ms p50 on an idle stream, plus a recorded measurement trap: hot-stream sampling inflates that roughly 4x via FSEvents window alignment). Sharpest finding: a FILE watch goes silently deaf after an atomic replace or unlink+recreate on both platforms while a directory watch survives every scenario, the strongest evidence for the mesh's dir-watch plus cursor re-read transport contract; the report also documents the inotify `max_user_instances=128` ceiling that makes the interval fallback load-bearing for the unbounded-tabs spec, with the Windows column open for a third-party run of the same script (#1275)

## v1.1.18: Production Hardening (Released 2026-08-06)

- Guardian Bash command validator extended to three more hosts with a genuine pre-action blocking hook: Cursor (#1071), OpenCode (#1072), and Kiro CLI (#1073), each wired through a host-specific translation adapter that reuses shared stdin-parsing and hooks-merge libraries; Token Crusher wired into OpenCode (#1072) and into Antigravity's global hooks.json (#1067)
- Guardian wired into Cline's PreToolUse hook (#1087), researched directly against the cline/cline source rather than the docs (mid-migration to a new SDK plugin system not yet applicable to the VS Code extension); Token Crusher confirmed impossible there (no command-rewrite field in the hook output schema), the same status as Kiro and Windsurf
- Roo Code confirmed to have no hook mechanism at all (Guardian and Token Crusher both impossible, not just Crusher): its own issue tracker shows hooks were never implemented (issue #11504 is an open, unresolved feature request), and the project has been archived since 2026-05-15
- Guardian and Token Crusher wired into Amp via its Plugin API (`tool.call` event): the old hooks doc this had been blocked on (Sourcegraph-internal only) 404s now, replaced by a public, in-process plugin mechanism running under Amp's own Bun runtime, the same architecture as OpenCode's plugin, so Amp gets both mechanisms, not Guardian alone
- Corrected an earlier viability report (EGC-498) that had wrongly classified Amazon Q Developer CLI, Goose, and OpenHands as prompt-only (no hook): each has a real, documented `preToolUse`-style hook (confirmed directly against each project's own docs/source, not the earlier report). Guardian wired into all three; Token Crusher stays out of scope for all three (allow/deny only, no rewrite capability documented anywhere). Amazon Q's custom-agent config (`.amazonq/cli-agents/egc-guardian.json`, project and home) is real but not auto-activated by default due to an open upstream bug (aws/amazon-q-developer-cli#2922): the user must run `q settings chat.defaultAgent egc-guardian` once, or pass `--agent egc-guardian` per session. Goose's hook format is byte-for-byte identical to Claude Code's own settings.json schema (confirmed against aaif-goose/goose's docs, which describe it as following that convention), so its installer reuses the same destination-driven merge builders Junie and Trae already use, at a new self-contained `~/.agents/plugins/egc-guardian/` root. OpenHands' `.openhands/hooks.json` is project-only, with a genuinely different (unwrapped, snake_case) shape from every other host wired so far
- Guardian command validator hardened against wrapper and quoting bypasses across every CLI, plus npm packaging, Codex/TOML, and Copilot/CodeBuddy gaps (#1051-#1055)
- A truncated-but-still-JSON-valid stdin payload could bypass the Guardian's 1MB cap check; the truncation flag is now checked unconditionally in every translation adapter (#1074, and closed for Cursor/Windsurf/Kiro alike)
- NLI session bus and memory protocol coverage extended to 8+ more harnesses, including Aider, Warp, Windsurf, and Zed (#1059-#1062)
- `update_state` no longer clobbers project rule files on propagation (#1058); `$HOME` is now resolved fresh on every key lookup instead of once at process boot (#1065)
- Uncatalogued commands that write to protected files now hard-block instead of only warning (#1070)
- Claude Code re-injects project context after compaction (#1069)
- `doctor`, `repair`, and `auto-update` accept `--repo-root <path>` to compare against a local development checkout instead of the running binary's own install location, closing a false-drift report that had nothing to do with the install itself (#1093)
- The cognitive protocol marker is now versioned across all 11 install targets (Claude Code, Gemini CLI, Cursor, Codex, Windsurf, Zed, OpenCode, Trae, Trae-CN, CodeBuddy, and Continue.dev), so an already-configured install picks up a new protocol section, like the Token Crusher one, on the next `egc init` or `auto-update` instead of staying frozen at whatever shipped on first install; `auto-update` now re-runs the bootstrap step itself so this reaches every user who runs the update command they already use, not just fresh installs (#1093, #1095)
- `egc run`'s git log summary now counts real commits remaining instead of raw lines, which had wildly overstated the count for verbose formats like `--stat` (#1094)
- `install.sh` and `install.ps1` link the `egc` command to the checkout they just set up, so running `egc doctor` or `egc --version` afterward targets the code that was installed rather than a stale prior global install left on PATH (#1096)
- Closed real test-coverage gaps the CI had flagged and left unresolved across the day's work: `openhands-guardian-hooks.js` and `amazonq-guardian-hooks.js` went from 34.53%/74.03% to 100%, and `doctor.js`, `repair.js`, `bootstrap-cognitive.js`, `auto-update.js` from 65-88% to 98.5-100% (#1099)
- Two propagation data-loss bugs and a state-fragmentation bug reported by Helal Ferrari Cabral (EGC-513, BUG-08) fixed: `writeCursorContext`'s legacy-migration heuristic no longer strips hand-written content from `.cursor/rules/egc-context.mdc` when no `<!-- egc:start -->` marker exists yet (#1102); `getEGCDir()`'s Tier 3 fallback now checks the tool-agnostic `~/.egc` default before falling back to the first installed harness dir, so a bare `egc <command>` no longer silently scatters state across several harness-specific databases (#1104, credited in #1105); a read-only, additive, dry-run-by-default maintenance script (`scripts/maintenance/merge-fragmented-state-dbs.js`, not wired into the `egc` CLI) merges the fragments the old bug already created back into the canonical store (#1106). A deeper variant found in the squad review of the EGC-513 fix (EGC-514) is closed too: `upsertEgcSection`, shared by all 14 propagated files, only slices in place when it finds exactly one correctly paired start/end marker set, instead of ever slicing on marker positions it can't be sure are matched (#1103)
- `egc doctor` no longer reports CRLF/LF-only differences as drift (#1108)
- Token Crusher gains a PATH-level binary shim (`egc crusher-shim install|uninstall|status`) that transparently compresses output from git, npm, pnpm, yarn, bun, pip, pip3, poetry, pipenv, uv, composer, bundle, and gh without an explicit `egc run` wrapper: full passthrough whenever stdout is a TTY, and any resolution failure degrades to plain exec rather than blocking the command (#1107); wired into the standard install flow by default (#1112); hardened for case-insensitive PATH filtering, signal handling, and safer Windows PATH edits (#1110); `egc run --raw` now bypasses the shim's own compression instead of double-processing it (#1114); documented in installation.md alongside a fix for stale example counts (#1113)
- OpenCode now restores project context on session creation instead of starting cold (#1115, @Tyr1onX)
- Three real gaps in the Token Crusher's "preserve every error and warning" claim closed, found in the 2026-08-01 README-vs-code audit: PascalCase compound identifiers (`TypeError`, `AssertionError`) now match the keep-word list via a dedicated suffix check, assertion-detail continuation lines (pytest `>`/`E`, Go `expected:`/`actual:`, Rust `left:`/`right:`, compiler caret lines) are preserved even though they don't repeat the summary line's keyword, and Spanish `falló` is no longer dropped as if it were the unrelated word `fallo` (#1119)
- The commit-privacy filter (`.git/info/attributes` + `filter.egc-memory.clean`) now configures itself automatically on first propagation, from both the MCP server and the CLI path, instead of only via the separate manual `egc init` command; a project that only ran `egc install` (the README's own documented command) previously got none of this protection (#1120)
- EGC-512: a quote-aware shell scanner (`hasComplexShellSyntax`) replaces the naive `COMPLEX_SHELL_RE` regex in the Crusher's Bash rewrite hook, so metacharacters inside single or double quotes no longer force an unnecessary `--shell` wrap unless they are actually active outside the quotes; Roo Code, which has no external hook API (confirmed against docs.roocode.com and issue #12025), gets Guardian coverage through its own native `roo-cline.deniedCommands` setting instead, merged additively so a user's own denylist entries always survive; README and SECURITY-ASSESSMENT.md corrected to drop a false "detects prompt injection" claim and an outdated known-limitations list that predated PR #1092 and PR #1080 (#1122)
- `egc gain` gains a scoped savings breakdown (today, current session, current project, since install, rolling 7/30-day windows) alongside the existing lifetime totals, with local-calendar-day boundaries rather than UTC and project/session attribution recorded per ledger entry (#1118, @Tyr1onX)
- Guardian gains a real heuristic prompt-injection scanner, `validate_content` (also reachable via `guardian-cli content`): 9 pattern categories covering instruction-override phrasing, fake system tags, persona hijacking, exfiltration directives, spoofed chat-template control tokens, directives hidden in HTML comments, and zero-width-character clustering near injection keywords. Regex-only by design (no LLM call in the hot validation path), advisory-only (flags, never blocks); this is what the false "detect prompt injection" README claim removed in #1122 now actually refers to (#1123)
- EGC-524's undefined "714 PRs vs 699 items" metric traced to a separate GitHub Projects board count rather than this file; the real 4-PR documentation gap in this doc closed (#1124)
- Real concurrent-write test coverage added for the Token Crusher ledger: 8 separate child processes each write one entry, asserting the JSONL lines never interleave or corrupt, replacing an external contributor's proposed test that exercised no real concurrency (a single-process `Promise.all` over the ledger's synchronous `record()` call) (#1125)
- `validate_content` wired into a real `PostToolUse` hook (`post:webfetch:injection-scan`): every `WebFetch` result is now scanned automatically for prompt-injection patterns instead of requiring a manual call, advisory-only, flags on stderr; `scripts/ci/catalog.js` extended to count and lock `rules/` the same way `agents/`, `skills/`, and `commands/` already are, closing the last catalog claim in the README with no CI check keeping it honest (#1126)
- An independent security-auditor pass on #1126 found and closed 3 real bypasses, each reproduced and verified before and after the fix: `validateWrite`/`isProtectedPath` didn't trim the path string, so a trailing newline (routine for anything piped through `echo`) defeated every `$`-anchored protected-path pattern, letting writes to `.env`/`.bashrc`/etc. through; `checkGitConfigWrite` blocked `include.path` but missed git's `includeIf.<condition>.path` conditional-include syntax, the same wholesale-config-load risk; `post-webfetch-injection-scan.js`'s content extraction only read string fields, silently skipping the scan on standard MCP SDK responses shaped as `{ content: [{ type: 'text', text: '...' }] }` (#1127)
- The Token Crusher PATH shim can no longer fork-bomb the host under a HOME/USERPROFILE override: shim identity was derived from `os.homedir()`, so an overridden home hid the manifest and made the shim resolve to itself and spawn until the OS killed the whole terminal (reproduced at 2.4 GB in 11 seconds). Resolution is now anchored to the launcher's physical directory (manifest read beside it; the Windows `.cmd` bakes its own directory in via `%~dp0`), every candidate is realpath-checked against shim directories including Windows 8.3 short names, PATH probing only surfaces candidates the platform can actually spawn, and a depth-1 circuit breaker turns any residual self-resolution into a clean exit 127 instead of a fork bomb; covered by 6 new POSIX and Windows regression tests (#1191)
- Installers made honest end to end: Claude Code MCP registration goes through the real CLI instead of a dead config file (#1193), the bare install merges the project `.mcp.json` of the invoking directory and starts the dashboard the README promises, headless runs get a clear message instead of silence (#1195), one MCP registration list serves `egc init` and both shell installers so Continue.dev and Zed are finally registered everywhere (#1197), and the installation guide matches actual behavior command by command (#1196, #1206)
- `egc doctor` reports state stores honestly instead of a blanket divergence warning (#1194); `egc repair` rebuilds what it can and reports what it cannot, with the cause, instead of abandoning the whole target over one orphaned file (#1210)
- Guardian no longer denies reading paths it only protects against writes: six operational directories readable, everything else denied by default, approved by two independent security audits (#1205)
- Token Crusher compresses JSON with lists nested inside an object, the shape almost every real API returns, measured 637 KB to 31 KB on a real payload (#1204); the dashboard launcher dropped its shell-spawn path, clearing the main-branch quality gate (#1207)
- Windows reliability: the session bridge no longer drops events on slow Python cold starts (#1203), subprocess test budgets are sized per platform and centralized (#1209, #1212), and the MCP server builds are self-contained and cross-platform (#1211)
- Personal tooling left the published package (#1202), and neither a repo clone nor the Codex plugin auto-bundles third-party MCP servers any more: the root `.mcp.json` stays for the plugin contract but declares nothing, the Cursor install stops injecting them, and the `mcp-configs/` catalog remains the manual path (#1215)
- Learned skills with a `When to Activate` section are summarized by that section at session start instead of the intro paragraph (#1213); the devfleet catalog entry points at the repository that exists (#1214); the codeql-action references were unified in one commit after three isolated bumps proved unmergeable (#1208)

## v1.1.2: Bidirectional Sync (Released 2026-06-20)

- `egc watch`: bidirectional sync daemon - edits in any tool config file propagate to all others and back to `~/.egc/state/` automatically (issues #302, #303)
- `update_state` now propagates context to 11 supported tool config files in one call (issue #313)
- Guardian pipeline: CacheAligner, ContentRouter, SmartCrusher, Headroom Phase 2 wired into `reduce_context`
- `sql.js` replaces `better-sqlite3`: pure-JavaScript/WebAssembly SQLite, no native compilation required
- `auto_learn`: new `egc-guardian` tool that mines session failures and writes actionable lessons automatically
- Stack briefing: session start now detects the project stack and emits a briefing with relevant agents

## v1.1.1: BM25 Search and Bug Fixes (Released 2026-06-19)

- `lesson_recall` upgraded to BM25 full-text search via FTS5 virtual table
- Fixed state DB path resolution across all harnesses
- Fixed hook commands to use `process.execPath` for reliable PATH resolution
- Added 7 OpenRouter model mappings (community contribution)

## v1.1.0: Memory Expansion (Released 2026-06-13)

- `working_memory`: transient key-value store with TTL (issue #138)
- `lessons`: cross-session knowledge with confidence decay (issue #140)
- `detect_patterns`: behavioral analysis from hook events (issue #141)
- `compress_observations`: rule-based observation compression (issue #142)
- `search_history`: BM25 full-text search over decisions (issue #139)
- Branch-aware project state: `get_state`/`update_state` scope per git branch (issue #137)
- State consolidation pipeline on each `update_state` call (issue #143)
- SessionStart hook runs idempotently across harness reinstalls

## v1.1.3 to v1.1.6: Stability and Ecosystem (Released 2026-07)

What shipped in the 1.1.x patch series:

- EGC Dashboard: real-time mission control at `localhost:7890` with live tool calls, token usage, provider comparison, and session export to CSV/JSON
- IDE hook emitters: Cursor, Kiro, OpenCode, CodeBuddy now emit events to the dashboard in real time
- Guardian Protocol deployed to all install targets: `orchestrate_task`, `validate_command`, `validate_write`, `auto_learn` ship by default
- Guardian enforcement fully harness-level: UserPromptSubmit + PreToolUse hooks wired, prompt routing active on every session (#633)
- `egc replay`: session playback with timeline scrubbing (#618, @Maqbool61)
- `egc budget`: per-session token and cost limits enforced at the PreToolUse hook (#610, @Kunall7890)
- `egc plugin`: community plugin registry (`egc plugin install <name>`) (#611, @Kunall7890)
- Team memory sync via git backend (#606, @Kunall7890)
- Native Zed IDE integration (`egc install --target zed`) (#626, @Maqbool61)
- AES-256-GCM encryption for state files at rest (#627, @Maqbool61)
- HMAC-SHA256 integrity check on state files (#625, @Maqbool61)
- Continue.dev native MCP registration (#564, @Maqbool61)
- VS Code + GitHub Copilot installation guide in all 8 language READMEs (#631)
- Security batch: audit.log chmod 600, path traversal guard, scoped rate limiter per project, POST /event body cap at 256 KB, XSS escaping
- Community translations: Arabic, Hindi, Korean, Russian, Japanese, Spanish, Portuguese: 8 languages total
- 14 supported AI coding tools

## v1.1.12: Omnipresent Context (Released 2026-07-18)

Memory everywhere, tokens crushed, sessions coordinated:

- User-wide global memory: `update_state` with `scope: "global"` shares preferences and lessons across every project; `get_state` and the session-start hooks append a deduplicated Global Memory section with strict project-over-global precedence (#855)
- Session Bus MVP: `session_announce`, `session_peers`, `claim_path`, `release_path`: parallel sessions split territory with fail-fast cooperative locks, dead sessions swept after 10 minutes (#858)
- Commit privacy enforced in three layers: `check-state-leak.js`, tracked pre-commit hook, and a CI tree guard; the public baseline of the propagation files now ships zeroed (#856)
- Token Crusher: native shell-output compression engine with `egc run` and the zero-cost `egc saved` report (#857), silent tier A rewrite in the bash dispatcher (#860), status line at `egc init` (#859)
- Multi-session SQLite write arbitration hardened with equal jitter and deeper retries (#853)
- Zero-friction DCO finally works: the prepare-commit-msg hook shipped without its executable bit since #719 (#854)
- 20 supported AI coding tools

## v1.1.13: Commit Privacy Completed (Released 2026-07-18)

Closes the commit-privacy scope started in v1.1.12:

- Git clean filter as the third privacy layer: `egc init` configures `filter.egc-memory.clean` locally and binds the four propagation files in `.git/info/attributes`, so `git add` stages a zeroed blob even when local hooks are bypassed; the working tree keeps the populated memory (#863)
- The installer prints the filter action plan before applying it and honors `--dry-run`; outside a git repository the step is skipped with a reason (#863)

## v1.1.14: Community Wave (Released 2026-07-18)

- README repositioned around the shared brain across all 8 languages (#869), with Chinese Simplified landing as the 9th community translation (#870, @jackmcwin)
- `egc gain`: the full token savings panel, with `egc saved` as the short report (#874)
- Session bus v2: event queue and implicit presence for parallel sessions (#875); three cross-process races closed (#867)
- Secrets redacted in mapped SDK errors, Google API keys covered (#883)
- Guardian command validator: argument-parsing bypasses closed (#882)
- Commit privacy guard extended to all 11 memory propagation targets (#881)
- `claw` and `harness-audit` registered as first-class `egc` commands (#889)
- Team sync degrades to offline errors instead of crashing (#890)
- Lean repository root: tool configuration files moved to their conventional homes (#891)
- `egc install` launches the dashboard right after installing (#893)

## v1.1.15: Universal Crusher and Clean Security (Released 2026-07-21)

- Relicensed from MIT to Apache License 2.0 (#906)
- Dashboard session shim no longer leaves a zombie process after every event (#907, @developmentwithparth1311)
- Lean repository root phase 2: examples, lint, and test configs relocated, redundant files dropped (#908)
- Dashboard offline badge after consecutive poll failures, with per-endpoint failure streaks (#911, @harshjainnn)
- `LLMInput.stream=True` now raises `NotImplementedError` across the OpenAI-compatible providers instead of silently downgrading to a blocking call (#912, @Sufiyan-MSA)
- Dashboard POST /event rejects malformed JSON with a 400 instead of a silent 200 (#917, @harshjainnn)
- Dashboard offline badge reacts to a dead WebSocket, not only to poll failures (#919, @harshjainnn)
- zh-CN README rendering fixed after the closing div (#922, @Aki-new)
- Last em dash removed from the docs per repo writing convention (#929, @aryamirani)
- CLA workflow runs are named after the PR they check instead of the base branch (#930)
- Italian README translation, the 10th language, wired into all language selectors (#933, @LuckysHorizon)
- Bare `egc install` runs the shipped onboarding installers instead of erroring in a clean environment (#937, @Aki-new via #935)
- `egc catalog search <terms>`: ranked keyword search across skills, agents, rules, components and profiles (#939)
- Lean root phase 3: the VERSION file dropped, package.json is the single version source (#940)
- Official Hugging Face Space launched: https://huggingface.co/spaces/fmarzochi/EGC
- Dashboard /ping polling survives WebSocket outages on a single self-healing timer chain (#943, @Tyr1onX)
- The generate() error wrapper deduplicated into one shared hook across the OpenAI-compatible providers (#944, @harshjainnn)
- Dashboard replay recovers the event file path from the detail field (#950, @Tyr1onX)
- Dashboard caps WebSocket reconnect attempts and surfaces a visible disconnected state (#951, @Tyr1onX)
- Dashboard watcher closes a stat-open TOCTOU race by fstat-ing the already-open descriptor (#953, @Tyr1onX)
- Dependency advisories patched across the MCP servers and fuzz lockfiles (#955)
- Agent Memory Interchange draft specification published (#947)
- Token Crusher now rewrites shell commands before they run and is propagated across six hook-capable hosts: Claude Code, Codex, CodeBuddy, Copilot, Antigravity and Continue (#956, #958, #959, #964)
- Dashboard honors EGC_PORT instead of hardcoding port 7890 (#963, @Maqbool61)
- Dashboard POST /event preserves multi-byte UTF-8 characters split across TCP chunks (#960, @hanu-14)
- Explicit per-client HTTP timeout across every LLM provider (#961, @hanu-14)
- Native Roo Code install target (#957, @Tyr1onX)
- Native Qwen Code install target (#962, @Tyr1onX)
- Native Cline install target, bringing EGC to 23 supported AI coding tools (#965, @Tyr1onX)
- `stream=True` now raises `NotImplementedError` across the five remaining native providers (Claude, Cohere, Gemini, Ollama, Vertex AI), completing stream-guard coverage (#924, @hanu-14)
- Dashboard serves static files added after startup without a restart, with a symlink guard and a debounced manifest rebuild that preserves the traversal protection (#928, @hanu-14)
- French README translation, the 11th language, wired into every language selector (#948, @ankit24417-sys)
- Turkish README translation, the 12th language, wired into every language selector (#970, @Iahmacun)
- German README translation, the 13th language, wired into every language selector (#972, @rathaur-ankit)
- High-severity advisories cleared: fast-uri and linkify-it across the root and mcp-server lockfiles (#967), and `@hono/node-server` forced to 2.x via npm override to close the last Dependabot and Scorecard findings (#968)
- ClusterFuzzLite weekly schedule disabled while upstream is dead-locked for JavaScript, keeping manual `workflow_dispatch` (EGC#910)

## v1.1.16: Security Hardening and Crowdin Root Fix (Released 2026-07-26)

- Guardian validator hardened: the absolute-path bypass on destructive commands closed (#1012), path resolution and log permissions hardened (#1011), `core.hooksPath` no-verify bypass closed (#1013), the bash hook dispatcher fails closed instead of fail-open on its own errors (#1019), `auto_learn` validates its write target against protected paths (#1009), and destructive docker/gh/prisma variants now hard-block instead of just warning (#1041, @fuentes71)
- Crowdin translation sync fixed at the root: upload was re-poisoning Chinese Simplified because Crowdin does not sentence-segment Chinese; sync is now one-way, Crowdin to repo only, with the zh-CN path mapped correctly end to end (#988, #1000, #1003, #1004, #1005, #1006, #1038, #1039, #1040, closes #483)
- Three runtime bugs from the #987 deep audit fixed: an `orchestrate_task` TOCTOU gap, lesson decay reading the wrong timestamp, and the integrity key loader silently regenerating on a malformed key (#989, @aryamirani)
- Bare `egc install` fixed on the published npm package: falls back to `npm install` when the tarball ships no root lockfile (#985, #986, closes #643)
- Docker hardened: non-root user, multi-stage build, `.dockerignore` (#1036, #1028); `republish.yml` command injection closed (#1027); all remaining Dependabot/Scorecard advisories cleared (#992, #994, #995)
- Fuzz harness actually fuzzes now: validator bundled to CommonJS for `jsfuzz` instrumentation (#1029), and CI builds the MCP servers before running the defense test suite, closing a false-green gap (#1030)
- CodeRabbit reviews contributor PRs automatically, retiring the manual first-time-contributor gate workflows (#997)
- CLI, catalog indexer, and Windows install/hook fixes rounding out the squad audit cleanup (#1014, #1015, #1017, #1021, #1022, #1023, #1024, #1025, #1026, #1037)

## v1.1.17: Cross-Platform Install Fixed at the Root (Released 2026-07-27)

- `install.sh` no longer writes unusable POSIX Git Bash paths into MCP config JSON on Windows: `MINGW*`/`MSYS*` is detected via `uname -s` and paths are rewritten through `pwd -W` first (#1045)
- `install.ps1` resynced with `install.sh` after drifting for several releases: Node floor raised to 20, lockfile-aware dependency install with no fallback, a malformed existing MCP config is left untouched instead of being overwritten, Codex CLI TOML paths are escaped, and builds are guarded behind a `src/` check (#1045)

## v1.2.0: Teams

Multi-developer workflows and shared context:

- Shared state between team members (multi-user installations beyond git-backend team memory)
- Organization-level installations and role-based context scoping
- Cross-project memory federation
- Stable MCP server API with versioned interfaces
- `egc-guardian` and `egc-memory` promoted to GA with backward-compatibility guarantees

## v1.3.0: Growth

- Community translations: Ukrainian, Malay (German, French, Italian, and Turkish shipped across v1.1.14 and v1.1.15)
- Per-project skill profiles and overrides
- OSS-Fuzz integration for continuous fuzz testing

## v2.0.0: Enterprise

- Formal security review by an independent party
- SBOM (Software Bill of Materials) generation
- Assurance case documenting security properties
- Contribution from at least two active maintainers (bus factor >= 2)

## Non-Goals

- EGC does not aim to replace AI providers: it augments them
- EGC does not store or transmit user code to any third party
- EGC does not require cloud connectivity for local installations
