'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDoctorReport } = require('../install-lifecycle');
const { getEGCDir, getKnownHarnessDirs } = require('../utils');

function samePath(a, b) {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (process.platform === 'win32') return resolvedA.toLowerCase() === resolvedB.toLowerCase();
  return resolvedA === resolvedB;
}

function findStateDbFragments(activeDbPath, canonicalDbPath, homeDir) {
  const fragments = [];
  const roots = [path.join(homeDir, '.egc'), ...getKnownHarnessDirs(homeDir)];
  for (const root of roots) {
    const candidate = path.join(root, 'egc', 'state.db');
    if (samePath(candidate, activeDbPath) || samePath(candidate, canonicalDbPath)) continue;
    try {
      const stat = fs.statSync(candidate);
      fragments.push({ path: candidate, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // Absent: not a fragment.
    }
  }
  return fragments;
}

function checkStateDb(homeDir) {
  const rootDir = getEGCDir();
  const dbPath = path.join(rootDir, 'egc', 'state.db');
  const canonicalDbPath = path.join(homeDir, '.egc', 'egc', 'state.db');
  const memoryDbPath = path.join(homeDir, '.egc', 'memory', 'state.db');

  const hasHarnessDb = fs.existsSync(dbPath);
  const hasMemoryDb = fs.existsSync(memoryDbPath);
  const fragments = findStateDbFragments(dbPath, canonicalDbPath, homeDir);
  const cliStoreMisplaced = hasHarnessDb
    && !samePath(dbPath, canonicalDbPath)
    && getKnownHarnessDirs(homeDir).some((harnessDir) => samePath(rootDir, harnessDir));
  const missing = !hasHarnessDb && !hasMemoryDb;

  if (hasHarnessDb && hasMemoryDb && !cliStoreMisplaced && fragments.length === 0) {
    return null;
  }
  return { missing, dbPath, memoryDbPath, hasHarnessDb, hasMemoryDb, cliStoreMisplaced, fragments };
}

function doctorReportOperation(params = {}) {
  const homeDir = params.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const repoRoot = params.repoRoot || path.join(__dirname, '../../..');
  const projectRoot = params.projectRoot || process.cwd();
  const targets = params.targets;

  const report = buildDoctorReport({
    repoRoot,
    homeDir,
    projectRoot,
    targets,
  });

  const stateDb = checkStateDb(homeDir);
  if (stateDb) {
    return {
      ...report,
      stateDb,
    };
  }

  return report;
}

module.exports = {
  checkStateDb,
  doctorReportOperation,
};
