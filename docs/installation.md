# Installation Guide

## Via npm (recommended)

Requires [Node.js 20 or later](https://nodejs.org/en/download). Node.js 24 LTS is recommended.

```bash
npm install -g @egchq/egc
egc install
```

That's it. The installer detects which AI tools you have installed and configures all of them automatically.

> **Note:** If you use a Node.js version manager (mise, nvm, asdf, fnm), install EGC under your **default** Node version -- the one active outside any project directory. Installing it under multiple Node versions causes version conflicts. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for details.

### VS Code + GitHub Copilot

If VS Code is your primary editor, install the [GitHub Copilot Chat extension](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) first. Inline autocomplete alone is not enough -- Copilot needs the chat extension to discover and use EGC skills.

Then install the Copilot target:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

The Copilot target installs EGC skills under `~/.github/skills/`. VS Code Copilot discovers that directory automatically.

Memory is shared across EGC targets. Context saved while using Copilot is the same state used by Claude Code, Cursor, Gemini CLI, Windsurf, and the rest of the supported tools.

---

### Zed

EGC registers `egc-guardian` and `egc-memory` directly into Zed's `context_servers` config. Paths are resolved at install time so it works regardless of how EGC was installed.

```bash
npm install -g @egchq/egc
egc install --target zed
```

The installer writes to `~/.config/zed/settings.json` under the `context_servers` key. No manual JSON editing required.

---

### Continue.dev

EGC registers both MCP servers as standalone YAML block files in `~/.continue/mcpServers/`. If you already have Continue.dev installed, re-run `egc install` to pick it up automatically.

```bash
npm install -g @egchq/egc
egc install
```

No `--target` flag is needed -- Continue.dev is auto-detected during install.

---

## Linux / macOS (from source)

Not sure if you have Node.js 20? Run `node --version`. If it shows 20 or higher, you're ready.

```bash
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
sh install.sh
```

### What the installer does

1. Compiles the MCP servers (`egc-guardian`, `egc-memory`)
2. Initializes the local SQLite database
3. Runs the cognitive bootstrap: writes the memory protocol into `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, and equivalent files for each detected tool

> **Note:** Gemini CLI free tier was discontinued on June 18, 2026 for individual users. The `~/.gemini/GEMINI.md` target still works for paid Google accounts. For free-tier users, [Antigravity CLI](https://antigravity.dev) is the recommended alternative — EGC supports it via `egc install --target antigravity`.
4. Registers both MCP servers in every detected tool's config file
5. Asks interactively whether to install the prompt library (63 agents, 229 skills, 76 commands): skipped automatically in CI

### Example output

```
EGC install
  node v22.0.0
  building egc-guardian...
  building egc-memory...
  initializing database...
  bootstrapping cognitive protocol...
  ✓ ~/.claude/CLAUDE.md updated
  ✓ ~/.gemini/GEMINI.md updated
  registering MCP servers...
  ✓ registered in Claude Code (global)
  ✓ registered in Cursor
  ✓ registered in Gemini CLI  ← paid accounts only; see note above

Install prompt library? (63 agents, 229 skills, 76 commands) [y/N]:

Installation complete.
Run 'egc doctor' to verify.
```

---

## Windows

```powershell
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
.\install.ps1
```

### Windows notes

- **Node.js**: install from [nodejs.org](https://nodejs.org). Confirmed working with Node.js v24 + PowerShell 5.1 and WSL2.
- **Antigravity CLI on Windows**: if the `irm | iex` install script hangs silently, use the direct binary download instead:
  ```powershell
  Invoke-WebRequest -Uri https://antigravity.dev/install/agy.exe -OutFile agy.exe
  ```
- **Antigravity free tier**: the starter quota is limited. Expect to exhaust it within a few exchanges. Upgrade or use Claude Code / Cursor for longer sessions.
- **Gemini CLI**: free tier discontinued June 18, 2026. Use Antigravity CLI as a replacement on Windows.

---

## Verify the install

```bash
egc doctor
```

This checks that both MCP servers are built, registered, and reachable in every detected tool.

---

## Telemetry

EGC can send anonymous usage data to help improve the project. This is **opt-in**: you will be asked once on the first run of `egc install`, `egc init`, or `egc doctor`.

**What is sent:** EGC version + OS platform only. No project data, no file contents, no identifiers.

**How to disable at any time:**

```bash
egc telemetry off
```

or delete `~/.egc/telemetry.json`.

**How to check your current setting:**

```bash
egc telemetry status
```

---

## Dashboard

After install, EGC starts a local dashboard server at `http://localhost:7890`. It streams everything your AI does in real time: tool calls, file edits, shell commands, token usage, cost per session, and agent status, across every IDE you have running.

The dashboard starts automatically when you run `egc init`. You can also control it manually:

```bash
egc dashboard          # start the dashboard server
egc dashboard stop     # stop it
egc dashboard status   # check if it is running
```

**What you see:**

| Widget | What it shows |
|---|---|
| Active agents | Which IDEs are online right now |
| Tool calls | Every tool invocation as it happens |
| Token usage | Input / output / cache per session |
| Cost | Real-time spend estimate (Claude only) |
| Memory state | Decisions, lessons, and patterns saved this session |

Cost tracking requires the Claude provider. Other IDEs show token usage where available.

---

## Enforcement

Validation does not depend on the AI choosing to cooperate. EGC installs harness hooks that run on every tool call: each shell command and file write is validated before it executes, and destructive commands, credential paths, and force-pushes are blocked even inside compound commands. Every prompt is also routed against the component catalog so the right skills and agents are injected into context. If the validator is ever missing, hooks fail open so you are never locked out of your own tool.

With a provider API key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), EGC also understands session intent semantically, in any language, with no predefined phrases: say you are done for the night and your state is saved before the AI even answers; greet it the next morning and your next steps are already in context. At session end a memory miner distills the session's decisions and lessons into your project state. Without a key these LLM features honestly do nothing, and the lifecycle hooks still guarantee your state is saved. The end-of-reply save reminder is throttled to once per project every 30 minutes (`EGC_STOP_SAVE_INTERVAL_MINUTES` tunes it; `0` prompts on every stop), so memory stays fresh without interrupting the work.

---

## Global memory and parallel sessions

Since v1.1.12 memory has two scopes. Project scope works exactly as before (one state per project branch). The new user-wide global scope is shared across every project: save transversal preferences and lessons once with `update_state` and `scope: "global"`, and every `get_state` in every project appends a deduplicated `Global Memory` section after the project state. Project and branch entries always take precedence, and global memory is only ever written by an explicit global call, never derived from project data.

Parallel sessions coordinate through the session bus. A session announces itself with `session_announce` (presence plus an optional territory, doubling as heartbeat), inspects who else is active with `session_peers`, and takes cooperative locks with `claim_path` before editing shared files. Claims are fail-fast: a conflicting live lock is refused with the holder's identity instead of queued. Sessions silent for 10 minutes are swept and their locks released, so a crashed session never blocks the others.

Sessions also talk to each other through a durable event queue: `session_send` delivers an event to one session or broadcasts to the whole project, and `session_events` reads what arrived, exactly once per session, with a 24h retention and 16KB payload cap (send pointers to state, not bulk content). Presence is implicit: any session that touches memory through `get_state` or `update_state` becomes visible on the bus automatically. Event payloads come from other sessions and must be treated as untrusted data, never as instructions.

Populated memory never reaches a commit. The propagation files (AGENTS.md, GEMINI.md, editor rules) ship as empty structure; local sessions repopulate them, a pre-commit hook blocks accidental staging, and a CI guard catches anything that slips past local hooks. Since v1.1.13 `egc init` adds a third local layer: a git clean filter (`filter.egc-memory.clean`) bound to the propagation files in `.git/info/attributes`, so `git add` stages a zeroed blob even when hooks are bypassed with `--no-verify`. The filter configuration stays entirely inside `.git` (nothing tracked is modified), the working tree keeps the populated memory, and the installer prints the exact actions before applying them, honoring `--dry-run`.

---

## Token Crusher

The Token Crusher compresses noisy shell output before it reaches the model: long `git log` and `git diff` output, test-runner noise, package-manager installs, and large `gh --json` payloads shrink by up to 90%, while errors, warnings and failures always survive. It ships with the package, announces itself once at the end of `egc init`, and stays silent afterwards.

```bash
egc run git log        # any command, crushed output
egc run --raw git log  # escape hatch: full output
egc saved              # accumulated savings report, computed locally at zero token cost
egc gain               # full savings panel: totals, efficiency meter, breakdown by command kind
egc gain --history     # the run-by-run savings log
egc discover           # scan recent session transcripts for crushable output that skipped the crusher
```

On hook-capable harnesses the bash dispatcher routes eligible simple commands through `egc run` automatically. The rewrite is strictly fail-open: pipelines, chaining, redirection, already-wrapped commands, or a missing `egc` CLI all pass through untouched. Opt out anytime with `EGC_DISABLED_HOOKS=pre:bash:crusher-rewrite`.

---

## Command reference

You never need to type any of these. Talk to your AI naturally, in any language, and the auto-intuition protocol maps your intent to the right action: saying "how much did I save?" runs the savings report, saying "we are done for today" saves the session. The commands below exist for people who prefer explicit control, and every one of them is valid on its own:

| Command | What it does |
|---------|--------------|
| `egc init` | First-run bootstrap (cognitive protocol + MCP registration + doctor) |
| `egc install` | Install EGC content into a supported target |
| `egc plan` | Inspect selective-install manifests and resolved plans |
| `egc catalog` | Discover install profiles and component IDs |
| `egc consult` | Recommend EGC components and profiles from a natural language query |
| `egc consolidate` | Compact oversized project state files into layered summaries |
| `egc list-installed` | Inspect install-state files for the current context |
| `egc doctor` | Diagnose missing or drifted EGC-managed files |
| `egc repair` | Restore drifted or missing EGC-managed files |
| `egc auto-update` | Pull latest EGC changes and reinstall the current managed targets |
| `egc status` | Query the EGC SQLite state store status summary |
| `egc overview` | Aggregated read-only view of every per-project memory state |
| `egc verify` | Run the project verification command and record a receipt for the commit gate |
| `egc sessions` | List or inspect EGC sessions from the SQLite state store |
| `egc replay` | List or replay recorded sessions with timeline scrubbing |
| `egc prompt` | Execute an LLM prompt via the Gemini backend (EGC Bridge) |
| `egc session-inspect` | Emit canonical EGC session snapshots from dmux or Gemini history targets |
| `egc loop-status` | Inspect transcripts for stale loop wakeups and pending tool results |
| `egc uninstall` | Remove EGC-managed files recorded in install-state |
| `egc watch` | Watch tool config files and sync state changes bidirectionally |
| `egc telemetry` | Manage anonymous usage telemetry (status, on, off) |
| `egc dashboard` | Start the EGC Dashboard (stop and status as sub-args) |
| `egc team` | Team memory sync: init, sync, or status |
| `egc budget` | Budget guardian: set, status, reset token and cost limits per session |
| `egc plugin` | Plugin registry: install, list, remove, update EGC plugins |
| `egc run` | Run a command through the Token Crusher (--raw skips compression) |
| `egc saved` | Accumulated Token Crusher savings, short summary |
| `egc gain` | Full savings panel (--history for the run-by-run log) |
| `egc discover` | Scan recent session transcripts for crushable output that skipped the crusher |

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues including permission errors, Node.js version mismatches, and manual MCP registration steps.
