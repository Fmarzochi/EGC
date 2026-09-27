'use strict';

/**
 * The variables a shell command fixes on its way, and every value a command
 * word taken from an expansion can stand for once the shell expands it.
 *
 * A command word such as `$X`, `${X:-vi}` or `$(which rm)` names the program
 * the shell runs only after expansion, so the Bash hook judges the segment
 * once for each value the word can take: every literal the command sets the
 * variable to anywhere on the line (the shell runs a line in an order and
 * along branches the hook does not follow, so all of them count), the value
 * the environment holds, and no value at all, in which case an unquoted word
 * vanishes and the next word becomes the command. A value the hook cannot
 * read (`read X`, `X=$(cmd)`, `X+=...`, an array, `printf -v X`) leaves the
 * word unknown, and the caller fails closed on it.
 */

const NAME_RE = /^[A-Za-z_]\w*$/;
const ASSIGNMENT_RE = /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?)=(.*)$/s;
const DEFAULT_ASSIGN_RE = /\$\{([A-Za-z_]\w*):?=/g;
const DECLARATIONS = new Set(['declare', 'typeset', 'local', 'readonly', 'export']);
const SOURCERS = new Set(['source', '.']);
const LOOKUP_COMMANDS = new Set(['which', 'command', 'type']);
const READ_VALUE_FLAGS = 'dinNptu';
const MAPFILE_VALUE_FLAGS = 'dnOsuCc';
// A word whose expansion can take more combined values than this is not
// spelled out; the caller fails closed on it instead.
const MAX_CHOICES = 64;
const IFS_WHITESPACE = /[ \t\n]+/;

function emptyBindings() {
  return { names: new Map(), sources: false, dynamic: false, ifs: false };
}

function entryOf(bindings, name) {
  if (!bindings.names.has(name)) bindings.names.set(name, { values: new Set(), opaque: false });
  return bindings.names.get(name);
}

// IFS decides how an unquoted expansion splits; set as a prefix of another
// command (`IFS=, read ...`) it holds for that command only.
function noteIfs(bindings, name, prefix) {
  if (name === 'IFS' && !prefix) bindings.ifs = true;
}

function addValue(bindings, name, value, prefix = false) {
  entryOf(bindings, name).values.add(value);
  noteIfs(bindings, name, prefix);
}

function markOpaque(bindings, name, prefix = false) {
  entryOf(bindings, name).opaque = true;
  noteIfs(bindings, name, prefix);
}

// A name the builtin takes from an expansion (`read "$VAR"`) can be any
// variable.
function noteTarget(bindings, name) {
  if (NAME_RE.test(name ?? '')) markOpaque(bindings, name);
  else if (/[$`]/.test(name ?? '')) bindings.dynamic = true;
}

// A word the shell hands over exactly as written: nothing in it expands.
function isPlain(word) {
  return !word.expands && !word.globbed && !/[$`]/.test(word.value);
}

// `NAME=value`, `NAME+=value`, `NAME[i]=value` or `NAME=(...)` anywhere in a
// segment: a literal value is a value the name can take; appending, an array
// or a value that expands is one the hook cannot read.
function noteAssignment(bindings, word, segment, opaqueOnly, prefix = false) {
  const assignment = ASSIGNMENT_RE.exec(word.value);
  if (!assignment) return;
  const [, name, index, append, value] = assignment;
  const array = value === '' && segment[word.end] === '(';
  if (opaqueOnly || index || append || array || !isPlain(word)) markOpaque(bindings, name, prefix);
  else addValue(bindings, name, value, prefix);
}

// `for NAME in items`: each literal item is a value; `for NAME` without a
// list walks the positional parameters, and `select` takes what is typed.
function noteLoops(bindings, words) {
  for (let i = 0; i < words.length - 1; i += 1) {
    const head = words[i].value;
    const name = words[i + 1].value;
    if ((head !== 'for' && head !== 'select') || !NAME_RE.test(name)) continue;
    if (head === 'select' || words[i + 2]?.value !== 'in') {
      markOpaque(bindings, name);
      continue;
    }
    for (const item of words.slice(i + 3)) {
      if (isPlain(item)) addValue(bindings, name, item.value);
      else markOpaque(bindings, name);
    }
  }
}

// The words after a builtin's options, read the way the builtin reads them:
// a letter in `valueFlags` takes the rest of its bundle or the next word as
// its value; `onValue` sees each letter with the value it took.
function operandsAfterOptions(words, start, valueFlags, onValue) {
  let i = start;
  while (i < words.length && /^-./.test(words[i].value)) {
    const option = words[i].value;
    i += 1;
    if (option === '--') break;
    for (let at = 1; at < option.length; at += 1) {
      if (!valueFlags.includes(option[at])) continue;
      const attached = option.slice(at + 1);
      const value = attached === '' ? words[i]?.value : attached;
      if (attached === '') i += 1;
      onValue(option[at], value);
      break;
    }
  }
  return words.slice(i).map(word => word.value);
}

function noteRead(bindings, words, at) {
  const names = operandsAfterOptions(words, at + 1, `${READ_VALUE_FLAGS}a`, (flag, value) => {
    if (flag === 'a') noteTarget(bindings, value);
  });
  for (const name of names.length > 0 ? names : ['REPLY']) noteTarget(bindings, name);
}

function noteMapfile(bindings, words, at) {
  const names = operandsAfterOptions(words, at + 1, MAPFILE_VALUE_FLAGS, () => {});
  noteTarget(bindings, names[0] ?? 'MAPFILE');
}

function notePrintf(bindings, words, at) {
  operandsAfterOptions(words, at + 1, 'v', (flag, value) => {
    if (NAME_RE.test(value ?? '')) markOpaque(bindings, value);
    else bindings.dynamic = true;
  });
}

// A declaration with options (`declare -n`, `local -a`) can make a name a
// reference or an array; a name built at run time can be any variable.
function noteDeclaration(bindings, words, at, segment) {
  const rest = words.slice(at + 1);
  const withOptions = rest.some(word => /^[-+]/.test(word.value));
  for (const word of rest) {
    if (ASSIGNMENT_RE.test(word.value)) noteAssignment(bindings, word, segment, withOptions);
    else if (!isPlain(word)) bindings.dynamic = true;
  }
}

const BUILTIN_NOTES = {
  read: noteRead,
  mapfile: noteMapfile,
  readarray: noteMapfile,
  printf: notePrintf,
  getopts: (bindings, words, at) => noteTarget(bindings, words[at + 2]?.value),
};

function noteBuiltin(bindings, words, at, segment) {
  const name = words[at]?.value.split(/[\\/]/).pop();
  if (name === undefined) return;
  if (SOURCERS.has(name) && words.length > at + 1) bindings.sources = true;
  if (DECLARATIONS.has(name)) noteDeclaration(bindings, words, at, segment);
  else if (Object.hasOwn(BUILTIN_NOTES, name)) BUILTIN_NOTES[name](bindings, words, at);
}

/**
 * The variables these segments fix. `entries` holds, per segment, its text,
 * its shell words and the index of its command word. Every assignment on the
 * line counts, wherever it stands, since the hook does not follow the order
 * or the branches the shell runs it in.
 */
function collectBindings(entries) {
  const bindings = emptyBindings();
  for (const { segment, words, commandIndex } of entries) {
    const hasCommand = commandIndex < words.length;
    words.forEach((word, index) => noteAssignment(bindings, word, segment, false, hasCommand && index < commandIndex));
    noteLoops(bindings, words);
    noteBuiltin(bindings, words, commandIndex, segment);
    for (const match of segment.matchAll(DEFAULT_ASSIGN_RE)) markOpaque(bindings, match[1]);
  }
  return bindings;
}

function mergeBindings(first, second) {
  const merged = emptyBindings();
  merged.sources = first.sources || second.sources;
  merged.dynamic = first.dynamic || second.dynamic;
  merged.ifs = first.ifs || second.ifs;
  for (const source of [first, second]) {
    for (const [name, entry] of source.names) {
      const target = entryOf(merged, name);
      target.opaque = target.opaque || entry.opaque;
      for (const value of entry.values) target.values.add(value);
    }
  }
  return merged;
}

/**
 * What `$NAME` can stand for: the literals the command fixes, the value the
 * environment holds, and nothing (unset). Null when the hook cannot read it:
 * the command fixes it from a source it cannot see, or builds variable names
 * at run time or sources a script, either of which can set any name.
 */
function valuesOf(bindings, name, env) {
  const entry = bindings.names.get(name);
  if (entry?.opaque || bindings.sources || bindings.dynamic) return null;
  const values = new Set(entry?.values ?? []);
  if (typeof env[name] === 'string') values.add(env[name]);
  values.add('');
  return [...values];
}

// The index of the character that closes the construct opened just before
// `start`, counting nested openers and skipping quoted text; -1 when it
// never closes.
function closingIndex(text, start, open, close) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") i += 1;
    else if (quote) quote = ch === quote ? null : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

// `which rm`, `command -v rm`, `type -P rm`: the output names that program
// (or nothing, when it is not found).
function lookedUpName(body) {
  const words = body.trim().split(/\s+/);
  if (!LOOKUP_COMMANDS.has(words[0])) return null;
  const operands = words.slice(1).filter(word => !word.startsWith('-'));
  const plainLookup = words[0] === 'which' || words.slice(1).some(word => /^-[vpP]+$/.test(word));
  return plainLookup && operands.length === 1 && /^[\w.+-]+$/.test(operands[0]) ? operands[0] : null;
}

const PARAMETER_OPERATORS = {
  ':-': (value, word) => [value === '' ? word : value],
  ':=': (value, word) => [value === '' ? word : value],
  '-': (value, word) => (value === '' ? [word, ''] : [value]),
  '=': (value, word) => (value === '' ? [word, ''] : [value]),
  ':+': (value, word) => [value === '' ? '' : word],
  '+': (value, word) => (value === '' ? ['', word] : [word]),
  ':?': value => (value === '' ? [] : [value]),
  '?': value => [value],
};
const PARAMETER_RE = /^([A-Za-z_]\w*)(?:(:?[-=+?])(.*))?$/s;

// The values a `${...}` expansion can take: a plain reference, or one with a
// default, alternative or error operator and a literal word.
function parameterValues(inner, lookup) {
  const match = PARAMETER_RE.exec(inner);
  if (!match) return null;
  const [, name, operator, word] = match;
  const values = lookup(name);
  if (values === null) return null;
  if (operator === undefined) return values;
  if (/[$`'"\\]/.test(word)) return null;
  return [...new Set(values.flatMap(value => PARAMETER_OPERATORS[operator](value, word)))];
}

// A command substitution's values: the program a lookup names, or null.
function substitutionValues(body) {
  const name = lookedUpName(body);
  return name === null ? null : [name, ''];
}

// One expansion of the word starting at `at` (a `$` or a backquote): its
// values, or null when the hook cannot read them, and where it ends.
function expansionAt(raw, at, lookup) {
  if (raw[at] === '`') {
    const end = raw.indexOf('`', at + 1);
    if (end === -1) return { values: null, end: raw.length };
    return { values: substitutionValues(raw.slice(at + 1, end)), end: end + 1 };
  }
  const next = raw[at + 1];
  if (next === '(') {
    const end = closingIndex(raw, at + 2, '(', ')');
    if (end === -1 || raw[at + 2] === '(') return { values: null, end: end === -1 ? raw.length : end + 1 };
    return { values: substitutionValues(raw.slice(at + 2, end)), end: end + 1 };
  }
  if (next === '{') {
    const end = closingIndex(raw, at + 2, '{', '}');
    if (end === -1) return { values: null, end: raw.length };
    return { values: parameterValues(raw.slice(at + 2, end), lookup), end: end + 1 };
  }
  const name = /^[A-Za-z_]\w*/.exec(raw.slice(at + 1))?.[0];
  if (name) return { values: lookup(name), end: at + 1 + name.length };
  if (next !== undefined && /[\d@*#?$!'"-]/.test(next)) return { values: null, end: at + 2 };
  return { literal: '$', end: at + 1 };
}

// The text a backslash stands for: inside double quotes it escapes only
// $ ` " \ and a newline, elsewhere any character; a backslash-newline is a
// line continuation and stands for nothing.
function escapedText(escaped, quoted) {
  if (escaped === '\n') return '';
  return quoted && !'$`"\\'.includes(escaped) ? `\\${escaped}` : escaped;
}

function flushText(state) {
  if (state.text !== '') state.parts.push({ values: [state.text], literal: true, quoted: true });
  state.text = '';
}

// One step through the word from `i`: the text or expansion there, added to
// `state`; returns where the next step starts.
function wordStep(raw, i, state, lookup) {
  const ch = raw[i];
  if (!state.quoted && ch === "'") {
    const end = raw.indexOf("'", i + 1);
    state.text += raw.slice(i + 1, end === -1 ? raw.length : end);
    return end === -1 ? raw.length : end + 1;
  }
  if (ch === '"') {
    state.quoted = !state.quoted;
    return i + 1;
  }
  if (ch === '\\') {
    state.text += escapedText(raw[i + 1] ?? '', state.quoted);
    return i + 2;
  }
  if (ch !== '$' && ch !== '`') {
    state.text += ch;
    return i + 1;
  }
  const expansion = expansionAt(raw, i, lookup);
  if (expansion.literal === undefined) {
    flushText(state);
    state.parts.push({ values: expansion.values, literal: false, quoted: state.quoted });
  } else {
    state.text += expansion.literal;
  }
  return expansion.end;
}

// The word split into literal text and expansions, each expansion marked
// quoted when it sits inside double quotes (the shell neither splits nor
// drops it there).
function wordParts(raw, lookup) {
  const state = { parts: [], quoted: false, text: '' };
  let i = 0;
  while (i < raw.length) i = wordStep(raw, i, state, lookup);
  flushText(state);
  return { parts: state.parts, hasQuotes: /["']/.test(raw) };
}

// The fields one combination of values makes: an unquoted expansion is split
// on blanks, and a word that comes out empty with no quotes in it is dropped.
function fieldsOf(parts, pick, hasQuotes) {
  const fields = [];
  let current = '';
  let started = hasQuotes;
  const push = () => {
    if (current !== '' || started) fields.push(current);
    current = '';
    started = false;
  };
  parts.forEach((part, index) => {
    const value = pick[index];
    if (part.literal || part.quoted) {
      current += value;
      started = started || part.quoted;
      return;
    }
    value.split(IFS_WHITESPACE).forEach((piece, at) => {
      if (at > 0) push();
      current += piece;
    });
  });
  push();
  return fields;
}

function combinations(parts) {
  let picks = [[]];
  for (const part of parts) {
    picks = picks.flatMap(pick => part.values.map(value => [...pick, value]));
    if (picks.length > MAX_CHOICES) return null;
  }
  return picks;
}

// A word whose unknown part cannot reach its last path component: every
// expansion in it is quoted (so nothing splits) and the text after the final
// `/` is literal, which is the name the validator judges.
function keepsLiteralName(parts) {
  if (parts.some(part => !part.literal && !part.quoted)) return false;
  const last = parts.at(-1);
  const text = last?.literal ? last.values[0] : '';
  const slash = text.lastIndexOf('/');
  return slash !== -1 && /^[\w.+-]+$/.test(text.slice(slash + 1));
}

/**
 * What a command word that expands can become, given `lookup(name)` for the
 * values of a variable (null when unreadable): `{ choices }`, each choice the
 * list of fields the word turns into (none when it vanishes); `{ keep }` when
 * only its literal last path component names the program; `{ unknown }` with
 * a reason otherwise. `ifsBound` says the command sets IFS, which decides how
 * an unquoted expansion splits.
 */
function commandWordChoices(raw, lookup, ifsBound = false) {
  const { parts, hasQuotes } = wordParts(raw, lookup);
  if (parts.some(part => part.values === null)) {
    return keepsLiteralName(parts) ? { keep: true } : { unknown: 'its value cannot be read by this hook' };
  }
  const unquoted = parts.filter(part => !part.literal && !part.quoted);
  if (unquoted.length > 0 && ifsBound) return { unknown: 'the command sets IFS, which decides how it splits' };
  if (unquoted.some(part => part.values.some(value => /[*?[]/.test(value)))) {
    return { unknown: 'it can expand to a pattern the shell matches against file names' };
  }
  const picks = combinations(parts);
  if (picks === null) return { unknown: `it can take more than ${MAX_CHOICES} values` };
  const seen = new Set();
  const choices = [];
  for (const pick of picks) {
    const fields = fieldsOf(parts, pick, hasQuotes);
    const key = JSON.stringify(fields);
    if (!seen.has(key)) {
      seen.add(key);
      choices.push(fields);
    }
  }
  return { choices };
}

const QUOTE_IN_QUOTES = String.raw`'\''`;

// A word single-quoted, so the shell reads it back as that one word.
function singleQuoted(value) {
  return `'${value.replaceAll("'", QUOTE_IN_QUOTES)}'`;
}

// A field spelled so the validator reads back exactly that word.
function quoteField(field) {
  return /^[\w./:@%+,=-]+$/.test(field) ? field : singleQuoted(field);
}

module.exports = { collectBindings, mergeBindings, valuesOf, commandWordChoices, quoteField, singleQuoted, emptyBindings };
