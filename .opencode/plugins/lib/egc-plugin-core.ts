/**
 * The behaviors of the EGC OpenCode plugin, shared by its two loaders.
 *
 * OpenCode 1 hands the plugin a hooks object (`server`), OpenCode 2 hands it a
 * context to register hooks on (`setup`); both land here. The core knows the
 * project it serves, the dashboard, the Guardian and the GateGuard, the files
 * the session touched and the hook profile, and nothing about either API.
 */

import * as fs from "fs"
import * as http from "http"
import * as path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { initStore, recordChange, clearChanges, type ChangeType } from "./changed-files-store.js"
import {
  commandOf,
  filePathOf,
  gateGuardDenyReason,
  guardianDenyReason,
  isShellTool,
  readDashboardToken,
  type ToolArgs,
} from "./guardian-bridge.js"

export const EGC_VERSION = "1.1.23"

export type HookProfile = "minimal" | "standard" | "strict"
export type LogLevel = "debug" | "info" | "warn" | "error"
export type Logger = (level: LogLevel, message: string) => void
// Bun's shell, when the host hands one over (OpenCode 1 does, OpenCode 2 does
// not): the formatter, the type check and the desktop notification need it,
// everything else reads the file system directly.
export type Shell = PluginInput["$"]

export type CoreOptions = {
  worktreePath: string
  pluginDir: string
  log: Logger
  shell?: Shell
}

const PROFILE_ORDER: Record<HookProfile, number> = { minimal: 0, standard: 1, strict: 2 }
const SCRIPT_FILE = /\.(ts|tsx|js|jsx)$/
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "search", "list"])
const FORMATTER_COMMAND = /^(npx )?(prettier|biome|black|gofmt|rustfmt|swift-format)/
const TEST_COMMAND = /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/
const LONG_RUNNING_COMMAND = /^((npm|pnpm|yarn|bun)\s+(install|build|test|run)|cargo\s+(build|test|run)|go\s+(build|test|run))/
const LOCKFILES: Record<string, string> = {
  "bun.lockb": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
}
const LANGUAGE_MARKERS: Record<string, string> = {
  "tsconfig.json": "typescript",
  "go.mod": "go",
  "pyproject.toml": "python",
  "Cargo.toml": "rust",
  "Package.swift": "swift",
}
const DEFAULT_DASHBOARD_PORT = 7890

export function normalizeProfile(value: string | undefined): HookProfile {
  return value === "minimal" || value === "strict" ? value : "standard"
}

function dashboardPort(): number {
  const raw = process.env.EGC_PORT
  return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_DASHBOARD_PORT
}

// Telemetry for the EGC Dashboard, best-effort: a dashboard that is not
// running, refuses the token or answers late changes nothing for the call.
function emitDashboard(body: Record<string, unknown>): void {
  try {
    const payload = JSON.stringify(body)
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    }
    const token = readDashboardToken()
    if (token) headers["x-egc-token"] = token
    const request = http.request(
      { hostname: "127.0.0.1", port: dashboardPort(), path: "/event", method: "POST", headers, timeout: 300 },
      () => {}
    )
    request.on("error", () => {})
    request.on("timeout", () => request.destroy())
    request.end(payload)
  } catch {
    // Telemetry never fails a tool call.
  }
}

function toolLabel(tool: string): string {
  return tool ? tool.charAt(0).toUpperCase() + tool.slice(1) : "Tool"
}

// The permission a plugin may answer for the person: read-only tools, the
// formatters and the test runners; anything else stays with the person.
export function permissionDecision(action: string, command: string): string | null {
  if (READ_ONLY_TOOLS.has(action)) return "Read-only operation"
  if (!isShellTool(action)) return null
  if (FORMATTER_COMMAND.test(command)) return "Formatter execution"
  if (TEST_COMMAND.test(command)) return "Test execution"
  return null
}

export type EgcCore = ReturnType<typeof createEgcCore>

export function createEgcCore(options: CoreOptions) {
  const { worktreePath, pluginDir, log, shell } = options
  initStore(worktreePath)

  const editedFiles = new Set<string>()
  const pendingWrites = new Map<string, { path: string; type: ChangeType }>()
  const profile = normalizeProfile(process.env.EGC_HOOK_PROFILE)
  const disabledHooks = new Set(
    (process.env.EGC_DISABLED_HOOKS || "").split(",").map((item) => item.trim()).filter(Boolean)
  )

  function hookEnabled(hookId: string, required: HookProfile | HookProfile[] = "standard"): boolean {
    if (disabledHooks.has(hookId)) return false
    const needed = Array.isArray(required) ? required : [required]
    return needed.some((entry) => PROFILE_ORDER[profile] >= PROFILE_ORDER[entry])
  }

  function resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(worktreePath, p)
  }

  function hasProjectFile(relativePath: string): boolean {
    try {
      return fs.existsSync(resolvePath(relativePath))
    } catch {
      return false
    }
  }

  function countConsoleLogs(file: string): number {
    try {
      return (fs.readFileSync(resolvePath(file), "utf8").match(/console\.log/g) ?? []).length
    } catch {
      return 0
    }
  }

  // A write is classified before it lands (the file exists or not) and
  // recorded after it succeeds; the call id ties the two halves, the path
  // stands in for a host that gives none.
  const writeKey = (callID: string | undefined, filePath: string) => callID ?? filePath

  function beforeTool(tool: string, args: ToolArgs, callID?: string): void {
    if (typeof tool !== "string" || !tool) return
    const detail = filePathOf(args) ?? (isShellTool(tool) ? commandOf(args) : "")
    emitDashboard({ ide: "opencode", event: "pre_tool", tool: toolLabel(tool), agent: "main", detail, status: "running" })

    // The Guardian first: a denied command or a protected or denied write is
    // refused before any other hook looks at the call.
    const guardianReason = guardianDenyReason(pluginDir, worktreePath, tool, args)
    if (guardianReason) throw new Error(guardianReason)

    // The Fact-Forcing Gate: the first edit, write or command of a file (or of
    // the session, for a command) waits for the facts.
    if (hookEnabled("pre:gateguard:fact-force", ["minimal", "standard", "strict"])) {
      const gateReason = gateGuardDenyReason(pluginDir, worktreePath, tool, args)
      if (gateReason) throw new Error(gateReason)
    }

    const filePath = filePathOf(args)
    if (tool === "write" && filePath) {
      pendingWrites.set(writeKey(callID, filePath), { path: filePath, type: hasProjectFile(filePath) ? "modified" : "added" })
      if (
        hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) &&
        /\.(md|txt)$/i.test(filePath) &&
        !/README|CHANGELOG|LICENSE|CONTRIBUTING/.test(filePath)
      ) {
        log("warn", `[EGC] Creating ${filePath} - consider if this documentation is necessary`)
      }
    }

    if (isShellTool(tool)) {
      const command = commandOf(args)
      if (hookEnabled("pre:bash:git-push-reminder", "strict") && command.includes("git push")) {
        log("info", "[EGC] Remember to review changes before pushing: git diff origin/main...HEAD")
      }
      if (hookEnabled("pre:bash:tmux-reminder", "strict") && LONG_RUNNING_COMMAND.test(command)) {
        log("info", "[EGC] Long-running command detected - consider using background execution")
      }
    }
  }

  async function afterTool(tool: string, args: ToolArgs, callID?: string): Promise<void> {
    if (typeof tool !== "string" || !tool) return
    emitDashboard({ ide: "opencode", event: "post_tool", tool: toolLabel(tool), agent: "main", status: "success" })

    const filePath = filePathOf(args)
    if (tool === "edit" && filePath) recordChange(filePath, "modified")
    if (tool === "write" && filePath) {
      const key = writeKey(callID, filePath)
      const pending = pendingWrites.get(key)
      if (pending) {
        recordChange(pending.path, pending.type)
        pendingWrites.delete(key)
      } else {
        recordChange(filePath, "modified")
      }
    }

    if (shell && hookEnabled("post:edit:typecheck", ["strict"]) && tool === "edit" && filePath && /\.tsx?$/.test(filePath)) {
      try {
        await shell`npx tsc --noEmit 2>&1`
        log("info", "[EGC] TypeScript check passed")
      } catch (error: unknown) {
        log("warn", "[EGC] TypeScript errors detected:")
        const stdout = (error as { stdout?: string }).stdout
        if (stdout) stdout.split("\n").slice(0, 5).forEach((line) => log("warn", `  ${line}`))
      }
    }

    if (hookEnabled("post:bash:pr-created", ["standard", "strict"]) && isShellTool(tool) && commandOf(args).includes("gh pr create")) {
      log("info", "[EGC] PR created - check GitHub Actions status")
    }
  }

  async function fileEdited(file: string): Promise<void> {
    if (typeof file !== "string" || !file) return
    editedFiles.add(file)
    recordChange(file, "modified")
    if (!SCRIPT_FILE.test(file)) return

    if (shell && hookEnabled("post:edit:format", ["strict"])) {
      try {
        await shell`prettier --write ${file} 2>/dev/null`
        log("info", `[EGC] Formatted: ${file}`)
      } catch {
        // Prettier is not installed or declined the file: the edit stands.
      }
    }

    if (hookEnabled("post:edit:console-warn", ["standard", "strict"])) {
      const count = countConsoleLogs(file)
      if (count > 0) log("warn", `[EGC] console.log found in ${file} (${count} occurrence${count > 1 ? "s" : ""})`)
    }
  }

  function watcherUpdated(file: string, type: string): void {
    if (typeof file !== "string" || !file) return
    let changeType: ChangeType = "modified"
    if (type === "create" || type === "add") changeType = "added"
    else if (type === "delete" || type === "remove" || type === "unlink") changeType = "deleted"
    recordChange(file, changeType)
    if (changeType === "modified" && SCRIPT_FILE.test(file)) editedFiles.add(file)
  }

  function todoUpdated(todos: unknown): void {
    if (!Array.isArray(todos) || todos.length === 0) return
    const completed = todos.filter((todo) => todo && typeof todo === "object" && (todo as { done?: unknown }).done === true).length
    log("info", `[EGC] Progress: ${completed}/${todos.length} tasks completed`)
  }

  function sessionCreated(): void {
    if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return
    log("info", `[EGC] Session started - profile=${profile}`)
    if (hasProjectFile("GEMINI.md")) log("info", "[EGC] Found GEMINI.md - loading project context")
  }

  // The console.log audit of the files the session edited, then the desktop
  // notification where a shell exists to show one.
  async function sessionIdle(): Promise<void> {
    if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
    if (editedFiles.size === 0) return
    log("info", "[EGC] Session idle - running console.log audit")

    let total = 0
    const flagged: string[] = []
    for (const file of editedFiles) {
      if (!SCRIPT_FILE.test(file)) continue
      const count = countConsoleLogs(file)
      if (count > 0) {
        total += count
        flagged.push(file)
      }
    }
    if (total > 0) {
      log("warn", `[EGC] Audit: ${total} console.log statement(s) in ${flagged.length} file(s)`)
      flagged.forEach((file) => log("warn", `  - ${file}`))
      log("warn", "[EGC] Remove console.log statements before committing")
    } else {
      log("info", "[EGC] Audit passed: No console.log statements found")
    }

    if (shell) {
      try {
        await shell`osascript -e 'display notification "Task completed!" with title "OpenCode EGC"' 2>/dev/null`
      } catch {
        // No notification center on this machine.
      }
    }
    editedFiles.clear()
  }

  function sessionDeleted(): void {
    if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
    log("info", "[EGC] Session ended - cleaning up")
    editedFiles.clear()
    clearChanges()
    pendingWrites.clear()
  }

  // The environment every shell command of the session receives: who is
  // running, which profile, and what the project looks like, read from the
  // file system without a shell probe.
  function shellEnv(): Record<string, string> {
    const env: Record<string, string> = {
      EGC_VERSION,
      EGC_PLUGIN: "true",
      EGC_HOOK_PROFILE: profile,
      EGC_DISABLED_HOOKS: process.env.EGC_DISABLED_HOOKS || "",
      PROJECT_ROOT: worktreePath,
    }
    const packageManager = Object.entries(LOCKFILES).find(([lockfile]) => hasProjectFile(lockfile))
    if (packageManager) env.PACKAGE_MANAGER = packageManager[1]
    const detected = Object.entries(LANGUAGE_MARKERS).filter(([marker]) => hasProjectFile(marker)).map(([, language]) => language)
    if (detected.length > 0) {
      env.DETECTED_LANGUAGES = detected.join(",")
      env.PRIMARY_LANGUAGE = detected[0]
    }
    return env
  }

  // What a compaction must keep: the plugin in place and the files the
  // session edited, with the prompt that says what to drop.
  function compactionContext(): { context: string; prompt: string } {
    const lines = [
      "# EGC Context (preserve across compaction)",
      "",
      `## Active Plugin: EGC - Extended Global Context v${EGC_VERSION}`,
      "- Hooks: tool.execute.before/after, session created/idle/deleted, file edited, shell env, compaction, permission",
      "- Tools: run-tests, check-coverage, security-audit, format-code, lint-check, git-summary, changed-files",
      "- Agents: 13 specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
      "",
      "## Key Principles",
      "- TDD: write tests first, 80%+ coverage",
      "- Immutability: never mutate, always return new copies",
      "- Security: validate inputs, no hardcoded secrets",
      "",
    ]
    if (editedFiles.size > 0) {
      lines.push("## Recently Edited Files")
      for (const file of editedFiles) lines.push(`- ${file}`)
      lines.push("")
    }
    return {
      context: lines.join("\n"),
      prompt: "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
    }
  }

  return {
    profile,
    hookEnabled,
    beforeTool,
    afterTool,
    fileEdited,
    watcherUpdated,
    todoUpdated,
    sessionCreated,
    sessionIdle,
    sessionDeleted,
    shellEnv,
    compactionContext,
    permissionDecision,
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// One bus event of OpenCode, whichever loader delivered it (the V1 `event`
// hook or the V2 subscription), routed to the behavior it drives. An event
// the plugin does not follow is ignored.
export async function dispatchBusEvent(core: EgcCore, event: unknown): Promise<void> {
  if (!event || typeof event !== "object") return
  const { type, properties } = event as { type?: unknown; properties?: Record<string, unknown> }
  const props = properties ?? {}
  switch (type) {
    case "session.created":
      core.sessionCreated()
      return
    case "session.idle":
      await core.sessionIdle()
      return
    case "session.deleted":
      core.sessionDeleted()
      return
    case "file.edited":
      await core.fileEdited(stringOf(props.file ?? props.path))
      return
    case "file.watcher.updated":
      core.watcherUpdated(stringOf(props.file ?? props.path), stringOf(props.event ?? props.type))
      return
    case "todo.updated":
      core.todoUpdated(props.todos)
      return
    default:
      return
  }
}
