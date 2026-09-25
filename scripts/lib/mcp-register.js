'use strict';

/**
 * MCP server registration for `egc init`.
 *
 * Extracted from scripts/init.js so the registration logic (which tool
 * configs get egc-guardian / egc-memory written into) can be unit tested
 * without running the full init CLI, which executes top-to-bottom on
 * require() and has no exports of its own.
 *
 * scripts/init.js remains the only caller in production; it supplies the
 * real HOME dir, real bin paths, and wires the callbacks to its own
 * colorized console output. Tests supply a temp dir and inert bin paths
 * instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
// A tool the person installed but never launched owns no config directory,
// so an existence check alone would skip it. The shell installers used to
// cover that with `command -v`; sharing the repo's own probe keeps the two
// detections from drifting, and it falls back to a PATH scan where `which`
// itself is missing.
const { commandExists } = require('./utils');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // Handled per-call below: falls back to the substring check.
}

// A single read instead of existsSync() + readFileSync() closes the window
// where a concurrent process (an IDE, a cloud sync client) deletes or
// recreates the file between the two calls — existsSync() can say true and
// readFileSync() still throw ENOENT a moment later. Any other read error
// (permissions, a directory at that path) still propagates; only "genuinely
// absent" is treated as the same "start fresh" case as "never existed".
function readFileIfExists(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// A line that opens a table. Every key after it belongs to that table, and
// TOML offers no way back to the root, so the root-table scan below stops
// here. The key follows TOML's own grammar: dotted parts, each either bare
// or quoted, and a quoted part may hold any character at all (a table named
// after a URL, say). A line like `[1, 2],` inside a multi-line array is not
// a header, because of the comma between its elements.
const TOML_TABLE_HEADER_SHAPE = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/;
const TOML_KEY_PART = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)$/;

// Splits a dotted key on the dots that sit outside quotes, so a quoted part
// keeps its own dots (a table named after a URL, say).
function splitDottedKey(key) {
  const parts = [''];
  let quote = null;
  let escaped = false;
  for (const char of key) {
    if (!quote && char === '.') {
      parts.push('');
      continue;
    }
    parts[parts.length - 1] += char;
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && char === '\\') {
      escaped = true;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    }
  }
  return parts;
}

function isTomlTableHeader(line) {
  const shape = TOML_TABLE_HEADER_SHAPE.exec(line);
  return shape !== null && splitDottedKey(shape[1]).every(part => TOML_KEY_PART.test(part.trim()));
}

// The same root key in its three legal spellings: bare, basic-quoted and
// literal-quoted all name `mcp_servers`.
const INLINE_MCP_SERVERS_KEY = /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=\s*\[/;

// Everything from the first `#` onwards is a comment. Cutting there before
// looking for the closing `]` keeps a bracket inside a comment from ending
// the array early: `mcp_servers = [ # ]` with the real bracket on the next
// line is a valid empty array, and stopping at the commented one would
// remove only half of it and leave an orphan `]` behind. A `#` inside a
// quoted string can only occur in an array that has content, and a
// non-empty array never reaches the deletion path, so this can never turn a
// populated array into an apparently empty one.
function stripTomlComment(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

const MULTILINE_DELIMITERS = ['"""', "'''"];

// The delimiter still holding a multi-line string open at the end of this
// line, or null when the line ends outside one. Counting delimiters cannot
// do this: only the delimiter that opened a string closes it, so a `"""`
// inside a `'''` string is content, and a lone `'''` inside a single-line
// basic string opens nothing. Outside a string a `#` starts a comment,
// which is free to mention a delimiter; inside one the same characters are
// content, so the text is only cut where a comment can actually begin.
function multilineDelimiterAfter(line, openDelimiter) {
  let open = openDelimiter;
  let text = open ? line : stripTomlComment(line);
  let from = 0;
  for (;;) {
    if (open) {
      const close = text.indexOf(open, from);
      if (close === -1) return open;
      from = close + open.length;
      open = null;
      text = text.slice(0, from) + stripTomlComment(text.slice(from));
      continue;
    }
    const next = MULTILINE_DELIMITERS
      .map(delimiter => ({ delimiter, at: text.indexOf(delimiter, from) }))
      .filter(candidate => candidate.at !== -1)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) return null;
    open = next.delimiter;
    from = next.at + open.length;
  }
}

// TOML spells `mcp_servers` two ways that cannot be mixed: an array of
// tables ([[mcp_servers]], what registerToml appends) and an inline array
// (mcp_servers = [...]). Once the key exists as an inline array, appending
// an [[mcp_servers]] table makes the whole document invalid — "Cannot mutate
// immutable namespace" — and the tool refuses to start on its next launch.
//
// The distinction only survives in the raw text: @iarna/toml parses both
// forms into a plain JS array, so tomlHasActiveServer cannot see it (and
// @iarna/toml is a devDependency that never ships, so the parse path is not
// available at install time anyway).
//
// Mistral Vibe reaches this state on its own: `vibe mcp remove <name>` on
// the last server rewrites the file with `mcp_servers = []` left behind. A
// hand-edited Codex config can reach it too, so the guard is shared.
//
// The scan reads the root table only, skips lines inside a multi-line
// string, accepts the quoted spellings of the key and cuts comments before
// seeking the closing bracket, so what it finds is the real root key and
// nothing that merely looks like one.
//
// A line-based scan has corners whatever it covers, so it is not the last
// word: registerToml re-parses before writing and refuses to turn a file
// that parsed into one that does not.
//
// Returns null when the root key is not an inline array — the normal case,
// including [[mcp_servers]] tables and a file that has no mcp_servers at
// all. Otherwise { start, end, isEmpty }, as inclusive line indices into
// the split content. Anything that cannot be read with confidence is
// reported as non-empty: refusing to touch a file is always safe, appending
// to one that turns out to be occupied is not.
function findInlineMcpServersArray(content) {
  const lines = content.split('\n');
  let openDelimiter = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A line that opens or closes a multi-line string is itself part of that
    // value, so the state is read as it stood before this line was walked.
    const wasInsideString = openDelimiter !== null;
    openDelimiter = multilineDelimiterAfter(raw, openDelimiter);
    if (wasInsideString) continue;

    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;
    // Past the first table header nothing belongs to the root table any more.
    if (isTomlTableHeader(trimmed)) break;
    const opening = INLINE_MCP_SERVERS_KEY.exec(trimmed);
    if (!opening) continue;

    // Collect forward until the closing bracket: TOML allows the inline
    // array to span lines. A nested `]` (an args array inside an inline
    // table) closes early here, which only ever reports the array as
    // occupied — the conservative answer, and the correct one, since a
    // nested array means the outer one is not empty.
    let body = stripTomlComment(trimmed.slice(opening[0].length));
    let end = i;
    let close = body.indexOf(']');
    while (close === -1 && end + 1 < lines.length) {
      end += 1;
      body += '\n' + stripTomlComment(lines[end]);
      close = body.indexOf(']');
    }
    if (close === -1) {
      // Unterminated: no way to tell what is in there.
      return { start: i, end: lines.length - 1, isEmpty: false };
    }

    const inner = body.slice(0, close);
    const compact = inner.split('\n').map(part => part.trim()).filter(Boolean).join('');
    return { start: i, end, isEmpty: compact === '' };
  }

  return null;
}

// Whether an active (uncommented, correctly-tabled) mcp_servers entry with
// the given name already exists. A plain string search matches commented-out
// lines too (`# name = "egc-guardian"` still contains the substring), which
// would make registerToml believe the server is registered when the user
// disabled it, and skip restoring it on the next `egc init`. Parsing catches
// that; if the file doesn't parse (mid-edit, genuinely malformed), fall back
// to the substring check rather than block registration entirely.
function tomlHasActiveServer(content, serverName) {
  if (TOML) {
    try {
      const parsed = TOML.parse(content);
      const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
      return servers.some(server => server && server.name === serverName);
    } catch {
      // Fall through to the substring check below.
    }
  }
  return content.includes(`"${serverName}"`) || content.includes(`'${serverName}'`);
}

/**
 * Tool configs that get egc-guardian / egc-memory registered into them,
 * relative to a given home directory. Each target is only written to if
 * `gate()` returns true, so we don't create config files for tools the
 * person doesn't have installed.
 */
// OpenCode resolves its global config directory through xdg-basedir, which
// is XDG_CONFIG_HOME or ~/.config on every platform, Windows included (there
// is no %APPDATA% lookup in OpenCode). From that directory it loads, in
// order, config.json, opencode.json and opencode.jsonc, and it reads MCP
// servers from the `mcp` key. The documented file name is opencode.json;
// config.json is the legacy name it still honours (#1405).
function openCodeConfigDir(homeDir) {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'opencode');
}

// The file the servers go into: the documented name when it exists, the
// legacy name when only that exists, the documented name when creating.
// A jsonc file is never edited (comments would not survive a rewrite);
// OpenCode merges every file it finds, so a sibling opencode.json is read.
function openCodeConfigPath(homeDir) {
  const dir = openCodeConfigDir(homeDir);
  const documented = path.join(dir, 'opencode.json');
  const legacy = path.join(dir, 'config.json');
  if (fs.existsSync(documented)) return documented;
  if (fs.existsSync(legacy)) return legacy;
  return documented;
}

// Gemini CLI and Continue.dev left this list with their retirement (their
// adapters went in #1279); the ~/.gemini tree below belongs to Antigravity.
function buildMcpRegistrationTargets(homeDir) {
  return [
    {
      name: 'Antigravity CLI',
      path: path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.gemini', 'antigravity-cli')),
      format: 'json',
    },
    {
      // Registration goes through the Claude Code CLI itself (`claude mcp
      // add -s user`), which owns ~/.claude.json. The old target here wrote
      // ~/.claude/claude_desktop_config.json, a file Claude Code never
      // reads (that filename belongs to Claude Desktop, which keeps its
      // config elsewhere entirely), so init reported a registration that
      // did nothing. The path field is the effective destination the CLI
      // maintains, shown in dry-run output.
      name: 'Claude Code (user scope)',
      path: path.join(homeDir, '.claude.json'),
      gate: () => resolveClaudeCli() !== null,
      format: 'claude-cli',
    },
    {
      name: 'Cursor',
      path: path.join(homeDir, '.cursor', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.cursor')) || commandExists('cursor'),
      format: 'json',
    },
    {
      name: 'Kiro',
      path: path.join(homeDir, '.kiro', 'settings', 'mcp.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.kiro')) || commandExists('kiro'),
      format: 'json',
    },
    {
      name: 'Codex CLI',
      path: path.join(homeDir, '.codex', 'config.toml'),
      gate: () => fs.existsSync(path.join(homeDir, '.codex', 'config.toml')) || commandExists('codex'),
      format: 'toml',
    },
    {
      name: 'OpenCode',
      path: openCodeConfigPath(homeDir),
      // The directory is what OpenCode creates on first launch and what the
      // plugin and skills installers already write into; the PATH signal
      // covers an install that was never launched. Same rule on every
      // platform, since OpenCode's paths are the same everywhere.
      gate: () => fs.existsSync(openCodeConfigDir(homeDir)) || commandExists('opencode'),
      format: 'opencode-mcp',
    },
    {
      name: 'Zed',
      path: path.join(homeDir, '.config', 'zed', 'settings.json'),
      gate: () => fs.existsSync(path.join(homeDir, '.config', 'zed')),
      format: 'zed-context-servers',
    },
  ];
}

/**
 * Parses raw JSON configuration content as an object.
 * Returns {} if content is null, empty, or whitespace-only.
 * Throws SyntaxError wrapped in Error if malformed JSON.
 * Throws TypeError if the root value is not an object or is an array.
 */
function parseJsonObject(targetPath, rawContent, rootEntityName = 'config') {
  if (rawContent === null || rawContent === undefined) return {};
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`existing file at ${targetPath} is not valid JSON - left untouched: ${err.message}`, { cause: err });
    }
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`existing file at ${targetPath} is not a valid ${rootEntityName} object - left untouched`);
  }
  return parsed;
}

/**
 * Merges egc-guardian / egc-memory into a JSON mcpServers config, preserving
 * whatever else is already in the file. Returns true if the file was
 * created/changed, false if both entries were already present (a legitimate,
 * silent no-op). Throws if the existing file can't be parsed as JSON -
 * that's not a no-op, it's a reason the config wasn't touched, and the two
 * need to stay distinguishable so a caller can warn on one and stay quiet
 * on the other.
 */
function registerJson(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseJsonObject(targetPath, existingContent, 'MCP config');
  if (obj.mcpServers === null || obj.mcpServers === undefined) {
    obj.mcpServers = {};
  } else if (typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid mcpServers object - left untouched`);
  }
  let changed = false;
  if (!obj.mcpServers['egc-guardian']) {
    obj.mcpServers['egc-guardian'] = { command: 'node', args: [guardianBin] };
    changed = true;
  }
  if (!obj.mcpServers['egc-memory']) {
    obj.mcpServers['egc-memory'] = { command: 'node', args: [memoryBin] };
    changed = true;
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

/**
 * Escapes a path for use inside a TOML basic (double-quoted) string.
 * Two characters can occur in a real filesystem path and break the string: a
 * backslash (TOML reserves "\U" for an 8-hex-digit Unicode escape, so a raw
 * Windows path like C:\Users\... silently corrupts the file the moment a
 * backslash precedes a hex-ish character) and a double quote (legal in a POSIX
 * directory name, and it would terminate the string early). Escape the
 * backslash first so the one added for the quote is not doubled again.
 */
function tomlEscape(p) {
  return p.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}

// Whether the text is a TOML document a parser accepts. Without @iarna/toml
// (a devDependency that never ships) there is nothing to check with, so the
// answer is true and the guard below behaves exactly as the code did before
// it existed, rather than refusing every write it cannot verify.
function parsesAsToml(text) {
  if (!TOML) return true;
  try {
    TOML.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Whether the update touched nothing but mcp_servers. Parsing alone is too
// weak a test: a line cut out of a multi-line string, or a key removed from
// under a table header the scan did not recognise, leaves a document that
// still parses and has quietly lost content. Comparing both sides with
// mcp_servers set aside catches exactly that. Without a parser nothing can
// be compared, so the answer is true and the scan stands on its own.
function keepsEverythingElse(original, updated) {
  if (!TOML) return true;
  try {
    const before = TOML.parse(original);
    const after = TOML.parse(updated);
    delete before.mcp_servers;
    delete after.mcp_servers;
    return isDeepStrictEqual(before, after);
  } catch {
    return false;
  }
}

/**
 * Same idea as registerJson but for TOML configs (Codex CLI, Mistral Vibe).
 * Returns true if the file was appended to, false if both entries were
 * already present.
 *
 * An empty inline `mcp_servers = []` is dropped first: it carries no entries
 * to preserve, and leaving it in place would make the appended
 * [[mcp_servers]] tables invalid TOML. A non-empty one that a parser
 * confirms already holds both servers is a silent no-op - the person
 * followed the error below and added them by hand, and warning again on
 * every run would punish them for doing exactly what they were told; with
 * no parser to confirm it, that case throws like any other. Any other
 * non-empty one throws, the
 * same "left untouched" contract registerJson uses for a file it cannot
 * safely merge into: rewriting it would mean re-serializing entries the
 * person wrote by hand, and appending to it would leave the tool unable to
 * start at all.
 *
 * Whatever the scan concluded, both sides are parsed before anything is
 * written and compared with mcp_servers set aside: an update that would
 * lose any other content is refused and the file is left as it was. An
 * install may leave a tool unregistered, but it must never damage a config.
 */
function registerToml(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const original = readFileIfExists(targetPath) ?? '';
  let content = original;

  const inlineArray = findInlineMcpServersArray(content);
  if (inlineArray && !inlineArray.isEmpty) {
    // Only a real parse can confirm the entries are there, and only a parse
    // is asked for: an entry added by hand as the error below asks carries
    // args = ["/path/index.js"], whose inner bracket ends a line-based scan
    // early and hides every entry after it. Without a parser
    // tomlHasActiveServer falls back to a substring search over the whole
    // file, where a comment naming both servers would pass as proof of a
    // registration that does not exist and the install would report nothing
    // to do, so there the honest answer is to refuse instead.
    if (TOML
      && tomlHasActiveServer(content, 'egc-guardian')
      && tomlHasActiveServer(content, 'egc-memory')) {
      return false;
    }
    throw new TypeError(
      `existing file at ${targetPath} declares mcp_servers as an inline array - left untouched: ` +
      'rewrite it as [[mcp_servers]] tables, or add egc-guardian and egc-memory to it by hand, then re-run'
    );
  }
  if (inlineArray) {
    const lines = content.split('\n');
    lines.splice(inlineArray.start, inlineArray.end - inlineArray.start + 1);
    content = lines.join('\n');
  }

  let appended = false;
  if (!tomlHasActiveServer(content, 'egc-guardian')) {
    content += `\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["${tomlEscape(guardianBin)}"]\n`;
    appended = true;
  }
  if (!tomlHasActiveServer(content, 'egc-memory')) {
    content += `\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["${tomlEscape(memoryBin)}"]\n`;
    appended = true;
  }
  if (!appended) return false;
  if (parsesAsToml(original) && !keepsEverythingElse(original, content)) {
    throw new TypeError(
      `existing file at ${targetPath} could not be updated without breaking it - left untouched: ` +
      'add egc-guardian and egc-memory as [[mcp_servers]] tables by hand, then re-run'
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return true;
}

/**
 * Merges egc-guardian / egc-memory into Zed's settings.json under the
 * context_servers key. Reads mcp-configs/zed-context-servers.json as a
 * template, substitutes __GUARDIAN_BIN__ and __MEMORY_BIN__ with the
 * resolved paths, then merges the result into the existing settings file
 * without overwriting unrelated keys. Returns true if changed.
 */
function registerZedContextServers(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const templatePath = path.join(__dirname, '..', '..', 'mcp-configs', 'zed-context-servers.json');
  // The placeholders sit inside JSON string literals, so a Windows bin path's
  // backslashes (C:\Users\...) must be escaped before substitution or the
  // JSON.parse below throws on the invalid "\U" escape. jsonStringBody yields
  // the escaped body of a JSON string without its surrounding quotes.
  const jsonStringBody = (p) => JSON.stringify(p).slice(1, -1);
  const template = fs.readFileSync(templatePath, 'utf8')
    .replaceAll('__GUARDIAN_BIN__', jsonStringBody(guardianBin))
    .replaceAll('__MEMORY_BIN__', jsonStringBody(memoryBin));
  const incoming = JSON.parse(template);

  const existingContent = readFileIfExists(targetPath);
  const settings = parseJsonObject(targetPath, existingContent, 'settings');
  if (settings.context_servers === null || settings.context_servers === undefined) {
    settings.context_servers = {};
  } else if (typeof settings.context_servers !== 'object' || Array.isArray(settings.context_servers)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid context_servers object - left untouched`);
  }
  let changed = false;
  for (const [key, value] of Object.entries(incoming.context_servers)) {
    if (!settings.context_servers[key]) {
      settings.context_servers[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

// Claude Code's user-scope MCP list lives inside ~/.claude.json, a large
// live state file the CLI rewrites while running - merging into it directly
// risks clobbering whatever the app writes next. The CLI's own `mcp` verbs
// are the stable interface, so registration is only attempted when the CLI
// is actually on PATH (that is also the honest gate: no CLI, no Claude Code
// to register into). PATH resolution is the point, not an accident: this
// must find whatever `claude` the user really runs. On Windows npm installs
// the CLI as claude.cmd, which spawnSync cannot launch without a shell, so
// the resolved candidate is filtered to spawnable extensions and later
// launched with the same shell rule the crusher shim uses.
function resolveClaudeCli() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }); // NOSONAR javascript:S4036 -- resolving the user's claude CLI from PATH is the feature; fixed argv, no shell
  if (probe.status !== 0 || !probe.stdout) return null;
  const candidates = probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return candidates.find(c => process.platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(c)) || null;
}

/**
 * Registers egc-guardian / egc-memory in Claude Code's user scope via
 * `claude mcp add -s user`. `claude mcp get <name>` exiting 0 means the
 * server is already registered (idempotent no-op for that entry). Returns
 * true if any server was newly added, false if both were already present.
 * Throws when the CLI cannot run or refuses an add, so registerTarget
 * surfaces it as a warning instead of a false success.
 */
// When spawnSync runs through the Windows shell, the args array is joined
// onto the command line verbatim (windowsVerbatimArguments): no quoting at
// all, so an install path with a space (C:\Users\First Last\..., Program
// Files) splits into two arguments and the add silently registers garbage.
// Quote what double quotes actually neutralize in cmd.exe: whitespace,
// quotes, and shell metacharacters. Deliberately NOT % or !: cmd expands
// %var% (and !var! under delayed expansion) even inside double quotes, so
// including them would only pretend a safety this quoting cannot provide.
// Embedded quotes double, the cmd convention. POSIX callers never hit this
// path (shell stays false there).
function quoteForCmdShell(arg) {
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return '"' + arg.replaceAll('"', '""') + '"';
}

function registerClaudeCli(_targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const cli = resolveClaudeCli();
  if (!cli) throw new Error('claude CLI not found on PATH');
  // Same Windows rule as the crusher shim: .cmd/.bat need a shell.
  const { needsShellOnWindows } = require('./crusher/shim-dispatch');
  const useShell = needsShellOnWindows(cli);
  const runCli = (args) => spawnSync(
    useShell ? quoteForCmdShell(cli) : cli,
    useShell ? args.map(quoteForCmdShell) : args,
    { encoding: 'utf8', shell: useShell }
  ); // NOSONAR javascript:S4036 -- cli was resolved above from the user's own PATH on purpose; fixed argv

  const servers = [
    ['egc-guardian', guardianBin],
    ['egc-memory', memoryBin],
  ];
  let changed = false;
  for (const [name, bin] of servers) {
    const existing = runCli(['mcp', 'get', name]);
    // A CLI that cannot even run is not "server missing" - surface it
    // instead of piling a doomed `add` on top.
    if (existing.error) throw existing.error;
    if (existing.status === 0) continue;
    const added = runCli(['mcp', 'add', '-s', 'user', name, '--', 'node', bin]);
    if (added.error) throw added.error;
    if (added.status !== 0) {
      throw new Error(`claude mcp add ${name} failed: ${(added.stderr || added.stdout || '').trim()}`);
    }
    changed = true;
  }
  return changed;
}

const EGC_SERVER_NAMES = ['egc-guardian', 'egc-memory'];

// An mcpServers block in an OpenCode file is dead weight: OpenCode never
// reads that key, and an older EGC is the only thing that wrote it there.
// Our two entries are removed from it; anything the person added stays,
// and the key goes away once it is empty.
function dropStaleEgcServers(obj) {
  const stale = obj.mcpServers;
  if (!stale || typeof stale !== 'object' || Array.isArray(stale)) return false;
  let changed = false;
  for (const name of EGC_SERVER_NAMES) {
    if (name in stale) { delete stale[name]; changed = true; }
  }
  if (Object.keys(stale).length === 0) { delete obj.mcpServers; changed = true; }
  return changed;
}

/**
 * Merges egc-guardian / egc-memory into an OpenCode config under the `mcp`
 * key, in OpenCode's own shape ({ type: "local", command: [...] }), leaving
 * every other key as it was. Also retires an `mcpServers` block an older
 * EGC left behind, which OpenCode never read (#1405). Returns true if the
 * file was written.
 */
function registerOpenCodeMcp(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseJsonObject(targetPath, existingContent, 'OpenCode config');
  if (obj.mcp === null || obj.mcp === undefined) {
    obj.mcp = {};
  } else if (typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid mcp object - left untouched`);
  }
  let changed = false;
  const incoming = {
    'egc-guardian': { type: 'local', command: ['node', guardianBin] },
    'egc-memory': { type: 'local', command: ['node', memoryBin] },
  };
  for (const [name, entry] of Object.entries(incoming)) {
    // Presence, not truthiness: an entry the person set to null or false
    // is theirs to keep, whatever OpenCode makes of it.
    if (!Object.hasOwn(obj.mcp, name)) {
      obj.mcp[name] = entry;
      changed = true;
    }
  }
  if (dropStaleEgcServers(obj)) changed = true;
  if (changed) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + '\n');
  }
  const siblingChanged = retireStaleLegacySibling(targetPath);
  return changed || siblingChanged;
}

// When the servers go into opencode.json and a legacy config.json sits next
// to it, the mcpServers block an older EGC may have left in that legacy file
// is retired too (our entries only; the rest of the file is left as it is).
// OpenCode merges both files, so the entries written above reach it either
// way. A legacy file that cannot be parsed is left alone: it is not the file
// being registered into.
function retireStaleLegacySibling(targetPath) {
  if (path.basename(targetPath) !== 'opencode.json') return false;
  const legacyPath = path.join(path.dirname(targetPath), 'config.json');
  const content = readFileIfExists(legacyPath);
  if (content === null || content === undefined) return false;
  let legacy;
  try {
    legacy = parseJsonObject(legacyPath, content, 'OpenCode config');
  } catch {
    return false;
  }
  if (!dropStaleEgcServers(legacy)) return false;
  fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + '\n');
  return true;
}

const FORMAT_HANDLERS = {
  'json': registerJson,
  'toml': registerToml,
  'zed-context-servers': registerZedContextServers,
  'opencode-mcp': registerOpenCodeMcp,
  'claude-cli': registerClaudeCli,
};

function registerTarget(target, bins, onRegister, onWarn, onUnchanged) {
  const handler = FORMAT_HANDLERS[target.format];
  if (!handler) return;
  try {
    const registered = handler(target.path, bins);
    if (registered) {
      if (onRegister) onRegister(target);
    } else if (onUnchanged) {
      onUnchanged(target);
    }
  } catch (err) {
    if (onWarn) onWarn(target, err);
  }
}

/**
 * Walks every gated target for homeDir and registers egc-guardian /
 * egc-memory into whichever tools are actually installed. Callbacks let the
 * caller (scripts/init.js) drive its own console output without this module
 * needing to know about colors or dry-run formatting: onRegister when a
 * target was written, onUnchanged when both servers were already there,
 * onWarn when the target could not be updated, onSkip on a dry run.
 */
function registerMcpServers(homeDir, bins, callbacks = {}) {
  const { dryRun = false, onSkip, onRegister, onWarn, onUnchanged } = callbacks;
  const targets = buildMcpRegistrationTargets(homeDir);

  for (const target of targets) {
    if (!target.gate()) continue;
    if (dryRun) {
      if (onSkip) onSkip(target);
      continue;
    }
    registerTarget(target, bins, onRegister, onWarn, onUnchanged);
  }

  return targets;
}

module.exports = {
  buildMcpRegistrationTargets,
  findInlineMcpServersArray,
  parseJsonObject,
  registerJson,
  registerToml,
  registerZedContextServers,
  registerOpenCodeMcp,
  openCodeConfigPath,
  registerClaudeCli,
  quoteForCmdShell,
  registerMcpServers,
};
