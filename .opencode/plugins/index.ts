/**
 * EGC - Extended Global Context plugins for OpenCode
 *
 * This module exports all EGC plugins for OpenCode integration.
 * Plugins provide hook-based automation that mirrors Gemini Code's hook system
 * while taking advantage of OpenCode's more sophisticated 20+ event types.
 */

export { EGCHooksPlugin, default } from "./egc-hooks.js"

// Re-export for named imports
export * from "./egc-hooks.js"
