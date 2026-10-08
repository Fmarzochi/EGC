'use strict';

/**
 * Status snapshot files (index.json and one file per session) for
 * scripts/loop-status.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isWindowsReservedBasename(value) {
  const basename = String(value).split('.')[0];
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename);
}

function sanitizeSnapshotName(value, fallback = 'session') {
  const raw = String(value || '').trim() || fallback;
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
  if (sanitized && sanitized.length <= 96 && !isWindowsReservedBasename(sanitized)) {
    return sanitized;
  }
  if (sanitized && isWindowsReservedBasename(sanitized)) {
    const firstDotIndex = sanitized.indexOf('.');
    const hashSuffix = hashString(raw).slice(0, 8);
    if (firstDotIndex === -1) {
      return `${sanitized}-${hashSuffix}`;
    }
    return `${sanitized.slice(0, firstDotIndex)}-${hashSuffix}${sanitized.slice(firstDotIndex)}`;
  }

  const prefix = sanitized ? sanitized.slice(0, 48).replace(/[._-]+$/g, '') : fallback; // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
  return `${prefix || fallback}-${hashString(raw).slice(0, 12)}`;
}

function atomicWriteJson(filePath, payload) {
  const data = JSON.stringify(payload, null, 2) + '\n';
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, data, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error(`[loop-status] WARNING: could not remove temporary snapshot file ${tempPath}: ${cleanupError.message}`);
      }
    }
    throw error;
  }
}

function getSnapshotPath(outputDir, session, usedNames) {
  const baseName = sanitizeSnapshotName(session.sessionId);
  const hashSuffix = hashString(session.transcriptPath || session.sessionId).slice(0, 8);
  let attempt = 0;

  while (attempt < 1000) {
    let suffix;
    if (attempt === 0) {
      suffix = '';
    } else {
      const innerSuffix = attempt === 1 ? '' : `-${attempt}`;
      suffix = `-${hashSuffix}${innerSuffix}`;
    }
    const fileName = `${baseName}${suffix}.json`;
    if (!usedNames.has(fileName)) {
      usedNames.add(fileName);
      return path.join(outputDir, fileName);
    }
    attempt += 1;
  }

  throw new Error(`Could not allocate a snapshot filename for session ${session.sessionId}`);
}

function writeStatusSnapshots(payload, writeDir) {
  if (!writeDir) {
    return null;
  }

  const outputDir = path.resolve(writeDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const usedNames = new Set(['index.json']);
  const sessions = payload.sessions.map(session => {
    const snapshotPath = getSnapshotPath(outputDir, session, usedNames);
    atomicWriteJson(snapshotPath, {
      generatedAt: payload.generatedAt,
      schemaVersion: 'egc.loop-status.session.v1',
      session,
    });

    return {
      lastEventAt: session.lastEventAt,
      sessionId: session.sessionId,
      signalTypes: session.signals.map(signal => signal.type),
      snapshotPath,
      state: session.state,
      transcriptPath: session.transcriptPath,
    };
  });

  const indexPath = path.join(outputDir, 'index.json');
  atomicWriteJson(indexPath, {
    errors: payload.errors,
    generatedAt: payload.generatedAt,
    schemaVersion: 'egc.loop-status.index.v1',
    sessionCount: payload.sessions.length,
    sessions,
    source: payload.source,
  });

  return {
    indexPath,
    sessionCount: payload.sessions.length,
  };
}

function tryWriteStatusSnapshots(payload, options) {
  if (!options.writeDir) {
    return null;
  }

  try {
    return writeStatusSnapshots(payload, options.writeDir);
  } catch (error) {
    console.error(`[loop-status] WARNING: could not write status snapshots: ${error.message}`);
    return null;
  }
}

module.exports = {
  tryWriteStatusSnapshots,
  writeStatusSnapshots,
};
