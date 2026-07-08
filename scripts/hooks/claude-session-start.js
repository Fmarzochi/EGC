#!/usr/bin/env node
'use strict';

// Claude Code SessionStart hook. Prints the EGC state file for the current
// project so the session always starts with persistent memory loaded, then
// emits a stack briefing with relevant agents for the detected project type.
// Read-only by design: it never executes project code and never fails the
// session. Missing or unreadable state exits silently with code 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
// Optional libs: minimal installations may lack them, so a failed require
// resolves to null and the dependent feature is skipped instead of failing
// session startup. Run `egc repair` to restore missing libs.
function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const propagateStateLib = tryRequire('../lib/propagate-state');
const propagateStateContent = propagateStateLib ? propagateStateLib.propagateStateContent : null;
const projectDetect = tryRequire('../lib/project-detect');
const branchState = tryRequire('../lib/branch-state');
const autoConsolidate = tryRequire('../lib/auto-consolidate');
const stateCrypto = tryRequire('../lib/state-crypto');

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // No stdin payload or invalid JSON: fall back to environment values.
  }
  return {};
}

function resolveProjectPath(input) {
  if (typeof input.cwd === 'string' && input.cwd.length > 0) {
    return input.cwd;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

// Fallback slug for minimal installs without branch-state. Uses the same
// double-hyphen join as branch-state.projectSlug; the previous single-hyphen
// form never matched the files the memory server actually writes.
function projectSlug(projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function parseFrontmatterValue(val) {
  if (!val.startsWith('[')) return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return val;
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    result[key] = parseFrontmatterValue(line.slice(colonIdx + 1).trim());
  }
  return result;
}

function agentMatchesStack(agentStack, languages, frameworks, knownFrameworkNames) {
  if (agentStack.includes('*')) return 'generic';

  const agentFrameworks = agentStack.filter(s => knownFrameworkNames.has(s));
  const agentLanguages = agentStack.filter(s => !knownFrameworkNames.has(s));

  if (agentFrameworks.length > 0) {
    const allFrameworksPresent = agentFrameworks.every(f => frameworks.includes(f));
    const languageMatches = agentLanguages.length === 0 || agentLanguages.some(l => languages.includes(l));
    return allFrameworksPresent && languageMatches ? 'specific' : 'none';
  }

  return agentLanguages.some(l => languages.includes(l)) ? 'specific' : 'none';
}

function readAgentFiles(agentsDir) {
  try {
    return fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch (_) {
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
      const fm = parseFrontmatter(content);
      if (!fm.name) continue;
      const agentStack = Array.isArray(fm.stack) ? fm.stack : ['*'];
      const match = agentMatchesStack(agentStack, languages, frameworks, knownFrameworkNames);
      if (match === 'generic') generic.push(fm.name);
      else if (match === 'specific') stackSpecific.push(fm.name);
    } catch (_) {
      // skip unreadable agent
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
    const alwaysUse = generic.filter(n => n === 'code-reviewer')
      .concat(generic.filter(n => n !== 'code-reviewer').slice(0, 2));
    if (alwaysUse.length > 0) {
      lines.push(`Always use: ${alwaysUse.join(', ')}`);
    }
  }

  lines.push('Skill: coding-standards (cyclomatic complexity) - apply to all code written this session');
  lines.push('===');
  lines.push('');
  return lines;
}

function emitStackBriefing(projectPath) {
  if (!projectDetect) return;

  const detected = projectDetect.detectProjectType(projectPath);
  const { languages, frameworks } = detected;
  if (languages.length === 0 && frameworks.length === 0) return;

  const FRAMEWORK_RULES = projectDetect.FRAMEWORK_RULES || [];
  const knownFrameworkNames = new Set(FRAMEWORK_RULES.map(r => r.framework));
  const stack = [...new Set([...frameworks, ...languages])];
  const { stackSpecific, generic, missing } = loadRelevantAgents(languages, frameworks, knownFrameworkNames);

  process.stdout.write(buildBriefingLines(stack, stackSpecific, generic, missing).join('\n'));
}

// Consolidation must never block session startup: on any failure the
// state file is simply loaded as-is.
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

// Encrypted state (EGC1 payloads written by the memory server) is decrypted
// via state-crypto; without that lib the hook stays silent instead of
// printing or propagating ciphertext. Consolidation only runs on plaintext:
// the memory server owns maintenance of encrypted files.
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
    if (result && result.consolidated) raw = fs.readFileSync(stateFile);
  }
  return raw.toString('utf8');
}

function loadAndPrintState(projectPath) {
  const stateFile = resolveStateFile(projectPath);
  if (!stateFile) return;

  const content = readPlaintextState(stateFile);
  if (content === null || !content.trim()) return;

  if (propagateStateContent) {
    try {
      propagateStateContent(projectPath, content);
    } catch (_) {
      // Propagation is best-effort; never block session startup.
    }
  }

  process.stdout.write('EGC persistent memory for this project (restored automatically):\n\n' + content);
}

function main() {
  try {
    const input = readStdinJson();
    const projectPath = resolveProjectPath(input);
    loadAndPrintState(projectPath);
    emitStackBriefing(projectPath);
  } catch (_error) {
    // Never break session startup because of memory loading.
  }

  process.exit(0);
}

main();
