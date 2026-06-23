# Installation Guide

## Via npm (recommended)

Requires [Node.js 20 or later](https://nodejs.org/en/download).

```bash
npm install -g @egchq/egc
egc install
```

That's it. The installer detects which AI tools you have installed and configures all of them automatically.

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

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues including permission errors, Node.js version mismatches, and manual MCP registration steps.
