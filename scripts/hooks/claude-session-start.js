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
const { propagateStateContent } = require('../lib/propagate-state');

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

function projectSlug(projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (val.startsWith('[')) {
      try { result[key] = JSON.parse(val); } catch (_) { result[key] = val; }
    } else {
      result[key] = val;
    }
  }
  return result;
}

function loadRelevantAgents(languages, frameworks, knownFrameworkNames) {
  const agentsDir = path.join(__dirname, '..', '..', 'agents');
  if (!fs.existsSync(agentsDir)) return { stackSpecific: [], generic: [], missing: true };

  const stackSpecific = [];
  const generic = [];

  let files;
  try {
    files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch (_) {
    return { stackSpecific: [], generic: [], missing: false };
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm.name) continue;
      const agentStack = Array.isArray(fm.stack) ? fm.stack : ['*'];

      if (agentStack.includes('*')) {
        generic.push(fm.name);
        continue;
      }

      // Split agent's stack entries into frameworks and languages.
      const agentFrameworks = agentStack.filter(s => knownFrameworkNames.has(s));
      const agentLanguages = agentStack.filter(s => !knownFrameworkNames.has(s));

      let matches = false;
      if (agentFrameworks.length > 0) {
        // Framework-specific agent: requires all declared frameworks to be detected.
        matches = agentFrameworks.every(f => frameworks.includes(f)) &&
          (agentLanguages.length === 0 || agentLanguages.some(l => languages.includes(l)));
      } else {
        // Language-only agent: OR semantics -- matches if any language is detected.
        matches = agentLanguages.some(l => languages.includes(l));
      }

      if (matches) stackSpecific.push(fm.name);
    } catch (_) {
      // skip unreadable agent
    }
  }

  return { stackSpecific, generic, missing: false };
}

function emitStackBriefing(projectPath) {
  let detected;
  let FRAMEWORK_RULES;
  try {
    const projectDetect = require('../lib/project-detect');
    detected = projectDetect.detectProjectType(projectPath);
    FRAMEWORK_RULES = projectDetect.FRAMEWORK_RULES || [];
  } catch (_) {
    return;
  }

  const { languages, frameworks } = detected;
  if (languages.length === 0 && frameworks.length === 0) return;

  const knownFrameworkNames = new Set((FRAMEWORK_RULES).map(r => r.framework));
  const stack = [...new Set([...frameworks, ...languages])];
  const { stackSpecific, generic, missing } = loadRelevantAgents(languages, frameworks, knownFrameworkNames);

  const lines = ['', '=== EGC Stack Briefing ==='];
  lines.push(`Stack: ${stack.slice(0, 6).join(', ')}`);

  if (missing) {
    lines.push('Agents: none installed -- run: egc install --profile full');
  } else {
    if (stackSpecific.length > 0) {
      lines.push(`Stack agents: ${stackSpecific.slice(0, 6).join(', ')}`);
    }
    const alwaysUse = generic.filter(n => n === 'code-reviewer').concat(
      generic.filter(n => n !== 'code-reviewer').slice(0, 2)
    );
    if (alwaysUse.length > 0) {
      lines.push(`Always use: ${alwaysUse.join(', ')}`);
    }
  }

  lines.push('Skill: coding-standards (cyclomatic complexity) -- apply to all code written this session');
  lines.push('===');
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

function main() {
  try {
    const input = readStdinJson();
    const projectPath = resolveProjectPath(input);
    const stateFile = path.join(
      os.homedir(),
      '.egc',
      'state',
      `${projectSlug(projectPath)}.md`
    );

    if (fs.existsSync(stateFile)) {
      const content = fs.readFileSync(stateFile, 'utf8');
      if (content.trim()) {
        try {
          propagateStateContent(projectPath, content);
        } catch (_) {
          // Propagation is best-effort; never block session startup.
        }

        process.stdout.write(
          'EGC persistent memory for this project (restored automatically):\n\n'
          + content
        );
      }
    }

    emitStackBriefing(projectPath);
  } catch (_error) {
    // Never break session startup because of memory loading.
  }

  process.exit(0);
}

main();
