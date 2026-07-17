#!/usr/bin/env node
'use strict';

/**
 * session-start-bootstrap.js
 *
 * Bootstrap loader for the EGC SessionStart hook.
 *
 * Problem this solves: the previous approach embedded this logic as an inline
 * `node -e "..."` string inside hooks.json. Characters like `!` (used in
 * `!org.isDirectory()`) can trigger bash history expansion or other shell
 * interpretation issues depending on the environment, causing
 * "SessionStart:startup hook error" to appear in the Gemini Code CLI header.
 *
 * By extracting to a standalone file, the shell never sees the JavaScript
 * source and the `!` characters are safe. Behaviour is otherwise identical.
 *
 * How it works:
 *   1. Reads the raw JSON event from stdin (passed by Gemini Code).
 *   2. Resolves the EGC plugin root directory (via GEMINI_PLUGIN_ROOT env var
 *      or a set of well-known fallback paths).
 *   3. Delegates to `scripts/hooks/run-with-flags.js` with the `session:start`
 *      event, which applies hook-profile gating and then runs session-start.js.
 *   4. Passes stdout/stderr through and forwards the child exit code.
 *   5. If the plugin root cannot be found, emits a warning and passes stdin
 *      through unchanged so Gemini Code can continue normally.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CURRENT_PLUGIN_SLUG = 'egc';
const LEGACY_PLUGIN_SLUG = 'everything-gemini';
const KNOWN_PLUGIN_PATHS = [
  [CURRENT_PLUGIN_SLUG],
  [`${CURRENT_PLUGIN_SLUG}@${CURRENT_PLUGIN_SLUG}`],
  ['marketplace', CURRENT_PLUGIN_SLUG],
  [LEGACY_PLUGIN_SLUG],
  [`${LEGACY_PLUGIN_SLUG}@${LEGACY_PLUGIN_SLUG}`],
  ['marketplace', LEGACY_PLUGIN_SLUG],
];
const CACHE_PLUGIN_SLUGS = [CURRENT_PLUGIN_SLUG, LEGACY_PLUGIN_SLUG];

const raw = fs.readFileSync(0, 'utf8');

// Path (relative to plugin root) to the hook runner
const rel = path.join('scripts', 'hooks', 'run-with-flags.js');

/**
 * Returns true when `candidate` looks like a valid EGC plugin root, i.e. the
 * run-with-flags.js runner exists inside it.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
function hasRunnerRoot(candidate) {
  const value = typeof candidate === 'string' ? candidate.trim() : '';
  return value.length > 0 && fs.existsSync(path.join(path.resolve(value), rel));
}

/**
 * Resolves the EGC plugin root using the following priority order:
 *   1. GEMINI_PLUGIN_ROOT environment variable
 *   2. ~/.gemini (direct install)
 *   3. Several well-known plugin sub-paths under ~/.gemini/plugins/ (current + legacy)
 *   4. Versioned cache directories under ~/.gemini/plugins/cache/{egc,everything-gemini}/
 *   5. Falls back to ~/.gemini if nothing else matches
 *
 * @returns {string}
 */
function resolvePluginRoot() {
  const envRoot = process.env.GEMINI_PLUGIN_ROOT || '';
  if (hasRunnerRoot(envRoot)) {
    return path.resolve(envRoot.trim());
  }

  const home = require('node:os').homedir();
  const claudeDir = path.join(home, '.gemini');

  if (hasRunnerRoot(claudeDir)) {
    return claudeDir;
  }

  const knownPaths = KNOWN_PLUGIN_PATHS.map((segments) =>
    path.join(claudeDir, 'plugins', ...segments)
  );

  for (const candidate of knownPaths) {
    if (hasRunnerRoot(candidate)) {
      return candidate;
    }
  }

  // Walk versioned cache: ~/.gemini/plugins/cache/{egc,everything-gemini}/<org>/<version>/
  try {
    for (const slug of CACHE_PLUGIN_SLUGS) {
      const cacheBase = path.join(claudeDir, 'plugins', 'cache', slug);
      for (const org of fs.readdirSync(cacheBase, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        for (const version of fs.readdirSync(path.join(cacheBase, org.name), { withFileTypes: true })) {
          if (!version.isDirectory()) continue;
          const candidate = path.join(cacheBase, org.name, version.name);
          if (hasRunnerRoot(candidate)) {
            return candidate;
          }
        }
      }
    }
  } catch {
    // cache directory may not exist; that's fine
  }

  return claudeDir;
}

const root = resolvePluginRoot();
const script = path.join(root, rel);

if (fs.existsSync(script)) {
  const result = spawnSync(
    process.execPath,
    [script, 'session:start', 'scripts/hooks/session-start.js', 'minimal,standard,strict'],
    {
      input: raw,
      encoding: 'utf8',
      env: process.env,
      cwd: process.cwd(),
      timeout: 30000,
    }
  );

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (stdout) {
    process.stdout.write(stdout);
  } else {
    process.stdout.write(raw);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error || result.status === null || result.signal) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (result.signal) {
      reason = 'signal ' + result.signal;
    } else {
      reason = 'missing exit status';
    }
    process.stderr.write('[SessionStart] ERROR: session-start hook failed: ' + reason + '\n');
    process.exit(1);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

process.stderr.write(
  '[SessionStart] WARNING: could not resolve EGC plugin root; skipping session-start hook\n'
);
process.stdout.write(raw);
