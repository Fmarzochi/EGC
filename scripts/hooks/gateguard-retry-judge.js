'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { trace } = require('../lib/utils');
const { pendingKey, presentedKey, isChecked, markChecked } = require('./gateguard-state');
const { denyResult } = require('./gateguard-gate-rules');

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

// The hook input of the current call, kept for the transcript lookup.
let hookInput = null;

function setHookInput(data) {
  hookInput = data;
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

// The retry-judging slice of the gateguard-fact-force.js split (part of
// #1712): whether the message before a retry actually carries the facts the
// gate demanded, read from the harness transcript, moved as is.
module.exports = {
  setHookInput,
  refuseUnpresentedFacts,
};
