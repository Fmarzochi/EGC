const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');
/**
 * Tests for the npm publish surface contract.
 *
 * The contract is COVERAGE, not equality: every source path the install
 * manifests reference must ship in the npm package (the package.json
 * "files" whitelist). A path that installs fine from a dev checkout but is
 * missing from the published tarball silently vanishes for every registry
 * install and later surfaces as doctor missing-source-files errors on
 * machines that did install it. KNOWN_UNPACKAGED documents the deliberate
 * exceptions.
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

function runTest(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    return true
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
    return false
  }
}

const repoRoot = path.join(__dirname, "..", "..")
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
)
const modules = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "manifests", "install-modules.json"), "utf8")
).modules

// Manifest sources that deliberately do NOT ship in the npm package today.
// All three are local memory-propagation targets: packing them straight from
// a working tree would risk publishing populated memory, so adding them to
// "files" is a maintainer decision, not a mechanical fix. Registry installs
// silently skip them (materializeScaffoldOperation drops missing sources).
// Shrink this list, never grow it.
const KNOWN_UNPACKAGED = new Set(["AGENTS.md", ".cursor", ".gemini"])

function normalizePublishPath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/$/, "")
}

const packagedPrefixes = packageJson.files
  .filter((entry) => !entry.startsWith("!"))
  .map(normalizePublishPath)

function isPackaged(relativePath) {
  return packagedPrefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  )
}

function main() {
  console.log("\n=== Testing npm publish surface ===\n")

  let passed = 0
  let failed = 0

  const tests = [
    ["every install-manifest source ships in the npm package files whitelist", () => {
      for (const module of modules) {
        for (const rawPath of module.paths || []) {
          const sourcePath = normalizePublishPath(rawPath)
          if (KNOWN_UNPACKAGED.has(sourcePath)) {
            assert.ok(
              !isPackaged(sourcePath),
              `${sourcePath} is packaged now: remove it from KNOWN_UNPACKAGED`
            )
            continue
          }
          assert.ok(
            fs.existsSync(path.join(repoRoot, sourcePath)),
            `manifest module ${module.id} references a source missing from the repo: ${sourcePath}`
          )
          assert.ok(
            isPackaged(sourcePath),
            `manifest module ${module.id} references a source the npm package does not ship: ${sourcePath}`
          )
        }
      }
    }],
    ["package files whitelist keeps the generated-artifact negations", () => {
      for (const negation of ["!**/__pycache__", "!**/*.pyc", "!**/.DS_Store"]) {
        assert.ok(
          packageJson.files.includes(negation),
          `package.json files must keep ${negation}`
        )
      }
    }],
    ["npm pack ships manifest sources and no generated artifacts", () => {
      // --ignore-scripts: the contract under test is the files whitelist,
      // not the prepack pipeline (which builds the MCP servers and refuses
      // to pack while local propagation files hold populated memory).
      const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: repoRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 64 * 1024 * 1024,
      })
      assert.strictEqual(result.status, 0, result.error?.message || result.stderr)

      const packOutput = JSON.parse(result.stdout)
      const packagedPaths = packOutput[0]?.files?.map((file) => file.path) ?? []
      const packagedSet = new Set(packagedPaths)

      for (const requiredPath of [
        ".codex/config.toml",
        ".trae/rules/egc-context.md",
        "scripts/hooks/scrubber-cli.js",
        "scripts/lib/scrubber/engine.js",
        "skills/security/content-scrubber/SKILL.md",
        "manifests/install-modules.json",
        ".gemini-plugin/plugin.json",
        "schemas/install-state.schema.json",
      ]) {
        assert.ok(
          packagedSet.has(requiredPath),
          `npm pack should include ${requiredPath}`
        )
      }

      for (const excludedPath of [
        "AGENTS.md",
        ".cursor/rules/egc-context.mdc",
        "skills/general_part2/skill-comply/.gitignore",
      ]) {
        assert.ok(
          !packagedSet.has(excludedPath),
          `npm pack should not include ${excludedPath}`
        )
      }

      const artifacts = packagedPaths.filter((packagedPath) => (
        packagedPath.includes("__pycache__")
        || packagedPath.endsWith(".pyc")
        || packagedPath.endsWith(".DS_Store")
      ))
      assert.deepStrictEqual(artifacts, [], "generated artifacts must never ship in the package")
    }],
  ]

  for (const [name, fn] of tests) {
    if (runTest(name, fn)) {
      passed += 1
    } else {
      failed += 1
    }
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
