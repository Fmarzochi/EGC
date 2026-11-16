'use strict';
// Compiles egc-memory TypeScript sources on the fly so root-suite tests can
// exercise the real src/ modules without a prior `npm run build`. TypeScript
// and the sqlite driver are resolved from wherever the active package manager
// actually placed them: root hoisting first, then the server's own
// node_modules. Anything missing means the caller should SKIP rather than
// crash: yarn's node-modules linker, unlike npm and bun, does not hoist the
// server's devDependencies to the root (see the discussion on PR #1271).
//
// Resolution alone is not enough. A package can resolve and still be
// unusable: the root typescript may be the 7.x native distribution, which
// exposes no compiler API, and a root sqlite3 without a built binding throws
// at require time. Both are selected by capability and by an actual load, so
// a candidate that resolves but cannot run falls through to the next one.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const serverDir = path.join(repoRoot, 'mcp', 'servers', 'egc-memory');
const resolvePaths = [repoRoot, serverDir];

function tryRequireFrom(id, dirs) {
  for (const dir of dirs) {
    try {
      return require(require.resolve(id, { paths: [dir] }));
    } catch {
      // Not installed here, or installed but unloadable. Either way the next
      // root is the only remaining chance.
    }
  }
  return null;
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

// The compiler API this suite needs is what transpileModule plus the module
// kind enum provide, and that is the whole contract: type checking belongs to
// the server's own tsc build. A version comparison would answer a different
// question, since typescript 7 is a native CLI whose package exports only
// version metadata, not a JavaScript compiler API.
const TYPESCRIPT_API = [
  ['transpileModule', ts => typeof ts.transpileModule === 'function'],
  ['ModuleKind.CommonJS', ts => Number.isInteger(ts.ModuleKind && ts.ModuleKind.CommonJS)]
];

// Names the parts of the compiler API a loaded module does not provide, or an
// empty array when it is usable.
function missingTypescriptApi(ts) {
  if (!ts || (typeof ts !== 'object' && typeof ts !== 'function')) return TYPESCRIPT_API.map(([name]) => name);
  return TYPESCRIPT_API.filter(([, present]) => !present(ts)).map(([name]) => name);
}

function typescriptVersion(ts) {
  return ts && typeof ts.version === 'string' ? ts.version : 'unknown version';
}

// Every place typescript was looked for, with what was found there, so a SKIP
// can name the toolchain instead of guessing at the cause. The roots are a
// parameter so a test can put a native package in front of a usable one.
function typescriptCandidates(paths = resolvePaths) {
  return paths.map(dir => {
    const candidate = { dir, resolved: null, loaded: null, error: null, missing: [] };
    try {
      candidate.resolved = require.resolve('typescript', { paths: [dir] });
    } catch {
      return candidate;
    }
    try {
      candidate.loaded = require(candidate.resolved);
    } catch (error) {
      candidate.error = error;
      return candidate;
    }
    candidate.missing = missingTypescriptApi(candidate.loaded);
    return candidate;
  });
}

// Returns the first candidate that loads and provides the compiler API.
function loadTypescriptDetail(paths = resolvePaths) {
  const candidates = typescriptCandidates(paths);
  const usable = candidates.find(candidate => candidate.loaded && candidate.missing.length === 0);
  return { ts: usable ? usable.loaded : null, candidates };
}

function loadTypescript() {
  return loadTypescriptDetail().ts;
}

function describeTypescriptCandidates(candidates = typescriptCandidates()) {
  const parts = candidates.map(candidate => {
    if (!candidate.resolved) return `not installed under ${candidate.dir}`;
    if (candidate.error) return `typescript ${typescriptVersion(candidate.loaded)} under ${candidate.dir} fails to load: ${firstLine(candidate.error.message)}`;
    const version = typescriptVersion(candidate.loaded);
    if (candidate.missing.length === 0) return `typescript ${version} under ${candidate.dir}`;
    return `typescript ${version} under ${candidate.dir} has no compiler API (missing ${candidate.missing.join(', ')})`;
  });
  return parts.join('; ');
}

// A sqlite3 that resolves is not necessarily a sqlite3 that runs: an install
// whose native build was skipped still resolves from the root and throws
// "Could not locate the bindings file" on require. Candidates are therefore
// judged by loading them, not by resolution.
function sqliteCandidates(paths = resolvePaths) {
  return paths.map(dir => {
    const candidate = { dir, resolved: null, loaded: null, error: null };
    try {
      candidate.resolved = require.resolve('sqlite3', { paths: [dir] });
    } catch {
      return candidate;
    }
    try {
      candidate.loaded = require(candidate.resolved);
    } catch (error) {
      candidate.error = error;
    }
    return candidate;
  });
}

function describeSqliteCandidates(candidates = sqliteCandidates()) {
  const parts = candidates.map(candidate => {
    if (!candidate.resolved) return `sqlite3 not installed under ${candidate.dir}`;
    if (candidate.error) return `sqlite3 under ${candidate.dir} fails to load: ${firstLine(candidate.error.message)}`;
    return `sqlite3 under ${candidate.dir}`;
  });
  return parts.join('; ');
}

function loadSqliteDriver(paths = resolvePaths) {
  const candidates = sqliteCandidates(paths);
  const usable = candidates.find(candidate => candidate.loaded);
  if (!usable) return null;
  const sqlite = tryRequireFrom('sqlite', [usable.dir, ...paths]);
  if (!sqlite) return null;
  return { sqlite3: usable.loaded, open: sqlite.open };
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

module.exports = {
  loadTypescript,
  loadTypescriptDetail,
  loadSqliteDriver,
  compileMemoryModule,
  serverDir,
  resolvePaths,
  missingTypescriptApi,
  typescriptCandidates,
  describeTypescriptCandidates,
  sqliteCandidates,
  describeSqliteCandidates
};
