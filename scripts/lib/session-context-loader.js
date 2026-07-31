'use strict';

// Host-neutral EGC session context loader. It owns only the shared work of
// locating, decrypting, propagating, and formatting persistent project state
// plus the stack briefing. Host adapters remain responsible for reading their
// event payloads, injecting the returned context, and reporting telemetry.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Minimal installations may lack optional helpers. A failed require disables
// only the dependent feature instead of breaking session startup.
function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const propagateStateLib = tryRequire('./propagate-state');
const propagateStateContent = propagateStateLib ? propagateStateLib.propagateStateContent : null;
const projectDetect = tryRequire('./project-detect');
const branchState = tryRequire('./branch-state');
const autoConsolidate = tryRequire('./auto-consolidate');
const stateCrypto = tryRequire('./state-crypto');
const globalState = tryRequire('./global-state');

function normalizeHost(host) {
  return typeof host === 'string' && host.trim() ? host.trim() : null;
}

// Fallback slug for minimal installs without branch-state. Uses the same
// double-hyphen join as branch-state.projectSlug.
function projectSlug(projectPath) {
  const parts = projectPath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function parseFrontmatterValue(value) {
  if (!value.startsWith('[')) return value;
  try {
    return JSON.parse(value);
  } catch (_) { // NOSONAR: non-JSON metadata intentionally remains a string
    return value;
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    result[key] = parseFrontmatterValue(line.slice(colonIndex + 1).trim());
  }
  return result;
}

function agentMatchesStack(agentStack, languages, frameworks, knownFrameworkNames) {
  if (agentStack.includes('*')) return 'generic';

  const agentFrameworks = agentStack.filter(value => knownFrameworkNames.has(value));
  const agentLanguages = agentStack.filter(value => !knownFrameworkNames.has(value));

  if (agentFrameworks.length > 0) {
    const allFrameworksPresent = agentFrameworks.every(value => frameworks.includes(value));
    const languageMatches = agentLanguages.length === 0
      || agentLanguages.some(value => languages.includes(value));
    return allFrameworksPresent && languageMatches ? 'specific' : 'none';
  }

  return agentLanguages.some(value => languages.includes(value)) ? 'specific' : 'none';
}

function readAgentFiles(agentsDir) {
  try {
    return fs.readdirSync(agentsDir).filter(file => file.endsWith('.md'));
  } catch (_) { // NOSONAR: a missing agents directory is a supported state
    return null;
  }
}

function loadRelevantAgents(languages, frameworks, knownFrameworkNames) {
  const agentsDir = process.env.EGC_AGENTS_DIR || path.join(__dirname, '..', '..', 'agents');
  if (!fs.existsSync(agentsDir)) return { stackSpecific: [], generic: [], missing: true };

  const files = readAgentFiles(agentsDir);
  if (!files) return { stackSpecific: [], generic: [], missing: false };

  const stackSpecific = [];
  const generic = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter.name) continue;
      const agentStack = Array.isArray(frontmatter.stack) ? frontmatter.stack : ['*'];
      const match = agentMatchesStack(agentStack, languages, frameworks, knownFrameworkNames);
      if (match === 'generic') generic.push(frontmatter.name);
      else if (match === 'specific') stackSpecific.push(frontmatter.name);
    } catch (_) { // NOSONAR: one unreadable agent must not block restoration
      // Skip unreadable agent files.
    }
  }

  return { stackSpecific, generic, missing: false };
}

function buildBriefingLines(stack, stackSpecific, generic, missing) {
  const lines = ['', '=== EGC Stack Briefing ==='];
  lines.push(`Stack: ${stack.slice(0, 6).join(', ')}`);

  if (missing) {
    lines.push('Agents: none installed - run: egc install --profile full');
  } else {
    if (stackSpecific.length > 0) {
      lines.push(`Stack agents: ${stackSpecific.slice(0, 6).join(', ')}`);
    }
    const alwaysUse = generic.filter(name => name === 'code-reviewer')
      .concat(generic.filter(name => name !== 'code-reviewer').slice(0, 2));
    if (alwaysUse.length > 0) {
      lines.push(`Always use: ${alwaysUse.join(', ')}`);
    }
  }

  lines.push(
    'Skill: coding-standards (cyclomatic complexity) - apply to all code written this session',
    '===',
    ''
  );
  return lines;
}

function buildStackBriefing(projectPath) {
  if (!projectDetect) return '';

  const detected = projectDetect.detectProjectType(projectPath);
  const { languages, frameworks } = detected;
  if (languages.length === 0 && frameworks.length === 0) return '';

  const frameworkRules = projectDetect.FRAMEWORK_RULES || [];
  const knownFrameworkNames = new Set(frameworkRules.map(rule => rule.framework));
  const stack = [...new Set([...frameworks, ...languages])];
  const { stackSpecific, generic, missing } = loadRelevantAgents(
    languages,
    frameworks,
    knownFrameworkNames
  );

  return buildBriefingLines(stack, stackSpecific, generic, missing).join('\n');
}

// Consolidation must never block session startup: on any failure the state
// file is loaded as-is.
function consolidateBestEffort(stateFile) {
  try {
    return autoConsolidate.autoConsolidateStateFile(stateFile);
  } catch {
    return null;
  }
}

function resolveStateFile(projectPath) {
  if (branchState) {
    const stateDir = branchState.getStateDir();
    const branch = branchState.detectBranch(projectPath);
    const resolved = branchState.resolveStateRead(stateDir, projectPath, branch);
    return resolved.source === 'none' ? null : resolved.filePath;
  }

  const flatFile = path.join(os.homedir(), '.egc', 'state', `${projectSlug(projectPath)}.md`);
  return fs.existsSync(flatFile) ? flatFile : null;
}

// Encrypted state is decrypted when state-crypto is available. Without it,
// encrypted content stays silent instead of leaking ciphertext.
function readPlaintextState(stateFile) {
  let raw = fs.readFileSync(stateFile);

  const encrypted = stateCrypto
    ? stateCrypto.isEncryptedBuffer(raw)
    : raw.subarray(0, 5).toString('utf8') === 'EGC1:';
  if (encrypted) {
    return stateCrypto ? stateCrypto.decryptStateBuffer(raw) : null;
  }

  if (autoConsolidate) {
    const result = consolidateBestEffort(stateFile);
    if (result?.consolidated) raw = fs.readFileSync(stateFile);
  }
  return raw.toString('utf8');
}

function buildPersistentStateContext(projectPath) {
  const stateFile = resolveStateFile(projectPath);
  let content = null;
  if (stateFile) {
    content = readPlaintextState(stateFile);
    if (content !== null && !content.trim()) content = null;
  }

  if (content && propagateStateContent) {
    try {
      propagateStateContent(projectPath, content);
    } catch (_) { // NOSONAR: propagation is best-effort
      // Never block restoration because a mirror could not be updated.
    }
  }

  const appendix = globalState ? globalState.readGlobalAppendix(content || '', stateCrypto) : null;
  if (!content && !appendix) return '';

  const header = 'EGC persistent memory for this project (restored automatically):\n\n';
  return header + (content || '') + (appendix ? `\n${appendix}\n` : '');
}

function loadSessionContext({ projectPath, host } = {}) {
  const normalizedHost = normalizeHost(host);
  if (typeof projectPath !== 'string' || !projectPath) {
    return { host: normalizedHost, context: '' };
  }

  try {
    const persistentState = buildPersistentStateContext(projectPath);
    const stackBriefing = buildStackBriefing(projectPath);
    return {
      host: normalizedHost,
      context: persistentState + stackBriefing,
    };
  } catch (_) { // NOSONAR: session restoration is fail-open by contract
    return { host: normalizedHost, context: '' };
  }
}

module.exports = {
  loadSessionContext,
};
