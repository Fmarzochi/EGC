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

const WIPE = ["rm", "-rf"].join(" ")
const HOOK_SCRIPTS = ["pre-bash-guardian-validate.js", "pre-write-guardian-validate.js", "gateguard-fact-force.js"]

// A worktree the plugin trusts carries the whole scripts tree: each hook
// requires its sibling modules (segmentation, script walk, gate state and
// rules) and scripts/lib, so a hand-picked list of files rots the moment a
// hook gains a dependency, and the plugin, which lets a tool call through
// when a hook fails to load, turns that rot into a silent pass. Copy the two
// trees as they are and prove every hook loads from the copy.
function stageWorktreeScripts(projectDir) {
  const repoRoot = path.join(__dirname, "..")
  for (const dir of ["hooks", "lib"]) {
    fs.cpSync(path.join(repoRoot, "scripts", dir), path.join(projectDir, "scripts", dir), { recursive: true })
  }
  for (const fileName of HOOK_SCRIPTS) {
    require(path.join(projectDir, "scripts", "hooks", fileName))
  }
}

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

const PEER_PACKAGE_JSON = path.join("node_modules", "@opencode-ai", "plugin", "package.json")

// OpenCode installs the dependencies of .opencode/package.json next to the
// plugin, so a dist that imports @opencode-ai/plugin (the tools the plugin
// registers do) resolves them from .opencode/node_modules. A dist copied into
// another project needs the same node_modules beside it, or the import fails
// there while the same dist works in the repository: link every node_modules
// the build may have resolved the peer from, as scripts/build-opencode.js does.
function linkPluginDependencies(projectDir) {
  const repoRoot = path.join(__dirname, "..")
  const candidates = [
    [path.join(repoRoot, ".opencode"), path.join(projectDir, ".opencode")],
    [repoRoot, projectDir],
  ]
  for (const [sourceDir, targetDir] of candidates) {
    if (!fs.existsSync(path.join(sourceDir, PEER_PACKAGE_JSON))) continue
    const target = path.join(targetDir, "node_modules")
    if (fs.existsSync(target)) continue
    fs.mkdirSync(targetDir, { recursive: true })
    fs.symlinkSync(path.join(sourceDir, "node_modules"), target, "junction")
  }
}

// The dist tree copied into the project, so the plugin file lives inside the
// worktree it opens: only then may hook scripts come from that worktree.
async function loadPluginInside(projectDir) {
  const source = path.join(__dirname, "..", ".opencode", "dist")
  const target = path.join(projectDir, ".opencode", "dist")
  fs.cpSync(source, target, { recursive: true })
  linkPluginDependencies(projectDir)
  return import(pathToFileURL(path.join(target, "plugins", "egc-hooks.js")).href)
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

  // The gate keeps its state per session under GATEGUARD_STATE_DIR; a run
  // must neither read the machine's live state nor leave its own behind.
  const gateStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "egc-opencode-gate-"))
  process.env.GATEGUARD_STATE_DIR = gateStateDir
  process.on("exit", () => fs.rmSync(gateStateDir, { recursive: true, force: true }))

  let EGCHooksPlugin
  try {
    ({ EGCHooksPlugin } = await loadPlugin())
  } catch (error) {
    // The build declines when the optional peer @opencode-ai/plugin is not
    // installed; that is an environment without OpenCode, not a failure of
    // the plugin under test.
    if (/SKIP: build-opencode/.test(error.message) || maybeSkipBaselineAbsent(error, "OpenCode plugin hook suite")) {
      console.log(`SKIP: OpenCode plugin hook suite (${error.message.split("\n")[0]})`)
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
      "tool.execute.before refuses a denied command and a protected write through the Guardian",
      async () => withTempProject([], async (projectDir) => {
        // The plugin runs from inside this worktree, so its scripts are trusted.
        const { EGCHooksPlugin: InsidePlugin } = await loadPluginInside(projectDir)
        stageWorktreeScripts(projectDir)
        const previous = { cli: process.env.EGC_GUARDIAN_CLI, disabled: process.env.EGC_DISABLED_HOOKS }
        process.env.EGC_GUARDIAN_CLI = path.join(__dirname, "fixtures", "fake-guardian-cli.js")
        process.env.EGC_DISABLED_HOOKS = "pre:gateguard:fact-force"
        try {
          const client = createClient()
          const $ = createFailingShell()
          const hooks = await InsidePlugin({ client, $, directory: projectDir })
          await assert.rejects(
            () => hooks["tool.execute.before"]({ tool: "bash", callID: "b1", args: { command: `${WIPE} /` } }),
            /Guardian/
          )
          await assert.rejects(
            () => hooks["tool.execute.before"]({ tool: "write", callID: "w1", args: { filePath: path.join(projectDir, ".ssh", "id_rsa"), content: "x" } }),
            /Guardian/
          )
          await hooks["tool.execute.before"]({ tool: "bash", callID: "b2", args: { command: "git status" } })
          await hooks["tool.execute.before"]({ tool: "write", callID: "w2", args: { filePath: path.join(projectDir, "notes.md"), content: "hi" } })
        } finally {
          if (previous.cli === undefined) delete process.env.EGC_GUARDIAN_CLI; else process.env.EGC_GUARDIAN_CLI = previous.cli
          if (previous.disabled === undefined) delete process.env.EGC_DISABLED_HOOKS; else process.env.EGC_DISABLED_HOOKS = previous.disabled
        }
      }),
    ],
    [
      "tool.execute.before never loads hook scripts from a project the plugin does not live in",
      async () => withTempProject([], async (projectDir) => {
        // The repository's own plugin opens a foreign project that ships a hook
        // script: the script must not even be required.
        const marker = path.join(projectDir, "loaded.marker")
        fs.mkdirSync(path.join(projectDir, "scripts", "hooks"), { recursive: true })
        fs.writeFileSync(path.join(projectDir, "scripts", "hooks", "pre-bash-guardian-validate.js"), `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')\nmodule.exports = { run: () => ({ exitCode: 0 }) }\n`)
        const client = createClient()
        const $ = createFailingShell()
        const previous = process.env.EGC_DISABLED_HOOKS
        process.env.EGC_DISABLED_HOOKS = "pre:gateguard:fact-force"
        try {
          const hooks = await EGCHooksPlugin({ client, $, directory: projectDir })
          await hooks["tool.execute.before"]({ tool: "bash", callID: "b1", args: { command: "git status" } })
        } finally {
          if (previous === undefined) delete process.env.EGC_DISABLED_HOOKS; else process.env.EGC_DISABLED_HOOKS = previous
        }
        assert.strictEqual(fs.existsSync(marker), false, "the foreign project's script was loaded")
      }),
    ],
    [
      "tool.execute.before loads hook scripts from the worktree only when the plugin lives inside it",
      async () => withTempProject([], async (projectDir) => {
        const marker = path.join(projectDir, "loaded.marker")
        fs.mkdirSync(path.join(projectDir, "scripts", "hooks"), { recursive: true })
        fs.writeFileSync(path.join(projectDir, "scripts", "hooks", "pre-bash-guardian-validate.js"), `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')\nmodule.exports = { run: () => ({ exitCode: 0 }) }\n`)
        const { EGCHooksPlugin: InsidePlugin } = await loadPluginInside(projectDir)
        const client = createClient()
        const $ = createFailingShell()
        const previous = process.env.EGC_DISABLED_HOOKS
        process.env.EGC_DISABLED_HOOKS = "pre:gateguard:fact-force"
        try {
          const hooks = await InsidePlugin({ client, $, directory: projectDir })
          await hooks["tool.execute.before"]({ tool: "bash", callID: "b1", args: { command: "git status" } })
        } finally {
          if (previous === undefined) delete process.env.EGC_DISABLED_HOOKS; else process.env.EGC_DISABLED_HOOKS = previous
        }
        assert.strictEqual(fs.existsSync(marker), true, "the worktree's script was not loaded")
      }),
    ],
    [
      "tool.execute.before blocks the first edit on a file with the GateGuard fact-forcing gate",
      async () => withTempProject([], async (projectDir) => {
        const { EGCHooksPlugin: InsidePlugin } = await loadPluginInside(projectDir)
        stageWorktreeScripts(projectDir)
        const targetFile = path.join(projectDir, "gated-file.ts")
        fs.writeFileSync(targetFile, "export const x = 1\n")

        const client = createClient()
        const $ = createFailingShell()
        const hooks = await InsidePlugin({ client, $, directory: projectDir })

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
        const { EGCHooksPlugin: InsidePlugin } = await loadPluginInside(projectDir)
        stageWorktreeScripts(projectDir)

        const client = createClient()
        const $ = createFailingShell()
        const hooks = await InsidePlugin({ client, $, directory: projectDir })

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
