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

After install, EGC starts a local dashboard server at `http://localhost:7890`. It streams everything your AI does in real time: tool calls, file edits, shell commands, token usage, cost per session, and agent status -- across every IDE you have running.

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

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues including permission errors, Node.js version mismatches, and manual MCP registration steps.
