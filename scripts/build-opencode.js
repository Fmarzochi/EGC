#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const rootDir = path.resolve(__dirname, "..")
const opencodeDir = path.join(rootDir, ".opencode")
const distDir = path.join(opencodeDir, "dist")

// The OpenCode build is downstream tooling that depends on @opencode-ai/plugin,
// which is intentionally NOT a runtime dependency of this repo. When the
// optional peer is missing we skip cleanly (exit 0 with a SKIP marker) so
// `npm install` and CI test matrices stay green; strict publishing pipelines
// can force the build by setting EGC_OPENCODE_BUILD=required.
function hasOpencodePeer() {
  try {
    require.resolve("@opencode-ai/plugin", { paths: [rootDir] })
    return true
  } catch {
    return false
  }
}

const requireBuild = process.env.EGC_OPENCODE_BUILD === "required"

if (!hasOpencodePeer() && !requireBuild) {
  process.stderr.write("SKIP: build-opencode (@opencode-ai/plugin not installed; set EGC_OPENCODE_BUILD=required to force)\n")
  process.exit(0)
}

fs.rmSync(distDir, { recursive: true, force: true })

let tscEntrypoint

try {
  tscEntrypoint = require.resolve("typescript/bin/tsc", { paths: [rootDir] })
} catch {
  throw new Error(
    "TypeScript compiler not found. Install root dev dependencies before publishing so .opencode/dist can be built."
  )
}

execFileSync(process.execPath, [tscEntrypoint, "-p", path.join(opencodeDir, "tsconfig.json")], {
  cwd: rootDir,
  stdio: "inherit",
})
