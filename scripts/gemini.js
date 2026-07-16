#!/usr/bin/env node
/**
 * EGC Minimal Bridge
 * 
 * Reunifies the Node.js CLI with the Python LLM backend.
 * Routes 'prompt' / '-p' calls to src/llm/cli/prompt.py.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

function main() {
  const pluginRoot = path.resolve(__dirname, '..');
  const venvPath = path.join(pluginRoot, '.venv');
  
  // Local .venv resolution (MANDATORY per directive)
  const pythonBin = os.platform() === 'win32' 
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python3');

  const args = process.argv.slice(2);
  
  // Session propagation (MANDATORY per directive)
  const env = { ...process.env };
  const sessionId = env.EGC_SESSION_ID || env.ECC_SESSION_ID || `egc-session-${Date.now()}`;
  env.EGC_SESSION_ID = sessionId;
  env.ECC_SESSION_ID = sessionId;

  // Distinguish between plugin root (for assets/code) and project root (for workspace)
  env.EGC_PLUGIN_ROOT = pluginRoot;
  env.ECC_PLUGIN_ROOT = pluginRoot;
  if (!env.PROJECT_ROOT) {
    env.PROJECT_ROOT = process.cwd();
  }
  
  env.PYTHONPATH = path.join(pluginRoot, 'src');

  const result = spawnSync(pythonBin, ['-m', 'llm.cli.prompt', ...args], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Error: Failed to spawn Python bridge: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status || 0);
}

main();
