#!/usr/bin/env node
'use strict';

// Claude Code SessionStart hook. Prints the EGC state file for the current
// project so the session always starts with persistent memory loaded.
// Read-only by design: it never executes project code and never fails the
// session. Missing or unreadable state exits silently with code 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

    if (!fs.existsSync(stateFile)) {
      process.exit(0);
    }

    const content = fs.readFileSync(stateFile, 'utf8');
    if (!content.trim()) {
      process.exit(0);
    }

    process.stdout.write(
      'EGC persistent memory for this project (restored automatically):\n\n'
      + content
    );
  } catch (_error) {
    // Never break session startup because of memory loading.
  }

  process.exit(0);
}

main();
