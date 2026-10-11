/**
 * Shared formatter resolution utilities with caching.
 *
 * Extracts project-root discovery, formatter detection, and binary
 * resolution into a single module so that post-edit-format.js and
 * quality-gate.js avoid duplicating work and filesystem lookups.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── Caches (per-process, cleared on next hook invocation) ───────────
const projectRootCache = new Map();
const formatterCache = new Map();
const binCache = new Map();

// ── Config file lists (single source of truth) ─────────────────────

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs'
];

const PROJECT_ROOT_MARKERS = ['package.json', ...BIOME_CONFIGS, ...PRETTIER_CONFIGS];

// ── Windows .cmd shim mapping ───────────────────────────────────────
const WIN_CMD_SHIMS = { npx: 'npx.cmd', pnpm: 'pnpm.cmd', yarn: 'yarn.cmd', bunx: 'bunx.cmd' };

// ── Formatter → package name mapping ────────────────────────────────
const FORMATTER_PACKAGES = {
  biome: { binName: 'biome', pkgName: '@biomejs/biome' },
  prettier: { binName: 'prettier', pkgName: 'prettier' }
};

// ── Public helpers ──────────────────────────────────────────────────

/**
 * Walk up from `startDir` until a directory containing a known project
 * root marker (package.json or formatter config) is found.
 * Returns `startDir` as fallback when no marker exists above it.
 *
 * @param {string} startDir - Absolute directory path to start from
 * @returns {string} Absolute path to the project root
 */
function findProjectRoot(startDir) {
  if (projectRootCache.has(startDir)) return projectRootCache.get(startDir);

  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) {
        projectRootCache.set(startDir, dir);
        return dir;
      }
    }
    dir = path.dirname(dir);
  }

  projectRootCache.set(startDir, startDir);
  return startDir;
}

/**
 * Detect the formatter configured in the project.
 * Biome takes priority over Prettier.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {'biome' | 'prettier' | null}
 */
function detectFormatter(projectRoot) {
  if (formatterCache.has(projectRoot)) return formatterCache.get(projectRoot);

  for (const cfg of BIOME_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, cfg))) {
      formatterCache.set(projectRoot, 'biome');
      return 'biome';
    }
  }

  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if ('prettier' in pkg) {
        formatterCache.set(projectRoot, 'prettier');
        return 'prettier';
      }
    }
  } catch {
    // Malformed package.json: continue to file-based detection
  }

  for (const cfg of PRETTIER_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, cfg))) {
      formatterCache.set(projectRoot, 'prettier');
      return 'prettier';
    }
  }

  formatterCache.set(projectRoot, null);
  return null;
}

/**
 * Resolve the runner binary and prefix args for the configured package
 * manager (respects the EGC_PACKAGE_MANAGER env, its old GEMINI_PACKAGE_MANAGER name, and project config).
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ bin: string, prefix: string[] }}
 */
function getRunnerFromPackageManager(projectRoot) {
  const isWin = process.platform === 'win32';
  const { getPackageManager } = require('./package-manager');
  const pm = getPackageManager({ projectDir: projectRoot });
  const execCmd = pm?.config?.execCmd || 'npx';
  const [rawBin = 'npx', ...prefix] = execCmd.split(/\s+/).filter(Boolean);
  const bin = isWin ? WIN_CMD_SHIMS[rawBin] || rawBin : rawBin;
  return { bin, prefix };
}

// The JS entry of a locally installed formatter, read from the bin field of
// its package.json. Run under this Node it needs no shell, so on Windows a
// file path with spaces or parentheses reaches the formatter as one argument.
function resolveFormatterEntry(projectRoot, formatter) {
  const pkg = FORMATTER_PACKAGES[formatter];
  if (!pkg) return null;
  const pkgDir = path.join(projectRoot, 'node_modules', ...pkg.pkgName.split('/'));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[pkg.binName];
  if (typeof bin !== 'string' || bin === '') return null;
  const entry = path.join(pkgDir, bin);
  return fs.existsSync(entry) ? entry : null;
}

/**
 * Resolve the formatter binary, preferring the local node_modules/.bin
 * installation over the package manager exec command to avoid
 * package-resolution overhead.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {'biome' | 'prettier'} formatter - Detected formatter name
 * @returns {{ bin: string, prefix: string[], entry?: string | null } | null}
 *   `bin`    – executable path (absolute local path or runner binary)
 *   `prefix` – extra args to prepend (e.g. ['@biomejs/biome'] when using npx)
 *   `entry`  – JS entry of the local package when it has one, for a run under this Node
 */
function resolveFormatterBin(projectRoot, formatter) {
  const cacheKey = `${projectRoot}:${formatter}`;
  if (binCache.has(cacheKey)) return binCache.get(cacheKey);

  const pkg = FORMATTER_PACKAGES[formatter];
  if (!pkg) {
    binCache.set(cacheKey, null);
    return null;
  }

  const isWin = process.platform === 'win32';
  const localBin = path.join(projectRoot, 'node_modules', '.bin', isWin ? `${pkg.binName}.cmd` : pkg.binName);

  if (fs.existsSync(localBin)) {
    const result = { bin: localBin, prefix: [], entry: resolveFormatterEntry(projectRoot, formatter) };
    binCache.set(cacheKey, result);
    return result;
  }

  const runner = getRunnerFromPackageManager(projectRoot);
  const result = { bin: runner.bin, prefix: [...runner.prefix, pkg.pkgName] };
  binCache.set(cacheKey, result);
  return result;
}

/**
 * Clear all caches. Useful for testing.
 */
function clearCaches() {
  projectRootCache.clear();
  formatterCache.clear();
  binCache.clear();
}

module.exports = {
  findProjectRoot,
  detectFormatter,
  resolveFormatterBin,
  resolveFormatterEntry,
  clearCaches
};
