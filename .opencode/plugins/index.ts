/**
 * EGC - Extended Global Context plugin for OpenCode
 *
 * One default export serves both loaders: OpenCode 2 reads its id and setup,
 * OpenCode 1 (1.18.29 and newer) reads its server entrypoint. OpenCode 1
 * calls every other export as a plugin, so nothing else is exported here.
 */

export { default } from "./egc-hooks.js"
