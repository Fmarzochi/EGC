'use strict';

// JS mirror of mcp/servers/egc-memory/src/global-state.ts for session hooks,
// which cannot require the compiled server build. Keep both in sync.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GLOBAL_APPENDIX_SECTIONS = [
  { heading: 'Preferences', cap: 5 },
  { heading: 'Active Decisions', cap: 5 },
  { heading: 'Do Not Repeat', cap: 5 },
];

function globalStateFilePath() {
  return path.join(os.homedir(), '.egc', 'global', 'state.md');
}

function parseStateDoc(content) {
  const result = {};
  let currentSection = '';
  for (const line of content.split('\n')) {
    const h2 = /^## (.+)/.exec(line);
    if (h2) {
      currentSection = h2[1].trim();
      result[currentSection] = result[currentSection] || [];
      continue;
    }
    if (currentSection && line.trim() && !line.startsWith('#')) {
      const arr = result[currentSection];
      if (Array.isArray(arr)) arr.push(line.replace(/^- /, '').trim());
      else result[currentSection] = line.trim();
    }
  }
  return result;
}

function buildGlobalAppendix(globalDoc, projectContent) {
  const projectLines = new Set(
    projectContent.split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean)
  );
  const parts = [];
  for (const { heading, cap } of GLOBAL_APPENDIX_SECTIONS) {
    const entries = globalDoc[heading];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(e => e.trim() && !projectLines.has(e.trim())).slice(0, cap);
    if (kept.length === 0) continue;
    parts.push(`### ${heading}`, ...kept.map(e => `- ${e}`), '');
  }
  if (parts.length === 0) return null;
  return ['', '## Global Memory (all projects)', '', ...parts].join('\n').trimEnd();
}

// stateCrypto is optional: without it an encrypted global file is skipped
// instead of leaking ciphertext into the session.
function readGlobalAppendix(projectContent, stateCrypto) {
  try {
    const file = globalStateFilePath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    const encrypted = stateCrypto
      ? stateCrypto.isEncryptedBuffer(raw)
      : raw.subarray(0, 5).toString('utf8') === 'EGC1:';
    let content;
    if (encrypted) {
      if (!stateCrypto) return null;
      content = stateCrypto.decryptStateBuffer(raw);
    } else {
      content = raw.toString('utf8');
    }
    if (!content || !content.trim()) return null;
    return buildGlobalAppendix(parseStateDoc(content), projectContent);
  } catch (_) { // NOSONAR: global memory is additive; any failure must not break the session
    return null;
  }
}

module.exports = {
  GLOBAL_APPENDIX_SECTIONS,
  globalStateFilePath,
  parseStateDoc,
  buildGlobalAppendix,
  readGlobalAppendix,
};
