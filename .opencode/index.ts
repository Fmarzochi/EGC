/**
 * EGC - Extended Global Context plugin for OpenCode
 *
 * This package provides the published EGC OpenCode plugin module:
 * - Plugin hooks (Guardian and GateGuard on tool calls, dashboard events,
 *   session lifecycle, shell environment, compaction context, permissions)
 * - Custom tools (run-tests, check-coverage, security-audit, format-code,
 *   lint-check, git-summary, changed-files), under the ./tools entry
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
 * One default export serves both loaders: OpenCode 2 reads its id and setup,
 * OpenCode 1 (1.18.29 and newer) reads its server entrypoint. OpenCode 1
 * calls every other export as a plugin, so nothing else is exported here.
 *
 * @packageDocumentation
 */

export { default } from "./plugins/index.js"
