# Installation Guide

## Via npm (recommended)

Requires [Node.js 20 or later](https://nodejs.org/en/download). Node.js 24 LTS is recommended.

```bash
npm install -g @egchq/egc
egc install
```

That's it. The installer detects which AI tools you have installed and configures all of them automatically.

> **Note:** If you use a Node.js version manager (mise, nvm, asdf, fnm), install EGC under your **default** Node version -- the one active outside any project directory. Installing it under multiple Node versions causes version conflicts. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for details.
>
> **Permissions:** if `npm install -g` fails with `EACCES` (typical when Node comes from your distro's package manager or a system-wide installer and the global npm prefix is root-owned, as on a stock Ubuntu with `apt` Node or a Homebrew Node on macOS), the clean fix is a user-writable prefix: a Node version manager (mise, nvm, asdf, fnm) or a custom npm global prefix under your home directory, as described in [TROUBLESHOOTING.md](TROUBLESHOOTING.md). If you would rather keep the system Node, `sudo npm install -g @egchq/egc` works as a one-off; run `egc install` and everything after it **without** sudo, so the files EGC writes under your home stay owned by you.

The bare install prepares the runtime only. To have your AI tools restore project memory on their very first prompt, continue with [stage 2 below](#2-project-setup): `cd` into a project and run `egc init` once.

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

```bash
npm install -g @egchq/egc
egc install --target zed
```

This installs EGC's skills into `~/.config/zed/`. It does **not** register the MCP servers: `--target <tool>` only ever installs skills and rules.

To get `egc-guardian` and `egc-memory` into Zed's `context_servers`, run the installer or `egc init` instead. Both detect Zed and write to `~/.config/zed/settings.json` with paths resolved at install time:

```bash
egc init
```

---

### Continue.dev

EGC registers both MCP servers as standalone YAML block files in `~/.continue/mcpServers/`. If you already have Continue.dev installed, re-run `egc install` to pick it up automatically.

```bash
npm install -g @egchq/egc
egc install
```

No `--target` flag is needed -- Continue.dev is auto-detected during install.

---

## Installation lifecycle

EGC setup has three distinct stages. You can stop after the stage that matches what you need.

### 1. Bare install

```bash
egc install
```

This prepares the core runtime, initializes the shared state store, and registers the MCP servers in detected tools. A bare install does **not** create managed target install-state files, so `egc doctor` may report that none exist. That is expected, not an error.

The dashboard starts right after this stage when you are at an interactive terminal. A headless run (CI, or output redirected to a file) skips it and prints `Dashboard not started (headless environment). Run 'egc dashboard' to start it.` instead.

### 2. Project setup

Run this from the root of a project you want EGC to manage:

```bash
egc init
```

This bootstraps the cognitive protocol, registers MCP servers, configures project-local memory protections, verifies the setup, and starts the dashboard.

### 3. Full profile

Install the complete managed content set for a specific target when you want rules, skills, agents, commands, and platform configuration tracked by `egc doctor` and `egc repair`:

```bash
egc install --target <target> --profile full
```

Use `egc catalog` to inspect available targets, profiles, and components before installing.

### Removing EGC

`egc uninstall --target <target>` removes every managed file that target's install-state recorded (rules, skills, hooks, platform configuration); `egc uninstall` with no target does that for every install-state in the current context, and `--dry-run` lists the paths first. Two things stay on purpose: the shared state store in `~/.egc` (memory, savings ledger, sessions), and the cognitive protocol block the bare install writes into `~/.gemini/GEMINI.md`, which no install-state tracks. Delete those by hand for a clean slate, then remove the package itself:

```bash
npm uninstall -g @egchq/egc
```

> **Optional dependency:** `uv` is required only for the Jira and omega-memory MCP servers. Core EGC installation and all other targets are unaffected when `uv` is not installed.

---

## Linux / macOS (from source)

Not sure if you have Node.js 20? Run `node --version`. If it shows 20 or higher, you're ready.

```bash
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
sh scripts/install.sh
```

### What the installer does

1. Compiles the MCP servers (`egc-guardian`, `egc-memory`)
2. Initializes the local SQLite database
3. Runs the cognitive bootstrap: writes the memory protocol into `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, and equivalent files for each detected tool

> **Note:** Gemini CLI free tier was discontinued on June 18, 2026 for individual users. The `~/.gemini/GEMINI.md` target still works for paid Google accounts. For free-tier users, [Antigravity CLI](https://antigravity.dev) is the recommended alternative: EGC supports it via `egc install --target antigravity`.
4. Registers both MCP servers in every detected tool's config file
5. Asks interactively whether to install the prompt library (61 agents, 232 skills, 77 commands): skipped automatically in CI
6. Installs the Token Crusher binary shim (`~/.egc/bin`): a best-effort, non-fatal step, see [Token Crusher](#token-crusher) below

### Example output

```
EGC install
  node v22.0.0
  npm 10.0.0
  Optional dependency not found: uv
    Required only for Jira and omega-memory MCP servers.
    Core EGC installation is unaffected. Install: https://docs.astral.sh/uv/
  installing root dependencies...
  building egc-guardian...
  building egc-memory...
  initializing database...
  bootstrapping cognitive protocol...
  [cognitive] Claude Code: memory protocol installed (~/.claude/CLAUDE.md)
  [cognitive] Cursor: memory protocol installed (~/.cursor/rules)
  registering MCP servers...
  ✓ registered egc-guardian in Claude Code (user scope)
  ✓ registered egc-memory in Claude Code (user scope)
  ✓ registered in Cursor (~/.cursor/mcp.json)

Install prompt library? (61 agents, 232 skills, 77 commands) [y/N]:

Installing Token Crusher binary shim...
Shim directory: ~/.egc/bin
Installed: git, npm, gh, ...

Installation complete.
EGC Dashboard starting at http://localhost:7890
Re-check anytime with 'egc doctor'.
```

Only the tools you actually have are touched, so your own output will be
shorter or longer than this one. Claude Code is registered through its own
CLI (`claude mcp add -s user`), which is why those two lines name the
servers individually. In a headless environment (CI, or output piped to a
file) the dashboard line is replaced by `Dashboard not started (headless
environment). Run 'egc dashboard' to start it.`

---

## Windows

```powershell
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
.\scripts\install.ps1
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

This compares every managed file EGC installed against the source it came from, reporting drift, missing files, and version mismatch per target. It also checks the state store: where it lives, whether the memory store exists yet, and whether older versions left stray copies behind.

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

The dashboard starts automatically after `egc install` and `egc init`, whenever you are at an interactive terminal. Headless environments (CI, or output redirected to a file) skip it and say so.

You can control it manually:

```bash
egc dashboard          # start the dashboard server
egc dashboard stop     # stop it
egc dashboard status   # check if it is running
```

The local server is available at `http://localhost:7890`. It streams everything your AI does in real time: tool calls, file edits, shell commands, token usage, cost per session, and agent status, across every IDE you have running.

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

**Known limitation:** on Claude Code, that hook rewrite does not fire for commands the AI assistant itself runs through the Bash tool -- only for a human typing directly into the terminal. This is a confirmed, permanent gap in how Claude Code's `PreToolUse` hook applies to assistant-issued commands, not an EGC bug.

To cover that gap, `egc install` and `egc auto-update` also install a PATH-level binary shim under `~/.egc/bin`, covering `git`, `npm`, `pnpm`, `yarn`, `bun`, `pip`, `pip3`, `poetry`, `pipenv`, `uv`, `composer`, `bundle`, and `gh`: small launcher files that sit ahead of the real binaries on `PATH` and route through the same compression engine. Because it works via normal shell `PATH` resolution, it compresses output for any caller -- a human, this AI, or another tool entirely -- regardless of hook support. It requires a new shell session after install to pick up the `PATH` change. Manage it directly with:

```bash
egc crusher-shim install    # add the shim to ~/.egc/bin and your shell's PATH
egc crusher-shim status     # check whether it's installed and active in this shell
egc crusher-shim uninstall  # remove it
```

---

## EGC Scrubber

The Scrubber removes AI provenance marks from content you own, automatically. On hook-capable harnesses it registers a `PreToolUse` hook at `egc init` (the same way the Token Crusher and Guardian do), so files are cleaned as they are written: invisible Unicode carriers (zero-width family, BOM, tag characters, variation selectors, and more) and long dashes are stripped, while the invisibles that carry meaning (emoji joiners, complex-script joiners, flag tags, RTL marks) are preserved. A commit hook removes AI co-authorship from commit messages while keeping human co-authors.

An opt-in `content-scrubber` skill and CLI cover on-demand and batch use, including metadata: they strip AI-provenance metadata from Markdown frontmatter, HTML head and SVG, from PNG and JPEG images, and from PDF Document Info dictionaries. Metadata cleaning is honest about partial coverage: compressed-stream and encrypted cases are reported, never altered.

Everything is pure Node, deterministic, and fail-open: a parse error, an engine error, or binary input passes the original content through untouched, so the Scrubber can never block or corrupt a write. Opt out of the automatic write hook anytime with `EGC_DISABLED_HOOKS=pre:scrubber`.

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
| `egc crusher-shim` | Install, uninstall or check the PATH-level Token Crusher binary shim for tools without hook support |
| `egc claw` | NanoClaw REPL: persistent session-aware agent loop with Markdown history |
| `egc harness-audit` | Score the harness setup across tool coverage, quality gates, memory, and security |

`egc doctor`, `egc repair`, and `egc auto-update` all accept `--repo-root <path>`, pointing them at a local development checkout instead of wherever the running `egc` binary was installed from. Without it, they compare your managed files against the published npm package, which reports every unreleased change as missing or drifted. Pass a `--repo-root` pointing at your local checkout when running any of these three commands so all agree on the source of truth.

### Getting a fix before it ships to npm

`egc auto-update` only runs a real `git pull` when the install directory has a `.git` folder (i.e. you installed via `git clone`, not `npm install -g`). On a git-based install, `auto-update` pulls straight from `origin/main`, so a fix that has merged but not yet been published as an npm release still reaches you. On an npm-only install, there is no repository to pull from: `auto-update` prints a reminder to run `npm install -g @egchq/egc@latest`, which only helps once a new version has actually been published. If you need a fix that is on `main` but not yet released, `git clone` + `sh scripts/install.sh` (or `.\scripts\install.ps1`) is the reliable path, not `npm install -g`.

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues including permission errors, Node.js version mismatches, and manual MCP registration steps.
