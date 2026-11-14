/**
 * EGC Guardian and GateGuard bridge for the OpenCode plugin.
 *
 * The hook scripts the Guardian and the GateGuard run through are CommonJS
 * modules installed next to the plugin or carried by the worktree the plugin
 * itself lives in. They run in-process: a blocking verdict becomes a reason
 * the plugin throws, which is how an OpenCode plugin refuses a tool call on
 * either loader.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createRequire } from "module"

type HookModule = { run: (input: unknown) => unknown }
type GuardianVerdict = { exitCode?: number; stderr?: string }
export type ToolArgs = Record<string, unknown> | undefined

// Keyed by the resolved file, so two worktrees served by one process each
// load their own copy instead of sharing the first one's dependencies.
const hookModules = new Map<string, HookModule>()

// The worktree may supply hook scripts only when the plugin file itself lives
// inside it (the EGC repository running its own plugin): a project cannot
// forge where the installed plugin sits, so an installed plugin never loads
// code from whatever project it opens.
function pluginInsideWorktree(pluginDir: string, worktreePath: string): boolean {
  try {
    const plugin = fs.realpathSync(pluginDir)
    const worktree = fs.realpathSync(worktreePath)
    return plugin === worktree || plugin.startsWith(worktree + path.sep)
  } catch {
    return false
  }
}

// The compiled plugin can live in two layouts relative to the hook scripts:
// this repository's own .opencode/plugins/ (two levels above the repository
// root) or an installed copy under <opencode root>/plugins/ with the scripts
// copied alongside at <opencode root>/scripts/hooks/ (one level up).
function resolveHookModulePath(pluginDir: string, worktreePath: string, fileName: string): string | null {
  const candidates = [
    path.join(pluginDir, "..", "scripts", "hooks", fileName),
    path.join(pluginDir, "..", "..", "scripts", "hooks", fileName),
  ]
  if (pluginInsideWorktree(pluginDir, worktreePath)) candidates.push(path.join(worktreePath, "scripts", "hooks", fileName))
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

// Loads one of the hook scripts in-process; a script that is not there is
// looked up again on the next call, so an install that lands mid-session is
// picked up without a restart.
function loadHookModule(pluginDir: string, worktreePath: string, fileName: string): HookModule | null {
  const modulePath = resolveHookModulePath(pluginDir, worktreePath, fileName)
  if (!modulePath) return null
  const cached = hookModules.get(modulePath)
  if (cached) return cached
  try {
    const loaded = createRequire(import.meta.url)(modulePath) as HookModule
    hookModules.set(modulePath, loaded)
    return loaded
  } catch {
    return null
  }
}

// The tool that runs a command: `bash` in OpenCode 1, `shell` in OpenCode 2,
// with the command in `command` either way.
const SHELL_TOOLS = new Set(["bash", "shell"])
// OpenCode's file tools and the Claude-style names the validators expect;
// OpenCode passes filePath/content/newString in the tool args.
const GUARDIAN_WRITE_TOOLS: Record<string, string> = { write: "Write", edit: "Edit" }

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool)
}

export function filePathOf(args: ToolArgs): string | null {
  const p = (args?.filePath ?? args?.file_path ?? args?.path) as string | undefined
  return typeof p === "string" && p.trim() ? p : null
}

export function commandOf(args: ToolArgs): string {
  return String(args?.command ?? "")
}

// The Guardian's refusal for a write, an edit or a shell command, or null to
// proceed: the same validators Claude Code's hooks.json wires in, called
// in-process. The scripts come from the checkout the plugin lives in
// (`scriptsRoot`); the call is judged in the session's own directory (`cwd`),
// which may be another checkout. A blocking verdict (exit code 2) carries the
// reason.
export function guardianDenyReason(pluginDir: string, scriptsRoot: string, cwd: string, tool: string, args: ToolArgs): string | null {
  let verdict: GuardianVerdict | undefined
  if (isShellTool(tool)) {
    const guardian = loadHookModule(pluginDir, scriptsRoot, "pre-bash-guardian-validate.js")
    verdict = guardian?.run({
      tool_name: "Bash",
      tool_input: { command: commandOf(args) },
      cwd,
    }) as GuardianVerdict | undefined
  } else if (GUARDIAN_WRITE_TOOLS[tool]) {
    const guardian = loadHookModule(pluginDir, scriptsRoot, "pre-write-guardian-validate.js")
    verdict = guardian?.run({
      tool_name: GUARDIAN_WRITE_TOOLS[tool],
      // The validator rebuilds the content an edit leaves behind from the old
      // and the new string, so the whole result is judged, not the fragment.
      tool_input: {
        file_path: args?.filePath ?? args?.file_path ?? args?.path,
        content: args?.content,
        old_string: typeof args?.oldString === "string" ? args.oldString : undefined,
        new_string: args?.newString,
        replace_all: args?.replaceAll === true ? true : undefined,
      },
      cwd,
    }) as GuardianVerdict | undefined
  }
  return verdict?.exitCode === 2 ? (verdict.stderr || "Blocked by the EGC Guardian.") : null
}

function gateGuardInput(tool: string, args: ToolArgs): string | null {
  if (isShellTool(tool)) {
    return JSON.stringify({ tool_name: "Bash", tool_input: { command: commandOf(args) } })
  }
  const mappedTool = GUARDIAN_WRITE_TOOLS[tool]
  if (!mappedTool) return null
  const filePath = filePathOf(args)
  if (!filePath) return null
  return JSON.stringify({ tool_name: mappedTool, tool_input: { file_path: filePath } })
}

function gateGuardDenyReasonOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const stdout = (result as { stdout?: unknown }).stdout
  if (typeof stdout !== "string") return null
  try {
    const parsed = JSON.parse(stdout)
    if (parsed?.hookSpecificOutput?.permissionDecision === "deny") {
      return String(parsed.hookSpecificOutput.permissionDecisionReason || "Blocked by the GateGuard Fact-Forcing Gate.")
    }
  } catch {
    return null
  }
  return null
}

// The Fact-Forcing Gate's refusal of the first edit, write or command of a
// file or a session, or null: the gate script runs in-process with the same
// payload Claude Code sends it.
export function gateGuardDenyReason(pluginDir: string, scriptsRoot: string, tool: string, args: ToolArgs): string | null {
  const gateguard = loadHookModule(pluginDir, scriptsRoot, "gateguard-fact-force.js")
  if (!gateguard) return null
  const payload = gateGuardInput(tool, args)
  if (!payload) return null
  return gateGuardDenyReasonOf(gateguard.run(payload))
}

// The dashboard only accepts events that carry the token it keeps in
// ~/.egc/dashboard-token (dashboard/ops.js); a missing or partial token just
// means no telemetry. Read on every event, as scripts/lib/dashboard-token.js
// does, so a rotated token is honored without a restart.
export function readDashboardToken(): string | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
    const raw = fs.readFileSync(path.join(home, ".egc", "dashboard-token"), "utf8").trim()
    return /^[0-9a-f]{64}$/i.test(raw) ? raw : null
  } catch {
    return null
  }
}
