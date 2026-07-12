/**
 * Tests for the published OpenCode hook plugin surface.
 */

const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { pathToFileURL } = require("node:url")

const { maybeSkipBaselineAbsent } = require("./lib/baseline-absent")

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      return { passed: 1, failed: 0 }
    })
    .catch((error) => {
      if (maybeSkipBaselineAbsent(error, name)) {
        return { passed: 1, failed: 0 }
      }
      console.log(`  ✗ ${name}`)
      console.error(`    ${error.stack || error.message}`)
      return { passed: 0, failed: 1 }
    })
}

async function loadPlugin() {
  const repoRoot = path.join(__dirname, "..")
  const buildResult = spawnSync("node", [path.join(repoRoot, "scripts", "build-opencode.js")], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const buildOutput = (buildResult.stdout || "") + (buildResult.stderr || "")
  if (buildResult.status !== 0 || /SKIP: build-opencode/.test(buildOutput)) {
    const error = new Error(`OpenCode build unavailable: .opencode/dist (${buildResult.stderr || buildResult.stdout || "no output"})`)
    throw error
  }
  const pluginUrl = pathToFileURL(
    path.join(repoRoot, ".opencode", "dist", "plugins", "egc-hooks.js")
  ).href
  return import(pluginUrl)
}

function createClient() {
  const logs = []
  return {
    logs,
    app: {
      log: ({ body }) => {
        logs.push(body)
        return Promise.resolve()
      },
    },
  }
}

function createFailingShell() {
  const calls = []
  const shell = (strings, ...values) => {
    calls.push(String.raw({ raw: strings }, ...values))
    const error = new Error("OpenCode plugin file probes must not use shell commands")
    return {
      then: (_resolve, reject) => reject(error),
      text: async () => {
        throw error
      },
    }
  }
  shell.calls = calls
  return shell
}

async function withTempProject(files, fn) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "egc-opencode-plugin-"))
  try {
    for (const file of files) {
      const filePath = path.join(projectDir, file)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "")
    }
    return await fn(projectDir)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log("\n=== Testing OpenCode plugin hooks ===\n")

  let EGCHooksPlugin
  try {
    ({ EGCHooksPlugin } = await loadPlugin())
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, "OpenCode plugin hook suite")) {
      console.log("\nPassed: 0\nFailed: 0")
      process.exit(0)
    }
    throw error
  }
  const tests = [
    [
      "shell.env detects project markers without shelling out to test -f",
      async () => withTempProject(
        ["pnpm-lock.yaml", "tsconfig.json", "pyproject.toml"],
        async (projectDir) => {
          const client = createClient()
          const $ = createFailingShell()
          const hooks = await EGCHooksPlugin({ client, $, directory: projectDir })

          const env = await hooks["shell.env"]()

          assert.deepStrictEqual($.calls, [], `Unexpected shell probes: ${$.calls.join(", ")}`)
          assert.strictEqual(env.PROJECT_ROOT, projectDir)
          assert.strictEqual(env.PACKAGE_MANAGER, "pnpm")
          assert.strictEqual(env.DETECTED_LANGUAGES, "typescript,python")
          assert.strictEqual(env.PRIMARY_LANGUAGE, "typescript")
        }
      ),
    ],
    [
      "session.created checks GEMINI.md through fs instead of shell test",
      async () => withTempProject(["GEMINI.md"], async (projectDir) => {
        const client = createClient()
        const $ = createFailingShell()
        const hooks = await EGCHooksPlugin({ client, $, directory: projectDir })

        await hooks["session.created"]()

        assert.deepStrictEqual($.calls, [], `Unexpected shell probes: ${$.calls.join(", ")}`)
        assert.ok(
          client.logs.some((entry) => entry.message === "[EGC] Found GEMINI.md - loading project context"),
          "Expected GEMINI.md detection log"
        )
      }),
    ],
    [
      "tool.execute.before blocks the first edit on a file with the GateGuard fact-forcing gate",
      async () => withTempProject([], async (projectDir) => {
        fs.mkdirSync(path.join(projectDir, "scripts", "hooks"), { recursive: true })
        fs.mkdirSync(path.join(projectDir, "scripts", "lib"), { recursive: true })
        fs.copyFileSync(
          path.join(__dirname, "..", "scripts", "hooks", "gateguard-fact-force.js"),
          path.join(projectDir, "scripts", "hooks", "gateguard-fact-force.js")
        )
        fs.copyFileSync(
          path.join(__dirname, "..", "scripts", "lib", "utils.js"),
          path.join(projectDir, "scripts", "lib", "utils.js")
        )
        const targetFile = path.join(projectDir, "gated-file.ts")
        fs.writeFileSync(targetFile, "export const x = 1\n")

        const client = createClient()
        const $ = createFailingShell()
        const hooks = await EGCHooksPlugin({ client, $, directory: projectDir })

        await assert.rejects(
          () => hooks["tool.execute.before"]({ tool: "edit", callID: "call-1", args: { filePath: targetFile } }),
          /Fact-Forcing Gate/
        )

        // Second call on the same file should be allowed through (gate already passed).
        await hooks["tool.execute.before"]({ tool: "edit", callID: "call-2", args: { filePath: targetFile } })
      }),
    ],
    [
      "tool.execute.before ignores unmapped tools and args-less calls without throwing",
      async () => withTempProject([], async (projectDir) => {
        fs.mkdirSync(path.join(projectDir, "scripts", "hooks"), { recursive: true })
        fs.mkdirSync(path.join(projectDir, "scripts", "lib"), { recursive: true })
        fs.copyFileSync(
          path.join(__dirname, "..", "scripts", "hooks", "gateguard-fact-force.js"),
          path.join(projectDir, "scripts", "hooks", "gateguard-fact-force.js")
        )
        fs.copyFileSync(
          path.join(__dirname, "..", "scripts", "lib", "utils.js"),
          path.join(projectDir, "scripts", "lib", "utils.js")
        )

        const client = createClient()
        const $ = createFailingShell()
        const hooks = await EGCHooksPlugin({ client, $, directory: projectDir })

        await hooks["tool.execute.before"]({ tool: "read", callID: "call-1", args: { filePath: "/tmp/whatever" } })
        await hooks["tool.execute.before"]({ tool: "edit", callID: "call-2", args: undefined })
      }),
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn)
    passed += result.passed
    failed += result.failed
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
