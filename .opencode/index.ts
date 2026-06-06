/**
 * Everything Gemini Code (EGC) Plugin for OpenCode
 *
 * This package provides the published EGC OpenCode plugin module:
 * - Plugin hooks (auto-format, TypeScript check, console.log warning, env injection, etc.)
 * - Custom tools (run-tests, check-coverage, security-audit, format-code, lint-check, git-summary)
 * - Bundled reference config/assets for the wider EGC OpenCode setup
 *
 * Usage:
 *
 * Option 1: Install via npm
 * ```bash
 * npm install egc-universal
 * ```
 *
 * Then add to your opencode.json:
 * ```json
 * {
 *   "plugin": ["egc-universal"]
 * }
 * ```
 *
 * That enables the published plugin module only. For EGC commands, agents,
 * prompts, and instructions, use this repository's `.opencode/opencode.json`
 * as a base or copy the bundled `.opencode/` assets into your project.
 *
 * Option 2: Clone and use directly
 * ```bash
 * git clone https://github.com/Fmarzochi/EGC
 * cd EGC
 * opencode
 * ```
 *
 * @packageDocumentation
 */

// Export the main plugin
export { EGCHooksPlugin, default } from "./plugins/index.js"

// Export individual components for selective use
export * from "./plugins/index.js"

// Version export
export const VERSION = "1.0.0"

// Plugin metadata
export const metadata = {
  name: "egc-universal",
  version: VERSION,
  description: "Everything Gemini Code plugin for OpenCode",
  author: "Fmarzochi",
  features: {
    agents: 13,
    commands: 31,
    skills: 37,
    configAssets: true,
    hookEvents: [
      "file.edited",
      "tool.execute.before",
      "tool.execute.after",
      "session.created",
      "session.idle",
      "session.deleted",
      "file.watcher.updated",
      "permission.ask",
      "todo.updated",
      "shell.env",
      "experimental.session.compacting",
    ],
    customTools: [
      "run-tests",
      "check-coverage",
      "security-audit",
      "format-code",
      "lint-check",
      "git-summary",
      "changed-files",
    ],
  },
}
