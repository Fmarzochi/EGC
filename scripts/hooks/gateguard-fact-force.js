#!/usr/bin/env node
/**
 * PreToolUse Hook: GateGuard Fact-Forcing Gate
 *
 * Forces Gemini to investigate before editing files or running commands.
 * Instead of asking "are you sure?" (which LLMs always answer "yes"),
 * this hook demands concrete facts: importers, public API, data schemas.
 *
 * The act of investigation creates awareness that self-evaluation never did.
 *
 * Gates:
 *   - Edit/Write: list importers, affected API, verify data schemas, quote instruction
 *   - apply_patch (Codex CLI's freeform file-edit tool): same gate as Edit,
 *     applied to every file path parsed out of the patch text
 *   - Bash (destructive): list targets, rollback plan, quote instruction
 *   - Bash (routine): quote current instruction (once per session)
 *
 * Compatible with run-with-flags.js via module.exports.run().
 * Cross-platform (Windows, macOS, Linux).
 *
 * Full package with config support: pip install gateguard-ai
 * Repo: https://github.com/zunoworks/gateguard
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');


// Session state: scoped per session to avoid cross-session races.
const STATE_DIR = process.env.GATEGUARD_STATE_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.gateguard');
let activeStateFile = null;

// State expires after 30 minutes of inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const READ_HEARTBEAT_MS = 60 * 1000;

// Maximum checked entries to prevent unbounded growth
const MAX_CHECKED_ENTRIES = 500;
const MAX_SESSION_KEYS = 50;
const ROUTINE_BASH_SESSION_KEY = '__bash_session__';
const EDIT_WRITE_HOOK_ID = 'pre:edit-write:gateguard-fact-force';
const BASH_HOOK_ID = 'pre:bash:gateguard-fact-force';
const EGC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

// The hook input of the current call, kept for the transcript lookup.
let hookInput = null;

function pendingKey(key) {
  return `pending:${key}`;
}

function presentedKey(key) {
  return `presented:${key}`;
}

// How many times one operation may be refused for missing facts before the
// gate concludes it cannot read them and steps aside.
const MAX_FACT_DENIALS = 3;

function denialKey(key, attempt) {
  return `denied:${attempt}:${key}`;
}

function denialCount(key) {
  let attempts = 0;
  while (attempts < MAX_FACT_DENIALS && isChecked(denialKey(key, attempts + 1))) attempts += 1;
  return attempts;
}

// The assistant text read from the harness transcript when one is named in
// the hook input (see assistantTextSinceDenial for which text is judged).
// Null when no transcript can be read, so a harness without transcripts
// keeps the identical-retry rule.
// A transcript named by the hook input is read only when it is an absolute
// .jsonl file under the home directory or the temporary directory, with no
// parent segments: the harness writes transcripts there and nowhere else.
// A root as the filesystem knows it; a root that cannot be resolved admits
// nothing (the sentinel never prefixes a real path).
function realRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch (_) { // NOSONAR: see above
    return '\0';
  }
}

function readTranscriptTail(candidate) {
  if (typeof candidate !== 'string' || !candidate.endsWith('.jsonl') || !path.isAbsolute(candidate)) return null;
  if (candidate.split(/[\\/]/).includes('..')) return null;
  // The real location is what is read: a link under an allowed root that
  // points elsewhere is refused.
  let real;
  try {
    real = fs.realpathSync(path.resolve(candidate));
  } catch (_) { // NOSONAR: a transcript that cannot be resolved is not read
    return null;
  }
  const home = realRoot(os.homedir());
  const temporary = realRoot(os.tmpdir());
  const transcriptPath = path.resolve(real);
  if (!transcriptPath.startsWith(home + path.sep) && !transcriptPath.startsWith(temporary + path.sep)) return null;
  try {
    const descriptor = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (_) { // NOSONAR: an unreadable transcript keeps the identical-retry rule
    return null;
  }
}

function parseTranscriptLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' ? entry : null;
  } catch (_) { // NOSONAR: a partial first line or a non-JSON line is skipped
    return null;
  }
}

function assistantTextBlocks(entry) {
  const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
}

const GATE_MARKER = '[fact-forcing gate]';

function transcriptEntries(data) {
  const tail = readTranscriptTail(data?.transcript_path || data?.transcriptPath);
  if (tail === null) return null;
  return tail.split('\n').map(parseTranscriptLine).filter(Boolean);
}

// A tool result is recorded as a string or as a list of text parts.
function resultTextOf(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text);
}

// A denial is a tool result the harness marked as an error; a result it
// marked as a success (a command that merely printed the marker) is never
// one. Harnesses that record no such flag are read as before.
function deniedResultTexts(entry) {
  const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  return content
    .filter(block => block?.type === 'tool_result' && block.is_error !== false)
    .flatMap(block => resultTextOf(block.content));
}

// The term must end where the denial's wording ends it (a comma, a space,
// a sentence-ending period, the end of the text), so a path is never
// matched inside a longer one such as the same name with another suffix.
function endsTermAt(text, index) {
  const next = text[index];
  if (next === undefined || /[\s,:;)]/.test(next)) return true;
  if (next !== '.') return false;
  const after = text[index + 1];
  return after === undefined || /\s/.test(after);
}

function namesTerm(text, term) {
  const needle = String(term || '').toLowerCase();
  if (!needle) return false;
  let index = text.indexOf(needle);
  while (index !== -1) {
    if (endsTermAt(text, index + needle.length)) return true;
    index = text.indexOf(needle, index + 1);
  }
  return false;
}

// The denial this gate wrote earlier for the same target, as the harness
// records it: a user entry whose denied tool result carries the gate marker
// and a term that names the target (the full path of a file, or the wording
// of the destructive gate).
function isGateDenial(entry, anchorTerms) {
  if (entry.type !== 'user') return false;
  const text = deniedResultTexts(entry).join('\n').toLowerCase();
  return text.includes(GATE_MARKER) && anchorTerms.some(term => namesTerm(text, term));
}

// The assistant text since the last user turn: the rule for a transcript
// that does not record the gate's own denial.
function textSinceLastUserTurn(entries) {
  let texts = [];
  for (const entry of entries) {
    if (entry.type === 'user') texts = [];
    else if (entry.type === 'assistant') texts.push(...assistantTextBlocks(entry));
  }
  return texts.join('\n');
}

// What the assistant wrote for this retry, as far as the transcript shows.
// A tool result is recorded as a user entry, so the boundary that matters
// is the gate's own denial, not the last user entry: the facts are whatever
// the assistant wrote after being refused. Claude Code appends the entries
// of an assistant message only once its first tool call completes, so at
// PreToolUse time the message that carries the retry is not in the file
// yet; when no assistant text follows the denial, the retry cannot be
// judged (judgeable: false) and the identical-retry rule applies.
function assistantTextSinceDenial(data, anchorTerms) {
  const entries = transcriptEntries(data);
  if (entries === null) return null;
  let denialIndex = -1;
  entries.forEach((entry, index) => {
    if (isGateDenial(entry, anchorTerms)) denialIndex = index;
  });
  if (denialIndex === -1) return { text: textSinceLastUserTurn(entries), judgeable: true };
  const text = entries.slice(denialIndex + 1)
    .filter(entry => entry.type === 'assistant')
    .flatMap(assistantTextBlocks)
    .join('\n');
  // Tool calls of the same batch as the denied one are recorded before the
  // retry, but they carry no text: only assistant text is a message to judge.
  return { text, judgeable: text.trim().length > 0 };
}

function missingFacts(text, required) {
  const lower = text.toLowerCase();
  return required.filter(term => term && !lower.includes(term.toLowerCase()));
}

function factsMissingMsg(missing, target) {
  return [
    '[Fact-Forcing Gate]',
    '',
    `The retry for ${target} was refused: the message before it does not present the required facts (missing: ${missing.join(', ')}).`,
    'Write the facts in your reply, then retry the same operation.'
  ].join('\n');
}

function commandWord(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.split(/[\\/]/).pop();
}

// The first retry after a denial is accepted only when the message before
// it presents the facts (when a transcript is there to read); later
// operations on the same target stay free, as before. The denial is found
// by the target it named (the full path of a file, so two files with the
// same name in different directories never share an anchor); the facts
// themselves only need to name the file.
function refuseUnpresentedFacts(key, required, traceMeta, options = {}) {
  if (!isChecked(pendingKey(key)) || isChecked(presentedKey(key))) return null;
  const target = options.target || 'this command';
  const written = assistantTextSinceDenial(hookInput, options.anchorTerms || required);
  if (!written?.judgeable) {
    if (written) trace('governance:allowed:facts_unjudged', traceMeta);
    markChecked(presentedKey(key));
    return null;
  }
  const missing = missingFacts(written.text, required);
  if (missing.length === 0) {
    markChecked(presentedKey(key));
    return null;
  }
  // A gate that cannot be satisfied is not a guardrail. The facts of a
  // subagent never reach the transcript this gate reads (the harness names
  // the parent session's), so the same retry was refused forever. After
  // three refusals for one operation the gate says so and steps aside,
  // leaving the Guardian, which judges the operation itself, in place.
  const denials = denialCount(key) + 1;
  if (denials > MAX_FACT_DENIALS) {
    trace('governance:allowed:facts_unreachable', { ...traceMeta, missing, denials });
    markChecked(presentedKey(key));
    return {
      stderr: `[Fact-Forcing Gate] The facts for ${target} were refused ${MAX_FACT_DENIALS} times and the retry text still does not carry them (${missing.join(', ')}). Allowing it so the gate cannot block forever. If this ran inside a subagent, its text never reaches the transcript the gate reads.`,
      exitCode: 0
    };
  }
  markChecked(denialKey(key, denials));
  trace('governance:denied:facts_missing', { ...traceMeta, missing, denials });
  return denyResult(factsMissingMsg(missing, target), { includeRecoveryHint: false });
}

// One pattern per destructive command, anchored: these name the command being
// run, so they only count at the head of a segment, after wrappers and with
// quotes removed. Tested against the raw text, as they were before, they also
// fired on a grep pattern, a commit message and a heredoc body that merely
// named the command, and a gate that cries wolf is one people walk around.
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /^rm\s+-rf\b/i,
  /^git\s+reset\s+--hard\b/i,
  // The pathspec form and the two merge sides all overwrite the working file.
  /^git\s+checkout\s+(--(\s|$)|--ours\b|--theirs\b|-f\b|--force\b)/i,
  /^git\s+clean\s+-f/i,
  /^git\s+push\s+--force(?!-with-lease)\b/i,
  /^git\s+commit\s+--amend\b/i,
  /^dd\s+if=/i,
];

// These name what a command carries rather than the command itself: SQL
// reaches the database as an argument or through a heredoc, so it is read
// wherever it sits.
const DESTRUCTIVE_CONTENT_PATTERNS = [
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\b/i,
];

// Words that stand in front of the command they run, read by the Guardian
// validator's own wrapper tables (scripts/lib/wrapper-options.js).
// Wrapper options that make the wrapper answer for itself and exit, so the
// words after them are never executed and classify nothing.
const TERMINATING_WRAPPER_FLAGS = new Set(['-V', '--version', '--help']);
const HELP_H = new Set(['-h']);
const TERMINATING_BY_WRAPPER = {
  sudo: new Set(['-v', '--validate', '-l', '--list']),
  command: new Set(['-v', '-V']),
  doas: new Set(['-L']),
  parallel: HELP_H, setsid: HELP_H, taskset: HELP_H, chrt: HELP_H, unshare: HELP_H, nsenter: HELP_H, prlimit: HELP_H, runuser: HELP_H,
};
// numactl's -V is --verify, which runs the command.
const RUNNING_BY_WRAPPER = { numactl: new Set(['-V']) };
const ENV_ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;

// The words of a line as the shell would see them: quotes group and then
// disappear, a backslash escapes the next character.
function shellWordsOf(line) {
  const words = [];
  let word = '';
  let quote = null;
  let open = false;
  const flush = () => {
    if (open || word) words.push(word);
    word = '';
    open = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      word += line[i + 1];
      i += 1;
      open = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
      open = true;
    }
  }
  flush();
  return words;
}

function isTerminating(name, word, names) {
  return [word, ...names].some((flag) => !RUNNING_BY_WRAPPER[name]?.has(flag)
    && (TERMINATING_WRAPPER_FLAGS.has(flag) || TERMINATING_BY_WRAPPER[name]?.has(flag)));
}

// The index of the first word after a wrapper's own options and the
// positionals it takes (timeout's duration, flock's lock file, chrt's
// priority when it is a number); -1 when an option ends the wrapper's work
// (`sudo -v`, `timeout --help`) and no command follows.
function skipWrapperOptions(words, start, name) {
  let i = start;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-') {
      if (WRAPPER_SPECS[name].loneDashIsOption) i += 1;
      break;
    }
    const option = readWrapperOption(name, words[i], words[i + 1]);
    if (isTerminating(name, words[i], option.names)) return -1;
    i += option.width;
  }
  const spec = WRAPPER_SPECS[name];
  let skip = spec.leadingPositionals ?? 0;
  while (skip > 0 && i < words.length && (!spec.positionalWhen || spec.positionalWhen.test(words[i]))) {
    i += 1;
    skip -= 1;
  }
  return i;
}

// What a segment actually runs: its command line (a backslash-newline is a
// continuation and joins; a heredoc body follows a real newline and is data),
// dequoted, with leading environment assignments and wrapper commands dropped,
// options and values included, so the real command sits at position zero.
function commandLineOf(segment) {
  const joined = segment.replace(/\\\n\s*/g, ' ');
  const words = shellWordsOf(joined.split('\n', 1)[0]);
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ENV_ASSIGNMENT_RE.test(word)) { i += 1; continue; }
    const name = path.basename(word);
    if (!Object.hasOwn(WRAPPER_SPECS, name)) break;
    // A wrapper carries its own options (`sudo -u root`, `xargs -n1 -I{}`)
    // and sometimes a mandatory value (`timeout 30`): skipping only the word
    // itself left the wrapper's first option in command position and the real
    // command unread.
    i = skipWrapperOptions(words, i + 1, name);
    if (i < 0) return '';
  }
  return words.slice(i).join(' ');
}

// Every place a segment can hide a command the shell runs: the pipeline
// stages, and the bodies of command substitutions.
function commandLinesOf(command) {
  const segments = [
    ...splitShellSegments(command, { splitOnPipe: true }),
    ...extractSubstitutionBodies(command).flatMap((body) => splitShellSegments(body, { splitOnPipe: true })),
  ];
  return segments.map(commandLineOf);
}

// The wording of the destructive gate's own messages: what anchors a
// destructive retry, so a file denial that happens to mention a rollback
// never does.
const DESTRUCTIVE_ANCHORS = ['destructive command detected', 'retry for this command'];

function isDestructiveBash(command) {
  if (DESTRUCTIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return commandLinesOf(command)
    .some((line) => DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(line)));
}

// --- State management (per-session, atomic writes, bounded) ---

function normalizeEnvValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isGateGuardDisabled() {
  if (normalizeEnvValue(process.env.GATEGUARD_DISABLED) === '1') {
    return true;
  }

  return EGC_DISABLE_VALUES.has(normalizeEnvValue(process.env.EGC_GATEGUARD || process.env.ECC_GATEGUARD));
}

function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) {
    return sanitized;
  }

  return hashSessionKey('sid', raw);
}

function hashSessionKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function resolveSessionKey(data) {
  const directCandidates = [data?.session_id, data?.sessionId, data?.session?.id, process.env.EGC_SESSION_ID, process.env.ECC_SESSION_ID];

  for (const candidate of directCandidates) {
    const sanitized = sanitizeSessionKey(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  const transcriptPath = (data && (data.transcript_path || data.transcriptPath)) || process.env.GEMINI_TRANSCRIPT_PATH;
  if (transcriptPath && String(transcriptPath).trim()) {
    return hashSessionKey('tx', path.resolve(String(transcriptPath).trim()));
  }

  const projectFingerprint = process.env.GEMINI_PROJECT_DIR || process.cwd();
  return hashSessionKey('proj', path.resolve(projectFingerprint));
}

function getStateFile(data) {
  if (!activeStateFile) {
    const sessionKey = resolveSessionKey(data);
    activeStateFile = path.join(STATE_DIR, `state-${sessionKey}.json`);
  }
  return activeStateFile;
}

function loadState() {
  const stateFile = getStateFile();
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const lastActive = state.last_active || 0;
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        try {
          fs.unlinkSync(stateFile);
        } catch (_) { // NOSONAR
          /* ignore */
        }
        return { checked: [], last_active: Date.now() };
      }
      return state;
    }
  } catch (_) { // NOSONAR
    /* ignore */
  }
  return { checked: [], last_active: Date.now() };
}

function pruneCheckedEntries(checked) {
  if (checked.length <= MAX_CHECKED_ENTRIES) {
    return checked;
  }

  const preserved = checked.includes(ROUTINE_BASH_SESSION_KEY) ? [ROUTINE_BASH_SESSION_KEY] : [];
  const sessionKeys = checked.filter(k => k.startsWith('__') && k !== ROUTINE_BASH_SESSION_KEY);
  const fileKeys = checked.filter(k => !k.startsWith('__'));
  const remainingSessionSlots = Math.max(MAX_SESSION_KEYS - preserved.length, 0);
  const cappedSession = sessionKeys.slice(-remainingSessionSlots);
  const remainingFileSlots = Math.max(MAX_CHECKED_ENTRIES - preserved.length - cappedSession.length, 0);
  const cappedFiles = fileKeys.slice(-remainingFileSlots);
  return [...preserved, ...cappedSession, ...cappedFiles];
}

function mergeStateWithDisk(stateFile, checked, lastActive) {
  try {
    if (!fs.existsSync(stateFile)) return { checked, lastActive };
    const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      checked: Array.isArray(diskState.checked) ? Array.from(new Set([...diskState.checked, ...checked])) : checked,
      lastActive: typeof diskState.last_active === 'number' ? Math.max(lastActive, diskState.last_active) : lastActive,
    };
  } catch (_) { // NOSONAR: unreadable disk state falls back to the in-memory state
    return { checked, lastActive };
  }
}

function atomicRenameFile(tmpFile, stateFile) {
  try {
    fs.renameSync(tmpFile, stateFile);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      try { fs.unlinkSync(stateFile); } catch (_) { /* ignore: best-effort unlink before retry, subsequent renameSync will handle failures */ } // NOSONAR
      fs.renameSync(tmpFile, stateFile);
    } else {
      throw error;
    }
  }
}

function saveState(state) {
  const stateFile = getStateFile();
  let tmpFile = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    const rawChecked = Array.isArray(state.checked) ? state.checked : [];
    const rawLastActive = typeof state.last_active === 'number' ? state.last_active : 0;
    const merged = mergeStateWithDisk(stateFile, rawChecked, rawLastActive);

    const finalState = {
      checked: pruneCheckedEntries(merged.checked),
      last_active: Math.max(merged.lastActive, Date.now()),
    };

    // Atomic write: temp file + rename prevents partial reads
    tmpFile = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpFile, JSON.stringify(finalState, null, 2), 'utf8');
    atomicRenameFile(tmpFile, stateFile);
    tmpFile = null;
    return true;
  } catch (_) { // NOSONAR: failed save returns false after best-effort tmp cleanup
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_2) { /* ignore: best-effort cleanup of temporary state file during save failure */ } } // NOSONAR
    return false;
  }
}

function markChecked(key) {
  const state = loadState();
  if (!state.checked.includes(key)) {
    state.checked.push(key);
    return saveState(state);
  }
  return true;
}

function isChecked(key) {
  const state = loadState();
  const found = state.checked.includes(key);
  if (found && Date.now() - (state.last_active || 0) > READ_HEARTBEAT_MS) {
    saveState(state);
  }
  return found;
}

// Prune stale session files older than 1 hour. Every other piece of work in
// this module checks isGateGuardDisabled() first; this module-load-time scan
// used to run unconditionally, so a disabled GateGuard still paid the
// synchronous readdir/stat/unlink cost on every process start (EGC-539 audit).
if (!isGateGuardDisabled()) {
  (function pruneStaleFiles() {
    try {
      const files = fs.readdirSync(STATE_DIR);
      const now = Date.now();
      for (const f of files) {
        const isStateFile = f.startsWith('state-') && (f.endsWith('.json') || f.includes('.json.tmp.'));
        if (!isStateFile) continue;
        const fp = path.join(STATE_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > SESSION_TIMEOUT_MS * 2) {
            fs.unlinkSync(fp);
          }
        } catch (_) { // NOSONAR
          // Ignore files that disappear between readdir/stat/unlink.
        }
      }
    } catch (_) { // NOSONAR
      /* ignore */
    }
  })();
}

// --- Sanitize file path against injection ---

function sanitizePath(filePath) {
  // Strip control chars (including null), bidi overrides, and newlines
  let sanitized = '';
  for (const char of String(filePath || '')) {
    const code = char.codePointAt(0);
    const isAsciiControl = code <= 0x1f || code === 0x7f;
    const isBidiOverride = (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    sanitized += isAsciiControl || isBidiOverride ? ' ' : char;
  }
  return sanitized.trim().slice(0, 500);
}

function normalizeForMatch(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .toLowerCase();
}

// The settings file of the harness the gate runs under, Claude Code's or
// Gemini CLI's (`.claude/settings.json`, `.gemini/settings.local.json`,
// ...): an edit there is how the hook itself is configured or disabled, so
// it is never gated. Nothing else under those directories is exempt.
function isClaudeSettingsPath(filePath) {
  const normalized = normalizeForMatch(filePath);
  return /(^|\/)\.(?:claude|gemini)\/settings(?:\.[^/]+)?\.json$/.test(normalized);
}

const SAFE_GIT_SUBCOMMANDS = {
  status: (args) => args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg)),
  diff: (args) => args.length <= 1 && args.every(arg => ['--name-only', '--name-status'].includes(arg)),
  log: (args) => args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg)),
  show: (args) => args.length === 1 && !args[0].startsWith('--') && /^[a-zA-Z0-9._:/-]+$/.test(args[0]),
  branch: (args) => args.length === 1 && args[0] === '--show-current',
  'rev-parse': (args) => args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]),
};

function isReadOnlyGitIntrospection(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'git' || tokens.length < 2) return false;

  const checker = SAFE_GIT_SUBCOMMANDS[tokens[1].toLowerCase()];
  return checker ? checker(tokens.slice(2)) : false;
}

// --- Gate messages ---

// A document has readers, not importers. Asking a note or a piece of
// documentation which files require it, and which public functions it
// exports, spends a round on questions that have no answer and teaches
// whoever reads the gate that it is not paying attention.
const PROSE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.org']);

function isProseFile(filePath) {
  return PROSE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function gateMsg(action, filePath, questions) {
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before ${action} ${sanitizePath(filePath)}, present these facts:`,
    '',
    ...questions,
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function editGateMsg(filePath) {
  if (isProseFile(filePath)) {
    return gateMsg('editing', filePath, [
      '1. Say what this document is for and who reads it',
      '2. Say what changes in it and why it changes now',
      "3. Quote the user's current instruction verbatim"
    ]);
  }
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before editing ${safe}, present these facts:`,
    '',
    '1. List ALL files that import/require this file (use Grep)',
    '2. List the public functions/classes affected by this change',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function writeGateMsg(filePath) {
  if (isProseFile(filePath)) {
    return gateMsg('creating', filePath, [
      '1. Say what this document is for and who reads it',
      '2. Confirm no existing document already covers it (use Glob)',
      '3. Say where it will be linked from, or that it stands on its own',
      "4. Quote the user's current instruction verbatim"
    ]);
  }
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before creating ${safe}, present these facts:`,
    '',
    '1. Name the file(s) and line(s) that will call this new file',
    '2. Confirm no existing file serves the same purpose (use Glob)',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function destructiveBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Destructive command detected. Before running, present:',
    '',
    '1. List all files/data this command will modify or delete',
    '2. Write a one-line rollback procedure',
    "3. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function routineBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Before the first Bash command this session, present these facts:',
    '',
    '1. The current user request in one sentence',
    '2. What this specific command verifies or produces',
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function withRecoveryHint(message, hookIds = [EDIT_WRITE_HOOK_ID]) {
  const disableTargets = hookIds.map(hookId => `\`${hookId}\``).join(' or ');
  return [
    message,
    '',
    `Recovery: a human doing setup or repair work can lift this gate by adding ${disableTargets} to \`EGC_DISABLED_HOOKS\`.`
  ].join('\n');
}

// --- Deny helper ---

function denyResult(reason, options = {}) {
  const includeRecoveryHint = options.includeRecoveryHint !== false;
  const hookIds = Array.isArray(options.hookIds) && options.hookIds.length > 0 ? options.hookIds : [EDIT_WRITE_HOOK_ID];
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: includeRecoveryHint ? withRecoveryHint(reason, hookIds) : reason
      }
    }),
    exitCode: 0
  };
}

function allowWithStateWarning() {
  return {
    stderr: '[Fact-Forcing Gate] GateGuard state could not be persisted; allowing this operation to avoid a permanent retry loop. Check GATEGUARD_STATE_DIR or filesystem permissions.',
    exitCode: 0
  };
}

const { trace } = require('../lib/utils');
const { splitShellSegments, extractSubstitutionBodies } = require('../lib/shell-split');
const { WRAPPER_SPECS, readWrapperOption } = require('../lib/wrapper-options');

// --- Per-tool gate handlers ---

/**
 * Handle the Edit or Write tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleEditWrite(rawInput, toolName, toolInput) {
  const filePath = toolInput.file_path || '';
  if (!filePath || isClaudeSettingsPath(filePath)) {
    trace('governance:allowed:settings', { toolName, filePath });
    return rawInput;
  }

  if (!isChecked(filePath)) {
    if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
      trace('governance:allowed:state_error', { toolName, filePath });
      return allowWithStateWarning();
    }
    trace('governance:denied:fact_force', { toolName, filePath });
    return denyResult(toolName === 'Edit' ? editGateMsg(filePath) : writeGateMsg(filePath));
  }
  const refused = refuseUnpresentedFacts(filePath, [path.basename(filePath)], { toolName, filePath }, { anchorTerms: [sanitizePath(filePath)], target: sanitizePath(filePath) });
  if (refused) return refused;
  trace('governance:allowed:checked', { toolName, filePath });
  return rawInput;
}

/**
 * Handle the MultiEdit tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleMultiEdit(rawInput, toolName, toolInput) {
  const edits = toolInput.edits || [];
  for (const edit of edits) {
    const filePath = edit.file_path || '';
    if (!filePath || isClaudeSettingsPath(filePath)) continue;
    if (!isChecked(filePath)) {
      if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
        trace('governance:allowed:state_error', { toolName, filePath });
        return allowWithStateWarning();
      }
      trace('governance:denied:fact_force', { toolName, filePath });
      return denyResult(editGateMsg(filePath));
    }
    const refused = refuseUnpresentedFacts(filePath, [path.basename(filePath)], { toolName, filePath }, { anchorTerms: [sanitizePath(filePath)], target: sanitizePath(filePath) });
    if (refused) return refused;
  }
  trace('governance:allowed:multiedit');
  return rawInput;
}

/**
 * Extract file paths touched by a Codex `apply_patch` freeform patch.
 *
 * Codex's apply_patch tool is a single freeform-text argument (a patch in
 * `*** Begin Patch` / `*** Update File: <path>` / `*** End Patch` format),
 * not a JSON object with a file_path field like Claude's Edit/Write. Parse
 * the patch header lines to recover the path(s) it touches so the same
 * fact-forcing gate can apply per file.
 *
 * @param {string} patchText
 * @returns {string[]}
 */
function extractApplyPatchFilePaths(patchText) {
  const text = String(patchText || '');
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  const paths = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

/**
 * Handle the Codex `apply_patch` tool gate (freeform patch text, may touch
 * multiple files in one call, so this mirrors handleMultiEdit's loop).
 *
 * @param {string} rawInput
 * @param {*} rawPatchInput
 * @returns {*}
 */
function handleApplyPatch(rawInput, rawPatchInput) {
  const patchText = typeof rawPatchInput === 'string' ? rawPatchInput : '';
  const filePaths = extractApplyPatchFilePaths(patchText);
  if (filePaths.length === 0) {
    trace('governance:allowed:apply_patch_unparsed');
    return rawInput;
  }

  for (const filePath of filePaths) {
    if (isClaudeSettingsPath(filePath) || isChecked(filePath)) {
      continue;
    }
    if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
      trace('governance:allowed:state_error', { toolName: 'apply_patch', filePath });
      return allowWithStateWarning();
    }
    trace('governance:denied:fact_force', { toolName: 'apply_patch', filePath });
    return denyResult(editGateMsg(filePath));
  }

  trace('governance:allowed:apply_patch');
  return rawInput;
}

/**
 * Handle the Bash tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleBash(rawInput, toolName, toolInput) {
  const command = toolInput.command || '';
  if (isReadOnlyGitIntrospection(command)) {
    trace('governance:allowed:git_intro', { command });
    return rawInput;
  }

  if (isDestructiveBash(command)) {
    const key = '__destructive__' + crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
    if (!isChecked(key)) {
      if (!markChecked(key) || !markChecked(pendingKey(key))) {
        trace('governance:allowed:state_error', { toolName, command });
        return allowWithStateWarning();
      }
      trace('governance:denied:destructive', { command });
      return denyResult(destructiveBashMsg(), { includeRecoveryHint: false });
    }
    const refused = refuseUnpresentedFacts(key, ['rollback', commandWord(command)], { command }, { anchorTerms: DESTRUCTIVE_ANCHORS, target: 'this command' });
    if (refused) return refused;
    trace('governance:allowed:destructive_retry', { command });
    return rawInput;
  }

  if (!isChecked(ROUTINE_BASH_SESSION_KEY)) {
    if (!markChecked(ROUTINE_BASH_SESSION_KEY)) {
      trace('governance:allowed:state_error', { toolName, command });
      return allowWithStateWarning();
    }
    trace('governance:denied:routine_bash', { command });
    return denyResult(routineBashMsg(), { hookIds: [BASH_HOOK_ID] });
  }

  trace('governance:allowed:bash', { command });
  return rawInput;
}

// --- Core logic (exported for run-with-flags.js) ---

function run(rawInput) {
  let data;
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch (_) { // NOSONAR: parse failure allows the command through by design
    return rawInput; // allow on parse error
  }

  if (isGateGuardDisabled()) {
    trace('governance:disabled');
    return rawInput;
  }

  activeStateFile = null;
  hookInput = data;
  getStateFile(data);

  const rawToolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  // Normalize: case-insensitive matching via lookup map.
  // apply_patch is Codex CLI's canonical tool name for file edits (its
  // freeform patch tool); Edit/Write/MultiEdit are only matcher aliases on
  // the Codex side, the payload's tool_name stays "apply_patch".
  const TOOL_MAP = { edit: 'Edit', write: 'Write', multiedit: 'MultiEdit', bash: 'Bash', apply_patch: 'ApplyPatch' };
  const toolName = TOOL_MAP[rawToolName.toLowerCase()] || rawToolName;

  if (toolName === 'Edit' || toolName === 'Write') {
    return handleEditWrite(rawInput, toolName, toolInput);
  }

  if (toolName === 'MultiEdit') {
    return handleMultiEdit(rawInput, toolName, toolInput);
  }

  if (toolName === 'ApplyPatch') {
    return handleApplyPatch(rawInput, data.tool_input);
  }

  if (toolName === 'Bash') {
    return handleBash(rawInput, toolName, toolInput);
  }

  return rawInput; // allow
}

module.exports = { run };

// --- Direct CLI entrypoint ---
//
// Claude Code invokes PreToolUse hook scripts directly (`node <script>.js`
// with the tool-call JSON on stdin), unlike Gemini's run-with-flags.js or
// bash-hook-dispatcher.js, which both require() and call run() in-process.
// This block only executes when the file is run as a standalone process, so
// it does not change behavior for either of those existing callers.
if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const output = run(raw);

    if (typeof output === 'string' || Buffer.isBuffer(output)) {
      process.stdout.write(String(output));
      process.exit(0);
    }

    if (output && typeof output === 'object') {
      if (typeof output.stderr === 'string' && output.stderr) {
        process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
      }

      if (Object.hasOwn(output, 'stdout')) {
        process.stdout.write(String(output.stdout ?? ''));
      } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
        process.stdout.write(raw);
      }

      process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
    }

    process.stdout.write(raw);
    process.exit(0);
  });
}
