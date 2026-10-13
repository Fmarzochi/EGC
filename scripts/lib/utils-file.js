/**
 * File content operations, string sanitisation, hook stdin/stdout I/O and
 * forensic tracing for EGC hooks and scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readHookStdin, readHookInput } = require('./hook-stdin');
const { ensureDir } = require('./utils-paths');

/**
 * Find files matching a pattern in a directory (cross-platform alternative to find)
 * @param {string} dir - Directory to search
 * @param {string} pattern - File pattern (e.g., "*.tmp", "*.md")
 * @param {object} options - Options { maxAge: days, recursive: boolean }
 */
function findFiles(dir, pattern, options = {}) {
  if (!dir || typeof dir !== 'string') return [];
  if (!pattern || typeof pattern !== 'string') return [];

  const { maxAge = null, recursive = false } = options;
  const results = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  // Escape all regex special characters, then convert glob wildcards.
  // Order matters: escape specials first, then convert * and ? to regex equivalents.
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  const regex = new RegExp(`^${regexPattern}$`);

  function collectIfInAge(fullPath, stats) {
    if (maxAge === null) {
      results.push({ path: fullPath, mtime: stats.mtimeMs });
      return;
    }
    const ageInDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageInDays <= maxAge) results.push({ path: fullPath, mtime: stats.mtimeMs });
  }

  function searchDir(currentDir) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isFile() && regex.test(entry.name)) {
          let stats;
          try {
            stats = fs.statSync(fullPath);
          } catch {
            continue;
          }
          collectIfInAge(fullPath, stats);
        } else if (entry.isDirectory() && recursive) {
          searchDir(fullPath);
        }
      }
    } catch (_err) { // NOSONAR
      // Ignore permission errors
    }
  }

  searchDir(dir);

  results.sort((a, b) => b.mtime - a.mtime);

  return results;
}

/**
 * Read JSON from stdin (for hook input)
 * @param {object} options - Options
 * @param {number} options.timeoutMs - Timeout in milliseconds (default: 5000).
 *   Prevents hooks from hanging indefinitely if stdin never closes.
 * @returns {Promise<object>} Parsed JSON object, or empty object if stdin is empty
 */
async function readStdinJson(options = {}) {
  const { timeoutMs = 5000, maxSize = 1024 * 1024 } = options;

  return new Promise((resolve) => {
    let data = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        if (process.stdin.unref) process.stdin.unref();
        if (process.stdin.destroy) process.stdin.destroy();
        process.stdin.removeAllListeners('error');
        // Resolve with whatever we have so far rather than hanging
        try {
          resolve(data.trim() ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      }
    }, timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (data.length < maxSize) {
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        // Consistent with timeout path: resolve with empty object
        // so hooks don't crash on malformed input
        resolve({});
      }
    });

    process.stdin.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolve with empty object so hooks don't crash on stdin errors
      resolve({});
    });
  });
}

/**
 * Log to stderr (visible to the user in the terminal)
 */
function log(message) {
  console.error(message);
}

/**
 * Output to stdout (returned to Gemini)
 */
function output(data) {
  if (typeof data === 'object') {
    console.log(JSON.stringify(data));
  } else {
    console.log(data);
  }
}

/**
 * Read a text file safely
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8'); // NOSONAR jssecurity:S8707
  } catch {
    return null;
  }
}

/**
 * Write a text file
 */
function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Append to a text file
 */
function appendFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, 'utf8');
}

/**
 * Replace text in a file (cross-platform sed alternative)
 * @param {string} filePath - Path to the file
 * @param {string|RegExp} search - Pattern to search for. String patterns replace
 *   the FIRST occurrence only; use a RegExp with the `g` flag for global replacement.
 * @param {string} replace - Replacement string
 * @param {object} options - Options
 * @param {boolean} options.all - When true and search is a string, replaces ALL
 *   occurrences (uses String.replaceAll). Ignored for RegExp patterns.
 * @returns {boolean} true if file was written, false on error
 */
function replaceInFile(filePath, search, replace, options = {}) {
  const content = readFile(filePath);
  if (content === null) return false;

  try {
    let newContent;
    if (options.all && typeof search === 'string') {
      newContent = content.replaceAll(search, replace);
    } else {
      newContent = content.replace(search, replace);
    }
    writeFile(filePath, newContent);
    return true;
  } catch (err) {
    log(`[Utils] replaceInFile failed for ${path.basename(filePath)}: ${err.name || 'write error'}`);
    return false;
  }
}

/**
 * Count occurrences of a pattern in a file
 * @param {string} filePath - Path to the file
 * @param {string|RegExp} pattern - Pattern to count. Strings are treated as
 *   global regex patterns. RegExp instances are used as-is but the global
 *   flag is enforced to ensure correct counting.
 * @returns {number} Number of matches found
 */
function countInFile(filePath, pattern) {
  const content = readFile(filePath);
  if (content === null) return 0;

  let regex;
  try {
    if (pattern instanceof RegExp) {
      // Always create new RegExp to avoid shared lastIndex state; ensure global flag
      regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    } else if (typeof pattern === 'string') {
      regex = new RegExp(pattern, 'g');
    } else {
      return 0;
    }
  } catch {
    return 0; // Invalid regex pattern
  }
  const matches = content.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Strip all ANSI escape sequences from a string.
 *
 * Handles:
 * - CSI sequences: \x1b[ … <letter>  (colors, cursor movement, erase, etc.)
 * - OSC sequences: \x1b] … BEL/ST    (window titles, hyperlinks)
 * - Charset selection: \x1b(B
 * - Bare ESC + single letter: \x1b <letter>  (e.g. \x1bM for reverse index)
 *
 * @param {string} str - Input string possibly containing ANSI codes
 * @returns {string} Cleaned string with all escape sequences removed
 */
function stripAnsi(str) {
  if (typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- NOSONAR: ANSI escape stripping needs the literal control bytes
  return str.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([A-Z]|[A-Z])/g, '');
}

/**
 * Search for pattern in file and return matching lines with line numbers
 */
function grepFile(filePath, pattern) {
  const content = readFile(filePath);
  if (content === null) return [];

  let regex;
  try {
    if (pattern instanceof RegExp) {
      // Always create a new RegExp without the 'g' flag to prevent lastIndex
      // state issues when using .test() in a loop (g flag makes .test() stateful,
      // causing alternating match/miss on consecutive matching lines)
      const flags = pattern.flags.replace('g', '');
      regex = new RegExp(pattern.source, flags);
    } else {
      regex = new RegExp(pattern);
    }
  } catch {
    return []; // Invalid regex pattern
  }
  const lines = content.split('\n');
  const results = [];

  lines.forEach((line, index) => {
    if (regex.test(line)) {
      results.push({ lineNumber: index + 1, content: line });
    }
  });

  return results;
}

/**
 * Format a string as an OSC-8 terminal hyperlink.
 *
 * Sequence: OSC 8 ; params ; url ST text OSC 8 ; ; ST
 * Reference: https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 *
 * @param {string} text - The visible text for the link
 * @param {string} uri - The target URI (e.g., egc://session/123)
 * @returns {string} Formatted escape sequence or plain text if unsupported
 */
function formatOSC8(text, uri) {
  // Graceful fallback for unsupported environments
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') {
    return `${text} (${uri})`;
  }

  const OSC = '\x1b]';
  const ST = '\x1b\\';
  const SEP = ';';

  return `${OSC}8${SEP}${SEP}${uri}${ST}${text}${OSC}8${SEP}${SEP}${ST}`;
}

/**
 * Trace an event for Live Runtime Forensics
 */
function trace(event, data = {}) {
  const forensicLog = path.join(os.tmpdir(), 'egc-forensic-trace.log');
  const timestamp = new Date().toISOString();
  const sessionId = process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || 'unknown';
  const payload = JSON.stringify({
    timestamp,
    pid: process.pid,
    sessionId,
    event,
    ...data
  });
  fs.appendFile(forensicLog, payload + '\n', 'utf8', (err) => {
    if (err) console.error('trace write failed:', err);
  });
}

module.exports = {
  findFiles,
  readFile,
  writeFile,
  appendFile,
  replaceInFile,
  countInFile,
  grepFile,
  stripAnsi,
  formatOSC8,
  readStdinJson,
  readHookStdin,
  readHookInput,
  log,
  output,
  trace,
};
