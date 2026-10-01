'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getKnownHarnessDirs, resolveHarnessDirFromEnv } = require('./utils');

const DEFAULT_PROBE = path.join('scripts', 'lib', 'utils.js');
// Claude Code keeps an installed plugin under ~/.claude/plugins, and one from
// a marketplace under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>.
// everything-gemini is the name of the first manifests, which docs/spec
// commits to keep resolvable.
const PLUGIN_SLUGS = ['egc', 'everything-gemini'];
const PLUGIN_ROOT_SEGMENTS = PLUGIN_SLUGS.flatMap(slug => [[slug], [`${slug}@${slug}`], ['marketplace', slug]]);

function hasProbe(dir, probe) {
  return typeof dir === 'string' && dir.length > 0 && fs.existsSync(path.join(dir, probe));
}

function explicitRoot(env, options) {
  const value = options.envRoot === undefined
    ? (env.EGC_PLUGIN_ROOT || env.ECC_PLUGIN_ROOT || env.GEMINI_PLUGIN_ROOT || '')
    : options.envRoot;
  return value?.trim() || null;
}

function findInCacheBase(cacheBase, probe) {
  try {
    for (const plugin of fs.readdirSync(cacheBase, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      for (const version of fs.readdirSync(path.join(cacheBase, plugin.name), { withFileTypes: true })) {
        const candidate = path.join(cacheBase, plugin.name, version.name);
        if (version.isDirectory() && hasProbe(candidate, probe)) return candidate;
      }
    }
  } catch {
    // No cache for this marketplace, or an unreadable one: the next applies.
  }
  return null;
}

function findInPluginCache(pluginsDir, probe) {
  for (const marketplace of PLUGIN_SLUGS) {
    const found = findInCacheBase(path.join(pluginsDir, 'cache', marketplace), probe);
    if (found) return found;
  }
  return null;
}

// The npm package holds every script, including those no tool directory gets.
// Its egc executable links into it (POSIX), or sits beside its node_modules
// (the Windows npm prefix).
function findPackageOnPath(pathValue, probe) {
  for (const dir of (pathValue || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const bin = path.join(dir, 'egc');
      if (fs.existsSync(bin)) {
        const root = path.resolve(path.dirname(fs.realpathSync(bin)), '..');
        if (hasProbe(root, probe)) return root;
      }
    } catch {
      // An unreadable PATH entry is skipped.
    }
    const besideModules = path.join(dir, 'node_modules', '@egchq', 'egc');
    if (hasProbe(besideModules, probe)) return besideModules;
  }
  return null;
}

/**
 * Resolve the EGC root: the directory holding EGC's scripts.
 *
 * Tries, in order, and takes a candidate only when it holds the probe:
 *   1. EGC_PLUGIN_ROOT / ECC_PLUGIN_ROOT / GEMINI_PLUGIN_ROOT (EGC's runners set them)
 *   2. CLAUDE_PLUGIN_ROOT, EGC_DIR, then the directory of the tool in use
 *      (getEGCDir()'s tier 1)
 *   3. The Claude Code plugin under ~/.claude/plugins, then its marketplace cache
 *   4. The npm package, found from the egc executable on PATH
 *   5. The tool directories getEGCDir() knows, then ~/.egc
 *   6. Fallback to ~/.egc
 *
 * INLINE_RESOLVE_FN below is the same order for command and hook code that
 * cannot require this module before the root is known; the tests run both
 * over the same layouts.
 *
 * @param {object} [options]
 * @param {string} [options.homeDir]  Override home directory (for testing)
 * @param {object} [options.env]      Environment to read (default process.env)
 * @param {string} [options.envRoot]  Override the explicit root variables (for testing)
 * @param {string} [options.probe]    Relative path a candidate root must hold.
 *                                    Default: 'scripts/lib/utils.js'
 * @returns {string} Resolved EGC root path
 */
function resolveEGCRoot(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const probe = options.probe || DEFAULT_PROBE;
  const pluginsDir = path.join(homeDir, '.claude', 'plugins');
  const egcDir = path.join(homeDir, '.egc');
  const firstWithProbe = dirs => dirs.find(dir => hasProbe(dir, probe));

  return firstWithProbe([
    explicitRoot(env, options),
    env.CLAUDE_PLUGIN_ROOT?.trim(),
    env.EGC_DIR,
    resolveHarnessDirFromEnv(env, homeDir),
    ...PLUGIN_ROOT_SEGMENTS.map(segments => path.join(pluginsDir, ...segments)),
  ])
    || findInPluginCache(pluginsDir, probe)
    || findPackageOnPath(env.PATH, probe)
    || firstWithProbe([...getKnownHarnessDirs(homeDir), egcDir])
    || egcDir;
}

/**
 * Legacy compatibility alias for resolveEGCRoot.
 * @deprecated Use resolveEGCRoot
 */
function resolveEccRoot(options) {
  return resolveEGCRoot(options);
}

/**
 * Inline form of resolveEGCRoot() for `node -e "..."` code in commands and
 * hooks/hooks.json, where require() is not available before the root is
 * known. Call it with the probe: `${INLINE_RESOLVE_FN}('scripts/skills-health.js')`.
 * It holds no double quote, dollar sign, backtick, exclamation mark, percent
 * sign or backslash, so it embeds unchanged in a double-quoted shell string
 * and in JSON.
 *
 * MAINTENANCE: it mirrors resolveEGCRoot() step by step, including
 * resolveHarnessDirFromEnv() from utils.js; tests/lib/resolve-egc-root.test.js
 * runs both over the same layouts, and tests/lib/command-plugin-root.test.js
 * checks every embedded copy against this string.
 */
const INLINE_RESOLVE_FN = "((q)=>{var v=process.env,p=require('path'),f=require('fs'),h=require('os').homedir(),x=function(d){return d&&f.existsSync(p.join(d,q))},e=(v.EGC_PLUGIN_ROOT||v.ECC_PLUGIN_ROOT||v.GEMINI_PLUGIN_ROOT||'').trim(),t=v.GEMINI_PROJECT_DIR||v.GEMINI_PLUGIN_ROOT?'.gemini':v.CLAUDECODE||v.CLAUDE_PROJECT_DIR||v.CLAUDE_PLUGIN_ROOT?'.claude':v.CODEBUDDY_PROJECT_DIR||v.CODEBUDDY_PLUGIN_ROOT?'.codebuddy':v.VSCODE_AGENT||v.GITHUB_COPILOT_API_TOKEN?'.github':v.KIRO_HOOK_FILE||v.KIRO_FILE_PATH?'.kiro':v.TRAE_ENV?(v.TRAE_ENV==='cn'?'.trae-cn':'.trae'):'',k=p.join(h,'.claude','plugins');for(var d of [e,(v.CLAUDE_PLUGIN_ROOT||'').trim(),v.EGC_DIR,t&&p.join(h,t),p.join(k,'egc'),p.join(k,'egc@egc'),p.join(k,'marketplace','egc'),p.join(k,'everything-gemini'),p.join(k,'everything-gemini@everything-gemini'),p.join(k,'marketplace','everything-gemini')]){if(x(d))return d}for(var g of ['egc','everything-gemini']){var b=p.join(k,'cache',g);try{for(var o of f.readdirSync(b,{withFileTypes:true})){if(o.isDirectory()){for(var w of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){var c=p.join(b,o.name,w.name);if(w.isDirectory()&&x(c))return c}}}}catch(z){}}for(var s of (v.PATH||'').split(p.delimiter)){if(s){try{var g=p.join(s,'egc');if(f.existsSync(g)){var r=p.resolve(p.dirname(f.realpathSync(g)),'..');if(x(r))return r}}catch(z){}var n=p.join(s,'node_modules','@egchq','egc');if(x(n))return n}}for(var u of [['.codeium','windsurf'],['.config','opencode'],['.config','zed'],['.gemini'],['.claude'],['.cursor'],['.agents'],['.amp'],['.continue'],['.github'],['.kiro'],['.trae'],['.trae-cn'],['.codebuddy'],['.egc']]){var m=p.join(h,...u);if(x(m))return m}return p.join(h,'.egc')})";

const INLINE_RESOLVE = `${INLINE_RESOLVE_FN}('scripts/lib/utils.js')`;

module.exports = {
  resolveEGCRoot,
  resolveEccRoot, // NOSONAR: deprecated ECC-era alias kept as a public export for backward compatibility
  INLINE_RESOLVE,
  INLINE_RESOLVE_FN,
};
