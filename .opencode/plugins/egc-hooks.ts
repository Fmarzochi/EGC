/**
 * EGC - Extended Global Context plugin for OpenCode: the repository's own
 * copy, loaded when OpenCode opens this repository (.opencode/plugins) and
 * published as the egc-universal module.
 *
 * Two loaders read this file. OpenCode 2 requires a default export with an
 * `id` and a `setup` function and hands `setup` a context to register hooks
 * on; OpenCode 1 (1.18.29 and newer) reads the `server` entrypoint of the
 * same default export, the V1 hooks object, and calls every other export as a
 * plugin of its own. The default export is therefore the only export.
 *
 * Hook event mapping (Claude Code to OpenCode):
 * - PreToolUse: tool.execute.before (V1), tool.hook("execute.before") (V2)
 * - PostToolUse: tool.execute.after (V1), tool.hook("execute.after") (V2)
 * - SessionStart / Stop / SessionEnd: the session.created, session.idle and
 *   session.deleted bus events, through the V1 `event` hook or the V2
 *   event.subscribe loop
 */

import * as path from "path"
import { fileURLToPath } from "url"
import type { PluginInput } from "@opencode-ai/plugin"
import changedFilesTool from "../tools/changed-files.js"
import { createEgcCore, dispatchBusEvent, permissionDecision, type EgcCore, type LogLevel, type Logger } from "./lib/egc-plugin-core.js"
import { commandOf, type ToolArgs } from "./lib/guardian-bridge.js"

const PLUGIN_ID = "egc-universal"
const pluginDir = path.dirname(fileURLToPath(import.meta.url))

type ClientLike = {
  app?: { log?: (input: { body: { service: string; level: LogLevel; message: string } }) => unknown }
}

// OpenCode 1 logs through the SDK client; OpenCode 2 documents no logger on
// its context, so a host without one gets a plugin that says nothing.
function loggerOf(client: unknown): Logger {
  const app = (client as ClientLike | undefined)?.app
  const log = app?.log
  if (typeof log !== "function") return () => {}
  return (level, message) => {
    try {
      const result = log.call(app, { body: { service: "egc", level, message } }) as { catch?: (fn: () => void) => unknown } | undefined
      if (result && typeof result.catch === "function") result.catch(() => {})
    } catch {
      // A logger that fails never fails the hook.
    }
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

type V1ToolCall = { tool?: string; sessionID?: string; callID?: string; args?: ToolArgs }
type V1FileEvent = { path?: string; file?: string; type?: string; event?: string }
type V1PermissionAsk = { tool?: string; type?: string; pattern?: unknown; args?: unknown; metadata?: Record<string, unknown> }

// OpenCode 1 entrypoint: the hooks object of the V1 plugin API.
const server = async ({ client, $, directory, worktree }: Partial<PluginInput> = {}) => {
  const worktreePath = worktree || directory || process.cwd()
  const log = loggerOf(client)
  const core = createEgcCore({ worktreePath, pluginDir, log, shell: $ })

  return {
    // OpenCode 1 delivers the bus through this hook: the session lifecycle,
    // the file edits, the watcher and the todo list.
    event: async ({ event }: { event?: unknown } = {}) => {
      await dispatchBusEvent(core, event)
    },

    // The event-specific forms stay for dispatchers that call them by name.
    "session.created": async () => core.sessionCreated(),
    "session.idle": async () => core.sessionIdle(),
    "session.deleted": async () => core.sessionDeleted(),
    "file.edited": async (event: V1FileEvent) => core.fileEdited(event?.path ?? event?.file ?? ""),
    "file.watcher.updated": async (event: V1FileEvent) =>
      core.watcherUpdated(event?.path ?? event?.file ?? "", event?.type ?? event?.event ?? ""),
    "todo.updated": async (event: { todos?: unknown }) => core.todoUpdated(event?.todos),

    // OpenCode 1 passes the arguments in the output half of the pair, where
    // the plugin may edit them; older dispatchers put them on the input.
    "tool.execute.before": async (input: V1ToolCall, output?: { args?: ToolArgs }) => {
      core.beforeTool(input?.tool ?? "", output?.args ?? input?.args, input?.callID)
    },
    "tool.execute.after": async (input: V1ToolCall) => {
      await core.afterTool(input?.tool ?? "", input?.args, input?.callID)
    },

    // The environment of every shell command, written into the output
    // OpenCode 1 reads and returned for the dispatchers that read the value.
    "shell.env": async (_input?: unknown, output?: { env?: Record<string, string> }) => {
      const env = core.shellEnv()
      if (output?.env && typeof output.env === "object") Object.assign(output.env, env)
      return env
    },

    // The EGC block joins the context of the compaction; the host keeps its
    // own prompt.
    "experimental.session.compacting": async (_input?: unknown, output?: { context?: string[] }) => {
      const { context, prompt } = core.compactionContext()
      if (output && Array.isArray(output.context)) output.context.push(context)
      return { context, compaction_prompt: prompt }
    },

    // A permission the plugin may answer for the person; the rest stays with
    // the person, as "ask".
    "permission.ask": async (input: V1PermissionAsk, output?: { status?: string }) => {
      const action = stringOf(input?.tool) || stringOf(input?.type)
      log("info", `[EGC] Permission requested for: ${action}`)
      const command = commandOf(input?.args as ToolArgs) || stringOf(input?.metadata?.command) || stringOf(input?.pattern)
      const reason = permissionDecision(action, command)
      if (!reason) return { approved: undefined }
      if (output && typeof output === "object") output.status = "allow"
      return { approved: true, reason }
    },

    tool: {
      "changed-files": changedFilesTool,
    },
  }
}

type Registration = { dispose?: () => unknown } | undefined
// A callback typed for its own event is assignable to a parameter typed for
// `never`, so every registration below keeps its event shape.
type HookDomain = {
  hook?: (name: string, callback: (event: never) => unknown) => Promise<Registration> | Registration
}
type ToolEditor = {
  add: (definition: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown, context: unknown) => Promise<{ content: string }>
  }) => unknown
}
type SessionInfo = { directory?: string; location?: { directory?: string } }
type PluginContext = {
  location?: { directory?: string; project?: { directory?: string } }
  client?: unknown
  tool?: HookDomain & { transform?: (edit: (editor: ToolEditor) => unknown) => unknown }
  session?: HookDomain & { get?: (input: { sessionID: string }) => unknown }
  permission?: HookDomain
  shell?: HookDomain
  event?: { subscribe?: (options?: { types?: string[]; signal?: AbortSignal }) => AsyncIterable<unknown> }
}
type ToolBeforeEvent = { tool?: string; sessionID?: string; callID?: string; input?: unknown }
type ToolAfterEvent = { tool?: string; sessionID?: string; callID?: string; input?: unknown; args?: unknown; status?: string }
type CompactionEvent = { sessionID?: string; system?: Array<{ type: string; text: string }> }
type BusEvent = { properties?: { sessionID?: unknown; info?: { id?: unknown } } }
type CoreResolver = (sessionID: unknown) => Promise<EgcCore>

// How many sessions and checkouts one OpenCode process remembers; the oldest
// entry leaves when a newer one arrives past the cap.
const MAX_REMEMBERED = 64

function remember<Key, Value>(map: Map<Key, Value>, key: Key, value: Value): void {
  if (!map.has(key) && map.size >= MAX_REMEMBERED) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}
type PermissionEvaluation = { action?: unknown; resources?: unknown; effect?: string; message?: string }
type ShellCreateBefore = { env?: Record<string, string | undefined> }

const CHANGED_FILES_INPUT = {
  type: "object",
  properties: {
    filter: { type: "string", enum: ["all", "added", "modified", "deleted"], description: "Filter by change type (default: all)" },
    format: { type: "string", enum: ["tree", "json"], description: "Output format: tree for terminal display, json for structured data (default: tree)" },
  },
  additionalProperties: false,
}

// The changed-files tool of the V1 object, offered to OpenCode 2 through the
// tool editor; a host that refuses it keeps the hooks.
async function registerChangedFilesTool(context: PluginContext | undefined): Promise<void> {
  const transform = context?.tool?.transform
  if (typeof transform !== "function") return
  try {
    await transform.call(context?.tool, (editor: ToolEditor) => {
      editor.add({
        name: "changed-files",
        description: changedFilesTool.description,
        input: CHANGED_FILES_INPUT,
        execute: async (input, toolContext) => ({
          content: await changedFilesTool.execute(
            input as Parameters<typeof changedFilesTool.execute>[0],
            toolContext as Parameters<typeof changedFilesTool.execute>[1]
          ),
        }),
      })
    })
  } catch {
    // The tool is a convenience; the Guardian and the gate do not depend on it.
  }
}

// The bus of OpenCode 2 is an async iterable: the loop runs until the cleanup
// aborts it, and an event that fails does not stop the next one. Each event
// drives the core of the session it names; one without a session drives the
// core of the plugin location.
function followBusEvents(context: PluginContext | undefined, coreOf: CoreResolver): () => void {
  const subscribe = context?.event?.subscribe
  if (typeof subscribe !== "function") return () => {}
  const controller = new AbortController()
  const loop = async () => {
    for await (const event of subscribe.call(context?.event, { signal: controller.signal })) {
      if (controller.signal.aborted) break
      try {
        const properties = (event as BusEvent | undefined)?.properties
        const core = await coreOf(properties?.sessionID ?? properties?.info?.id)
        await dispatchBusEvent(core, event)
      } catch {
        // One event's failure is not the bus's.
      }
    }
  }
  loop().catch(() => {
    // A subscription the host ends or refuses leaves the hooks working.
  })
  return () => controller.abort()
}

// OpenCode 2 entrypoint: the same behaviors registered on the context the host
// hands over. A host without one of the domains keeps the others.
async function setup(context?: PluginContext): Promise<() => Promise<void>> {
  const location = context?.location?.project?.directory ?? context?.location?.directory ?? process.cwd()
  const log = loggerOf(context?.client)
  const registrations: Array<{ dispose: () => unknown }> = []

  // One core per checkout: a session may work in another checkout than the
  // plugin instance, so its directory is asked of the host once per session,
  // and the plugin location serves a session the host cannot describe. The
  // hook scripts always come from the checkout the plugin lives in, never
  // from the one a session happens to open.
  const cores = new Map<string, EgcCore>()
  const coreFor = (directory: string): EgcCore => {
    let core = cores.get(directory)
    if (!core) {
      core = createEgcCore({ worktreePath: directory, pluginDir, scriptsRoot: location, log })
      remember(cores, directory, core)
    }
    return core
  }
  const directories = new Map<string, Promise<string>>()
  const directoryOf = (sessionID: unknown): Promise<string> => {
    if (typeof sessionID !== "string" || !sessionID) return Promise.resolve(location)
    let pending = directories.get(sessionID)
    if (!pending) {
      const get = context?.session?.get
      pending = typeof get !== "function"
        ? Promise.resolve(location)
        : Promise.resolve()
            .then(() => get.call(context?.session, { sessionID }))
            .then((info) => {
              const own = (info as SessionInfo | undefined)?.location?.directory ?? (info as SessionInfo | undefined)?.directory
              return typeof own === "string" && own ? own : location
            })
            .catch(() => location)
      remember(directories, sessionID, pending)
    }
    return pending
  }
  const coreOf: CoreResolver = async (sessionID) => coreFor(await directoryOf(sessionID))
  const locationCore = coreFor(location)

  const register = async <Event>(
    domain: "tool" | "session" | "permission" | "shell",
    name: string,
    callback: (event: Event) => unknown
  ) => {
    const owner = context?.[domain]
    const hook = owner?.hook
    if (typeof hook !== "function") return
    try {
      const registration = await hook.call(owner, name, callback)
      if (registration && typeof registration.dispose === "function") registrations.push(registration as { dispose: () => unknown })
    } catch {
      // A hook the host refuses leaves that feature off; the plugin still loads.
    }
  }

  // Every callback is async, so a refusal reaches the host as a rejection,
  // whichever way it awaits the hook.
  await register<ToolBeforeEvent>("tool", "execute.before", async (event) => {
    const args = event?.input
    if (!args || typeof args !== "object") return
    const core = await coreOf(event.sessionID)
    core.beforeTool(event.tool ?? "", args as ToolArgs, event.callID)
  })
  // A failed call is reported as such and records no change.
  await register<ToolAfterEvent>("tool", "execute.after", async (event) => {
    if (!event || typeof event !== "object") return
    const args = event.input ?? event.args
    const core = await coreOf(event.sessionID)
    const status = event.status === "error" ? "error" : "success"
    await core.afterTool(event.tool ?? "", (args && typeof args === "object" ? args : undefined) as ToolArgs, event.callID, status)
  })
  await register<CompactionEvent>("session", "compaction", async (event) => {
    if (!event || !Array.isArray(event.system)) return
    const core = await coreOf(event.sessionID)
    event.system.push({ type: "text", text: core.compactionContext().context })
  })
  await register<PermissionEvaluation>("permission", "evaluate", async (event) => {
    if (!event || typeof event !== "object" || event.effect !== "ask") return
    const resources = Array.isArray(event.resources) ? event.resources : []
    const command = resources.find((entry): entry is string => typeof entry === "string") ?? ""
    const reason = permissionDecision(stringOf(event.action), command)
    if (!reason) return
    event.effect = "allow"
    event.message = reason
  })
  // The shell hook names no session: the environment is the plugin location's.
  await register<ShellCreateBefore>("shell", "create.before", async (event) => {
    if (!event || typeof event !== "object" || !event.env || typeof event.env !== "object") return
    Object.assign(event.env, locationCore.shellEnv())
  })

  await registerChangedFilesTool(context)
  const stopEvents = followBusEvents(context, coreOf)

  // Every registration is disposed whatever one disposer does, the event loop
  // ends with them and the sessions are forgotten.
  return async () => {
    stopEvents()
    await Promise.allSettled(
      registrations.splice(0).map((registration) => Promise.resolve().then(() => registration.dispose()))
    )
    cores.clear()
    directories.clear()
  }
}

export default { id: PLUGIN_ID, setup, server }
