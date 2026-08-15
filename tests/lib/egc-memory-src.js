'use strict';
// Compiles egc-memory TypeScript sources on the fly so root-suite tests can
// exercise the real src/ modules without a prior `npm run build`. TypeScript
// and the sqlite driver are resolved from wherever the active package manager
// actually placed them: root hoisting first, then the server's own
// node_modules. Anything missing means the caller should SKIP rather than
// crash: yarn's node-modules linker, unlike npm and bun, does not hoist the
// server's devDependencies to the root (see the discussion on PR #1271).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const serverDir = path.join(repoRoot, 'mcp', 'servers', 'egc-memory');
const resolvePaths = [repoRoot, serverDir];

function tryRequire(id) {
  try {
    return require(require.resolve(id, { paths: resolvePaths }));
  } catch {
    return null;
  }
}

function loadTypescript() {
  return tryRequire('typescript');
}

function loadSqliteDriver() {
  const sqlite3 = tryRequire('sqlite3');
  const sqlite = tryRequire('sqlite');
  if (!sqlite3 || !sqlite) return null;
  return { sqlite3, open: sqlite.open };
}

// Transpile-only, per file: type checking belongs to the server's own tsc
// build. Modules compiled here must therefore stay self-contained, importing
// nothing but node builtins.
function compileMemoryModule(name, ts) {
  const srcPath = path.join(serverDir, 'src', `${name}.ts`);
  const source = fs.readFileSync(srcPath, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: srcPath
  });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `egc-memory-src-${name}-`));
  const outPath = path.join(outDir, `${name}.js`);
  fs.writeFileSync(outPath, out.outputText);
  try {
    return require(outPath);
  } finally {
    // The module lives in the require cache from here on; the on-disk
    // artifact is disposable, and keeping it would strand one tmpdir per
    // compiled module per test run.
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { loadTypescript, loadSqliteDriver, compileMemoryModule, serverDir };
