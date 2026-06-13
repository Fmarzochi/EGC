'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CURRENT_PLUGIN_SLUG = 'egc';
const LEGACY_PLUGIN_SLUG = 'everything-gemini';
const CURRENT_PLUGIN_HANDLE = `${CURRENT_PLUGIN_SLUG}@${CURRENT_PLUGIN_SLUG}`;
const LEGACY_PLUGIN_HANDLE = `${LEGACY_PLUGIN_SLUG}@${LEGACY_PLUGIN_SLUG}`;
const PLUGIN_CACHE_SLUGS = [CURRENT_PLUGIN_SLUG, LEGACY_PLUGIN_SLUG];
const PLUGIN_ROOT_SEGMENTS = [
  [CURRENT_PLUGIN_SLUG],
  [CURRENT_PLUGIN_HANDLE],
  ['marketplace', CURRENT_PLUGIN_SLUG],
  [LEGACY_PLUGIN_SLUG],
  [LEGACY_PLUGIN_HANDLE],
  ['marketplace', LEGACY_PLUGIN_SLUG],
];

/**
 * Resolve the EGC source root directory.
 *
 * Tries, in order:
 *   1. EGC_PLUGIN_ROOT / ECC_PLUGIN_ROOT / GEMINI_PLUGIN_ROOT env vars
 *   2. Standard install location (~/.gemini/): when scripts exist there
 *   3. Known plugin roots under ~/.gemini/plugins/ (current + legacy slugs)
 *   4. Plugin cache auto-detection: scans ~/.gemini/plugins/cache/{egc,everything-gemini}/
 *   5. Fallback to ~/.gemini/ (original behaviour)
 *
 * @param {object} [options]
 * @param {string} [options.homeDir]  Override home directory (for testing)
 * @param {string} [options.envRoot]  Override EGC_PLUGIN_ROOT (for testing)
 * @param {string} [options.probe]    Relative path used to verify a candidate root
 *                                    contains EGC scripts. Default: 'scripts/lib/utils.js'
 * @returns {string} Resolved EGC root path
 */
function resolveEGCRoot(options = {}) {
  const envRoot = options.envRoot !== undefined
    ? options.envRoot
    : (process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT || '');

  if (envRoot && envRoot.trim()) {
    return envRoot.trim();
  }

  const homeDir = options.homeDir || os.homedir();
  const claudeDir = path.join(homeDir, '.gemini');
  const probe = options.probe || path.join('scripts', 'lib', 'utils.js');

  // Standard install: files are copied directly into ~/.gemini/
  if (fs.existsSync(path.join(claudeDir, probe))) {
    return claudeDir;
  }

  // Exact legacy plugin install locations. These preserve backwards
  // compatibility without scanning arbitrary plugin trees.
  const legacyPluginRoots = PLUGIN_ROOT_SEGMENTS.map((segments) =>
    path.join(claudeDir, 'plugins', ...segments)
  );

  for (const candidate of legacyPluginRoots) {
    if (fs.existsSync(path.join(candidate, probe))) {
      return candidate;
    }
  }

  // Plugin cache: Gemini Code stores marketplace plugins under
  // ~/.gemini/plugins/cache/<plugin-name>/<org>/<version>/
  try {
    for (const slug of PLUGIN_CACHE_SLUGS) {
      const cacheBase = path.join(claudeDir, 'plugins', 'cache', slug);
      const orgDirs = fs.readdirSync(cacheBase, { withFileTypes: true });

      for (const orgEntry of orgDirs) {
        if (!orgEntry.isDirectory()) continue;
        const orgPath = path.join(cacheBase, orgEntry.name);

        let versionDirs;
        try {
          versionDirs = fs.readdirSync(orgPath, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const verEntry of versionDirs) {
          if (!verEntry.isDirectory()) continue;
          const candidate = path.join(orgPath, verEntry.name);
          if (fs.existsSync(path.join(candidate, probe))) {
            return candidate;
          }
        }
      }
    }
  } catch {
    // Plugin cache doesn't exist or isn't readable: continue to fallback
  }

  return claudeDir;
}

/**
 * Legacy compatibility alias for resolveEGCRoot.
 * @deprecated Use resolveEGCRoot
 */
function resolveEccRoot(options) {
  return resolveEGCRoot(options);
}

/**
 * Compact inline version for embedding in command .md code blocks.
 *
 * This is the minified form of resolveEGCRoot() suitable for use in
 * node -e "..." scripts where require() is not available before the
 * root is known.
 *
 * Usage in commands:
 *   const _r = <paste INLINE_RESOLVE>;
 *   const sm = require(_r + '/scripts/lib/session-manager');
 *
 * MAINTENANCE: The plugin path arrays inside this string are the serialised
 * forms of PLUGIN_ROOT_SEGMENTS and PLUGIN_CACHE_SLUGS defined above.
 * If those constants change, update the corresponding literals here too.
 */
const INLINE_RESOLVE = '(()=>{var e=process.env.EGC_PLUGIN_ROOT||process.env.ECC_PLUGIN_ROOT||process.env.GEMINI_PLUGIN_ROOT;if(e&&e.trim())return e.trim();var p=require(\'path\'),f=require(\'fs\'),h=require(\'os\').homedir(),d=p.join(h,\'.gemini\'),q=p.join(\'scripts\',\'lib\',\'utils.js\');if(f.existsSync(p.join(d,q)))return d;for(var s of [["egc"],["egc@egc"],["marketplace","egc"],["everything-gemini"],["everything-gemini@everything-gemini"],["marketplace","everything-gemini"]]){var l=p.join(d,\'plugins\',...s);if(f.existsSync(p.join(l,q)))return l}try{for(var g of ["egc","everything-gemini"]){var b=p.join(d,\'plugins\',\'cache\',g);for(var o of f.readdirSync(b,{withFileTypes:true})){if(!o.isDirectory())continue;for(var v of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){if(!v.isDirectory())continue;var c=p.join(b,o.name,v.name);if(f.existsSync(p.join(c,q)))return c}}}}catch(x){}return d})()';

module.exports = {
  resolveEGCRoot,
  resolveEccRoot,
  INLINE_RESOLVE,
};
