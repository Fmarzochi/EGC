# Hooks

Hooks are event-driven automations that fire before or after AI tool executions. They enforce code quality, catch mistakes early, and automate repetitive checks.

## How Hooks Work

```
User request → Gemini picks a tool → PreToolUse hook runs → Tool executes → PostToolUse hook runs
```

- **PreToolUse** hooks run before the tool executes. They can **block** (exit code 2) or **warn** (stderr without blocking).
- **PostToolUse** hooks run after the tool completes. They can analyze output but cannot block.
- **Stop** hooks run after each Gemini response.
- **SessionStart/SessionEnd** hooks run at session lifecycle boundaries.
- **PreCompact** hooks run before context compaction, useful for saving state.

## Hooks in This Plugin

## Installing These Hooks Manually

For Gemini Code manual installs, do not paste the raw repo `hooks.json` into `~/.gemini/settings.json` or copy it directly into `~/.gemini/hooks/hooks.json`. The checked-in file is plugin/repo-oriented and is meant to be installed through the EGC installer or loaded as a plugin.

Use the installer instead so hook commands are rewritten against your actual Gemini root:

```bash
bash ./install.sh --target egc --modules hooks-runtime
```

```powershell
pwsh -File .\install.ps1 --target egc --modules hooks-runtime
```

That installs resolved hooks to `~/.gemini/hooks/hooks.json`. On Windows, the Gemini config root is `%USERPROFILE%\\.gemini`.

### PreToolUse Hooks

| Hook | Matcher | Behavior | Exit Code |
|------|---------|----------|-----------|
| **Guardian command enforcement** | `Bash` | Validates every command with the egc-guardian validator before it runs; splits compound commands into segments so destructive commands cannot hide behind chaining or sudo. Blocks destructive commands, protected paths, and forbidden git flags; allowlist misses are advisory. Fails open silently if the validator is unavailable | 2 (blocks) |
| **Guardian write enforcement** | `Write\|Edit\|MultiEdit` | Validates the target path with the egc-guardian validator; blocks writes to protected paths (credential stores, key files). Fails open silently if the validator is unavailable | 2 (blocks) |
| **Dev server blocker** | `Bash` | Blocks `npm run dev` etc. outside tmux: ensures log access | 2 (blocks) |
| **Tmux reminder** | `Bash` | Suggests tmux for long-running commands (npm test, cargo build, docker) | 0 (warns) |
| **Git push reminder** | `Bash` | Reminds to review changes before `git push` | 0 (warns) |
| **Pre-commit quality check** | `Bash` | Runs quality checks before `git commit`: lints staged files, validates commit message format when provided via `-m/--message`, detects console.log/debugger/secrets | 2 (blocks critical) / 0 (warns) |
| **Verification gate** | `Bash` | Before `git commit`/`git push`, checks the `egc verify` receipt for the current tree: warns when it is missing, stale, or failed (default) and blocks with `EGC_VERIFY_GATE=block`, reinjecting the failing verification output | 0 (warns) / 2 (blocks) |
| **Doc file warning** | `Write` | Warns about non-standard `.md`/`.txt` files (allows README, GEMINI, CONTRIBUTING, CHANGELOG, LICENSE, SKILL, docs/, skills/); cross-platform path handling | 0 (warns) |
| **Strategic compact** | `Edit\|Write` | Suggests manual `/compact` at logical intervals (every ~50 tool calls) | 0 (warns) |

### PostToolUse Hooks

| Hook | Matcher | What It Does |
|------|---------|-------------|
| **PR logger** | `Bash` | Logs PR URL and review command after `gh pr create` |
| **Build analysis** | `Bash` | Background analysis after build commands (async, non-blocking) |
| **Quality gate** | `Edit\|Write\|MultiEdit` | Runs fast quality checks after edits |
| **Design quality check** | `Edit\|Write\|MultiEdit` | Warns when frontend edits drift toward generic template-looking UI |
| **Prettier format** | `Edit` | Auto-formats JS/TS files with Prettier after edits |
| **TypeScript check** | `Edit` | Runs `tsc --noEmit` after editing `.ts`/`.tsx` files |
| **console.log warning** | `Edit` | Warns about `console.log` statements in edited files |

### Lifecycle Hooks

| Hook | Event | What It Does |
|------|-------|-------------|
| **Prompt router** | `UserPromptSubmit` | Routes every prompt through the guardian catalog and injects recommended skills and agents into context. Keyword routing by default; set `EGC_ROUTING_LLM=1` for semantic LLM routing when a provider key is available. Never blocks |
| **Auto-intuition** | `UserPromptSubmit` | Detects session intent semantically via a provider LLM, in any language, with no phrase lists. Requires a provider API key; without one it detects nothing and the lifecycle hooks carry the guarantees. On session-end intent it saves the state snapshot and mines the transcript before the AI responds; on resume it injects next steps; on remember it records the user's words verbatim; on history queries it injects project memory. Never blocks |
| **Session memory miner** | `SessionEnd`, `PreCompact` | Extracts decisions, failures, preferences, and next steps from the session transcript via a provider LLM and merges them into the project state sections. Requires a provider API key; skips silently without one. `EGC_MEMORY_MINER=0` disables |
| **Session auto-learn** | `SessionEnd` | Runs the guardian auto_learn miner automatically at session end so recurring tool failures become recommendations in the project's AI config files. Skips gracefully when no failures are found. `EGC_AUTO_LEARN=0` disables |
| **Session start** | `SessionStart` | Loads previous project state and emits a stack briefing with relevant agents for the detected project type |
| **Pre-compact** | `PreCompact` | Saves state before context compaction |
| **Console.log audit** | `Stop` | Checks all modified files for `console.log` after each response |
| **Session summary** | `Stop` | Persists session state when transcript path is available |
| **Pattern extraction** | `Stop` | Evaluates session for extractable patterns (continuous learning) |
| **Cost tracker** | `Stop` | Emits lightweight run-cost telemetry markers |
| **Desktop notify** | `Stop` | Sends macOS desktop notification with task summary (standard+) |
| **Session end marker** | `SessionEnd` | Lifecycle marker and cleanup log |

## Customizing Hooks

### Disabling a Hook

Remove or comment out the hook entry in `hooks.json`. If installed as a plugin, override in your `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [],
        "description": "Override: allow all .md file creation"
      }
    ]
  }
}
```

### Runtime Hook Controls (Recommended)

Use environment variables to control hook behavior without editing `hooks.json`:

```bash
# minimal | standard | strict (default: standard)
export EGC_HOOK_PROFILE=standard

# Disable specific hook IDs (comma-separated)
export EGC_DISABLED_HOOKS="pre:bash:tmux-reminder,post:edit:typecheck"

# Disable only GateGuard during setup or recovery
export EGC_GATEGUARD=off

# Verification gate mode for git commit/push: off | warn | block (default: warn)
export EGC_VERIFY_GATE=block

# Cap SessionStart additional context (default: 8000 chars)
export EGC_SESSION_START_MAX_CHARS=4000

# Disable SessionStart additional context entirely
export EGC_SESSION_START_CONTEXT=off
```

Profiles:
- `minimal`: keep essential lifecycle and safety hooks only.
- `standard`: default; balanced quality + safety checks.
- `strict`: enables additional reminders and stricter guardrails.

### Writing Your Own Hook

Hooks are shell commands that receive tool input as JSON on stdin and must output JSON on stdout.

**Basic structure:**

```javascript
// my-hook.js
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(data);

  // Access tool info
  const toolName = input.tool_name;        // "Edit", "Bash", "Write", etc.
  const toolInput = input.tool_input;      // Tool-specific parameters
  const toolOutput = input.tool_output;    // Only available in PostToolUse

  // Warn (non-blocking): write to stderr
  console.error('[Hook] Warning message shown to Gemini');

  // Block (PreToolUse only): exit with code 2
  // process.exit(2);

  // Always output the original data to stdout
  console.log(data);
});
```

**Exit codes:**
- `0`: Success (continue execution)
- `2`: Block the tool call (PreToolUse only)
- Other non-zero: Error (logged but does not block)

### Hook Input Schema

```typescript
interface HookInput {
  tool_name: string;          // "Bash", "Edit", "Write", "Read", etc.
  tool_input: {
    command?: string;         // Bash: the command being run
    file_path?: string;       // Edit/Write/Read: target file
    old_string?: string;      // Edit: text being replaced
    new_string?: string;      // Edit: replacement text
    content?: string;         // Write: file content
  };
  tool_output?: {             // PostToolUse only
    output?: string;          // Command/tool output
  };
}
```

### Async Hooks

For hooks that should not block the main flow (e.g., background analysis):

```json
{
  "type": "command",
  "command": "node my-slow-hook.js",
  "async": true,
  "timeout": 30
}
```

Async hooks run in the background. They cannot block tool execution.

## Common Hook Recipes

### Warn about TODO comments

```json
{
  "matcher": "Edit",
  "hooks": [{
    "type": "command",
    "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const ns=i.tool_input?.new_string||'';if(/TODO|FIXME|HACK/.test(ns)){console.error('[Hook] New TODO/FIXME added - consider creating an issue')}console.log(d)})\""
  }],
  "description": "Warn when adding TODO/FIXME comments"
}
```

### Block large file creation

```json
{
  "matcher": "Write",
  "hooks": [{
    "type": "command",
    "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const c=i.tool_input?.content||'';const lines=c.split('\\n').length;if(lines>800){console.error('[Hook] BLOCKED: File exceeds 800 lines ('+lines+' lines)');console.error('[Hook] Split into smaller, focused modules');process.exit(2)}console.log(d)})\""
  }],
  "description": "Block creation of files larger than 800 lines"
}
```

### Auto-format Python files with ruff

```json
{
  "matcher": "Edit",
  "hooks": [{
    "type": "command",
    "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const p=i.tool_input?.file_path||'';if(/\\.py$/.test(p)){const{execFileSync}=require('child_process');try{execFileSync('ruff',['format',p],{stdio:'pipe'})}catch(e){}}console.log(d)})\""
  }],
  "description": "Auto-format Python files with ruff after edits"
}
```

### Require test files alongside new source files

```json
{
  "matcher": "Write",
  "hooks": [{
    "type": "command",
    "command": "node -e \"const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const p=i.tool_input?.file_path||'';if(/src\\/.*\\.(ts|js)$/.test(p)&&!/\\.test\\.|\\.spec\\./.test(p)){const testPath=p.replace(/\\.(ts|js)$/,'.test.$1');if(!fs.existsSync(testPath)){console.error('[Hook] No test file found for: '+p);console.error('[Hook] Expected: '+testPath);console.error('[Hook] Consider writing tests first (/tdd)')}}console.log(d)})\""
  }],
  "description": "Remind to create tests when adding new source files"
}
```

## Cross-Platform Notes

Hook logic is implemented in Node.js scripts for cross-platform behavior on Windows, macOS, and Linux. The continuous-learning observer is exposed as a Node-mode hook and delegates to its existing `observe.sh` implementation through a profile-gated runner with Windows-safe fallback behavior.

## Related

- [rules/common/hooks.md](../rules/common/hooks.md): Hook architecture guidelines
- [skills/workflows/strategic-compact/](../skills/workflows/strategic-compact/): Strategic compaction skill
- [scripts/hooks/](../scripts/hooks/): Hook script implementations
