'use strict';

// Walks a command line (and, recursively, the scripts it runs): resolves
// variable expansions in command words, re-reads eval/heredoc/-c code as
// further segments, tracks shell-variable bindings and HOME across that
// walk, and resolves cd targets and script positionals along the way.
// Part of the pre-bash-guardian-validate.js split (#1712).

const path = require('node:path');
const os = require('node:os');
const { commandName } = require('../lib/wrapper-options');
const { splitShellSegments } = require('../lib/shell-split');
const { collectBindings, mergeBindings, valuesOf, commandWordChoices, quoteField } = require('../lib/shell-bindings');
const { startCwd, afterMove, CWD_CHANGERS } = require('../lib/shell-cwd');
const { shellWords } = require('./pre-bash-guardian-shell-words');
const { skipEnvAndWrappers } = require('./pre-bash-guardian-wrapper-walk');
const { expandedOperandValue, scriptRelative, writesOf, scriptOperandsOf, nestedSegmentsOf, isCommittedUnchanged, SCRIPT_DIR_IDIOMS } = require('./pre-bash-guardian-script-files');
const { joinContinuations, pipelineStages, splitHeredoc, readsItsInputAsCode, literalHeredoc, inlineCodeWords, segmentsOfStage, extractSegments, literalWords } = require('./pre-bash-guardian-segmentation');

const HOME_CHANGERS = new Set(['unset', 'read', 'printf', 'declare', 'typeset', 'local', 'readonly', 'export', 'mapfile', 'readarray']);

// Whether a segment may set or clear HOME: an assignment to it, a builtin
// that sets it by name, or a name reference that could alias it. The code
// an eval runs is read as segments of its own, and a sourced script is
// read for the same (see scriptSegmentsOf). After such a segment, ~ and
// $HOME no longer name the home directory this hook knows.
function changesHome(segment) {
  const words = shellWords(segment).map(word => word.value);
  if (words.some(word => /^HOME\+?=/.test(word))) return true;
  if (['declare', 'typeset', 'local'].some(word => words.includes(word)) && words.some(word => /^-[A-Za-z]*n/.test(word))) return true;
  return words.includes('HOME') && words.some(word => HOME_CHANGERS.has(word));
}

// Variables a script sets to its own directory, spelled as above.
function scriptDirVariables(segments) {
  const names = new Set();
  for (const segment of segments) {
    for (const word of shellWords(segment)) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.value);
      if (assignment && SCRIPT_DIR_IDIOMS.includes(assignment[2].replaceAll(/\s+/g, ' '))) names.add(assignment[1]);
    }
  }
  return names;
}

// The variables these segments fix (scripts/lib/shell-bindings.js).
function bindingsOfSegments(segments) {
  return collectBindings(segments.map(segment => {
    const words = shellWords(segment);
    return { segment, words, commandIndex: skipEnvAndWrappers(words) };
  }));
}

// Variables the command fixes to literal filenames, and so can be followed to
// the scripts they name, with the value the environment holds, which the
// shell may still use where the line does not fix the variable first (a
// file it names that is not there only fails to run); a variable fixed from
// a source this hook cannot read is left out, so `bash "$VAR"` for it still
// fails closed.
function scriptVarsOf(bindings) {
  const values = new Map();
  for (const [name, entry] of bindings.names) {
    if (entry.opaque || entry.values.size === 0) continue;
    const fixed = [...entry.values].filter(value => value !== '').map(value => ({ value, optional: false }));
    const env = process.env[name];
    const fromEnv = typeof env === 'string' && env !== '' && !entry.values.has(env) ? [{ value: env, optional: true }] : [];
    values.set(name, [...fixed, ...fromEnv]);
  }
  return values;
}

// Each segment whose command word expands is judged as written and once per
// value the word can take (X=rm; $X -rf / is also judged as rm -rf /, and an
// empty $X hands the command to the next word). A word whose value this hook
// cannot read fails closed when `unknownFails`, and is left as it is
// otherwise (a committed script, held only to the grave denials).
const MAX_WORD_ROUNDS = 4;

function commandWordVariants(segment, context, round) {
  const words = shellWords(segment);
  const cmd = words[skipEnvAndWrappers(words)];
  if (!cmd?.expands || cmd.start === undefined) return { segments: [segment] };
  const raw = segment.slice(cmd.start, cmd.end);
  const outcome = commandWordChoices(raw, context.lookup, context.ifsBound, context.positional);
  if (outcome.keep) return { segments: [segment] };
  if (outcome.unknown) {
    return { blocked: `the command name comes from ${raw}, which the command sets from a source this hook cannot read or which only the shell knows when it runs (${outcome.unknown}); run it by its real name, or quote the expansion when only a literal file name follows it` };
  }
  if (round >= MAX_WORD_ROUNDS) return { blocked: `the command name comes from ${raw}, which expands into further expansions than this hook follows; run it by its real name` };
  const variants = [];
  for (const fields of outcome.choices) {
    const variant = (segment.slice(0, cmd.start) + fields.map(quoteField).join(' ') + segment.slice(cmd.end)).trim();
    if (variant === '') continue;
    const next = commandWordVariants(variant, context, round + 1);
    if (next.blocked) return next;
    variants.push(...next.segments);
  }
  return { segments: [...new Set(variants)] };
}

const NESTED_TOO_DEEP = 'a command it runs nests command/process substitutions deeper than this validator can safely unwrap and analyze';

function resolveCommandWords(segments, bindings, unknownFails, positional = null) {
  const context = {
    lookup: name => valuesOf(bindings, name, process.env),
    ifsBound: bindings.ifs,
    positional,
  };
  const resolved = [];
  for (const segment of segments) {
    const outcome = segmentWithVariants(segment, context, unknownFails, 0);
    if (outcome.blocked) return outcome;
    resolved.push(...outcome.segments);
  }
  return { segments: resolved };
}

// A segment with every value its command word takes, and the code each
// resolved one runs through a shell's -c or eval (`S=sh; $S -c '...'` runs
// that code as `sh -c` does), resolved in turn.
function segmentWithVariants(segment, context, unknownFails, depth) {
  const outcome = commandWordVariants(segment, context, 0);
  if (outcome.blocked && unknownFails) return { blocked: outcome.blocked };
  const found = [segment];
  for (const variant of outcome.segments ?? []) {
    if (variant === segment) continue;
    const stage = segmentsOfStage(variant, depth);
    if (stage === null) return { blocked: NESTED_TOO_DEEP };
    found.push(variant);
    for (const code of stage.slice(1)) {
      const inner = segmentWithVariants(code, context, unknownFails, depth + 1);
      if (inner.blocked) return inner;
      found.push(...inner.segments);
    }
  }
  return { segments: [...new Set(found)] };
}

// Code a shell reads only after this line's own shell has expanded it: the
// body of a heredoc with an unquoted delimiter that a shell reads, and the
// code of -c or eval in a word that expands. The value a variable takes
// there is read as code a second time, which one reading of the line misses.
function expandedCodes(text) {
  const codes = [];
  for (const stage of splitShellSegments(joinContinuations(text), { stripComments: true }).flatMap(pipelineStages)) {
    const { command: line, body } = splitHeredoc(stage);
    if (body !== null && readsItsInputAsCode(line) && !literalHeredoc(line, body)) codes.push(body);
    const inline = expandedInlineCode(line);
    if (inline !== null) codes.push(inline);
  }
  return codes;
}

// The code of -c or eval as the line's own shell hands it over, when a word
// of it expands: the -c operand as written, its $1 and on left alone, since
// the shell running the code expands those without reading them as code.
function expandedInlineCode(line) {
  const carrier = inlineCodeWords(line);
  if (carrier === null) return null;
  if (carrier.evaluated) return carrier.words.some(word => word.expands) ? carrier.words.map(word => word.value).join(' ') : null;
  return carrier.words[0].expands ? carrier.words[0].value : null;
}

const MAX_SECOND_READINGS = 64;
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /\w/;

// Whether the character at `at` is escaped by the backslashes before it.
function escapedAt(text, at) {
  let count = 0;
  while (at - count > 0 && text[at - count - 1] === '\\') count += 1;
  return count % 2 === 1;
}

// The variable a `$` at `at` reads, as { name, operator, end }: $NAME or
// ${NAME...}, the operator being whatever follows the name inside the
// braces; null for anything else ($1, $?, $(...), an escaped $).
function referenceAt(text, at) {
  if (escapedAt(text, at)) return null;
  const braced = text[at + 1] === '{';
  let end = at + (braced ? 2 : 1);
  if (!NAME_START.test(text[end] ?? '')) return null;
  const start = end;
  while (end < text.length && NAME_PART.test(text[end])) end += 1;
  const name = text.slice(start, end);
  if (!braced) return { name, operator: '', end };
  const close = text.indexOf('}', end);
  if (close === -1) return null;
  return { name, operator: text.slice(end, close), end: close + 1 };
}

// Every variable reference the code holds, in order, as referenceAt tells.
function variableReferences(code) {
  const references = [];
  for (let at = code.indexOf('$'); at !== -1; at = code.indexOf('$', at + 1)) {
    const reference = referenceAt(code, at);
    if (reference) references.push({ ...reference, start: at });
  }
  return references;
}

// The ${NAME...} operators this hook follows: those that fall back to their
// word (-, =, ?) and the one that swaps it in (+), each with or without :.
const FALLBACK_OPERATOR_RE = /^:?([-=?+])/;
const referenceKey = ({ name, operator }) => `${name}${operator}`;

// The values one reference takes the second time the code is read: those
// the line gives the variable (every name counts as given once the line
// sources a script or builds a name at run time), or the environment's own
// value for a name the line leaves to it; null when there is nothing to
// read again; the reason it cannot be read otherwise.
function referenceValues(reference, bindings, unknownFails) {
  const { name, operator } = reference;
  if (!bindings.names.has(name) && !bindings.sources && !bindings.dynamic) {
    const env = process.env[name];
    return typeof env === 'string' && !operator ? { values: [env] } : null;
  }
  const own = valuesOf(bindings, name, process.env);
  if (own === null) {
    return { blocked: `the code a shell reads a second time takes $${name}, which this line sets from a source this hook cannot read; write the value out or quote the heredoc delimiter` };
  }
  return operatorValues(reference, own, unknownFails);
}

// The values a reference takes once its operator applies to the variable's.
function operatorValues({ name, operator }, own, unknownFails) {
  if (!operator) return { values: own };
  const fallback = FALLBACK_OPERATOR_RE.exec(operator);
  const word = fallback ? operator.slice(fallback[0].length) : '';
  if (fallback && !/[$`]/.test(word)) {
    if (fallback[1] === '+') return { values: [word, ''] };
    return { values: fallback[1] === '?' ? own : [...new Set([...own, word])] };
  }
  // A committed script is held to the grave denials only: the variable's
  // own values stand in for what the expansion makes of them.
  if (!unknownFails) return { values: own };
  return { blocked: `the code a shell reads a second time takes \${${name}${operator}}, an expansion this hook does not follow; write the value out or quote the heredoc delimiter` };
}

// The values each reference of the code takes, keyed by the reference.
function secondReadValues(references, bindings, unknownFails) {
  const values = new Map();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (values.has(key)) continue;
    const found = referenceValues(reference, bindings, unknownFails);
    if (found === null) continue;
    if (found.blocked) return found;
    values.set(key, found.values);
  }
  return { values };
}

// The code with each reference in `choice` replaced by its value.
function substituted(code, references, choice) {
  let text = '';
  let from = 0;
  for (const reference of references) {
    const key = referenceKey(reference);
    if (!choice.has(key)) continue;
    text += code.slice(from, reference.start) + choice.get(key);
    from = reference.end;
  }
  return text + code.slice(from);
}

// The code as the shell reads it the second time, once per combination of
// the values its references take.
function codeVariants(code, bindings, unknownFails) {
  const references = variableReferences(code);
  const found = secondReadValues(references, bindings, unknownFails);
  if (found.blocked) return found;
  let choices = [new Map()];
  for (const [key, values] of found.values) {
    choices = choices.flatMap(choice => values.map(value => new Map([...choice, [key, value]])));
    if (choices.length > MAX_SECOND_READINGS) {
      return { blocked: 'the code a shell reads a second time takes more combinations of values than this hook follows; write the values out' };
    }
  }
  const texts = choices.map(choice => substituted(code, references, choice));
  return { texts: [...new Set(texts)].filter(text => text !== code) };
}

// The segments of the code a text hands a shell to read a second time, each
// reading resolved like any segment. A value this hook cannot read fails
// closed when `unknownFails`, and is left as it is otherwise (a committed
// script, held only to the grave denials).
function secondReadings(text, bindings, unknownFails) {
  const found = [];
  for (const code of expandedCodes(text)) {
    const variants = codeVariants(code, bindings, unknownFails);
    if (variants.blocked) {
      if (unknownFails) return { blocked: variants.blocked };
      continue;
    }
    for (const variant of variants.texts) {
      const nested = extractSegments(variant, 1);
      if (nested === null) return { blocked: NESTED_TOO_DEEP };
      const resolved = resolveCommandWords(nested, bindings, unknownFails);
      if (resolved.blocked) return resolved;
      found.push(...resolved.segments);
    }
  }
  return { segments: found };
}

// Segments of every script the command runs, and for each whether it was
// read out of a committed, unchanged script. A committed script is held
// only to grave denials, so a script it runs that cannot be inspected is
// passed over there, while one the command itself names fails closed.
// What the command line itself leaves the scripts it runs to know: the
// variables it or the environment sets (a committed script cannot count
// those as its own), and no script directory.
function commandContext(segments, cwd, bindings, bound) {
  return {
    own: true,
    bound,
    cwdUnknown: null,
    cwdKnown: true,
    homeKnown: true,
    scriptDir: null,
    dirVars: new Set(),
    bindings,
    scriptVars: scriptVarsOf(bindings),
    callerSet: new Set([...Object.keys(process.env), ...assignedNames(segments)]),
    written: writesOf(segments, cwd || process.cwd(), true),
  };
}

// The command a segment runs and its arguments, after env assignments and
// wrappers.
function commandOf(segment) {
  const words = shellWords(segment);
  const index = skipEnvAndWrappers(words);
  return { name: words[index] ? commandName(words[index].value) : undefined, args: words.slice(index + 1) };
}

// Whether a CDPATH search can decide where a relative cd lands: the
// environment or the line sets one.
function cdpathSearched(context) {
  return Boolean(process.env.CDPATH) || Boolean(context.bindings?.names?.has('CDPATH'));
}

// The directories a cd target word names (see scripts/lib/shell-cwd.js);
// null when only the running shell knows them. `word` null is a bare cd,
// which goes home; `raw` is the word as the line spells it.
function cdTargetsOf(word, context, raw) {
  if (word === null) return context.homeKnown ? [os.homedir()] : null;
  if (word.globbed || word.unsure) return null;
  let targets = [word.value];
  if (word.tilde || word.expands) {
    const beside = word.expands ? scriptRelative(word.value, context) : null;
    const value = beside ?? expandedOperandValue(word, context.homeKnown);
    targets = value === null ? boundCdTargets(raw, context) : [value];
  }
  // A relative target that CDPATH may find elsewhere lands where only the
  // running shell knows.
  const searched = targets !== null && cdpathSearched(context) && targets.some(target => !path.isAbsolute(target) && !/^\.{0,2}(?:[\\/]|$)/.test(target));
  return searched ? null : targets;
}

// The directories a target word names once the shell expands it with the
// values the line gives the variables in it, and HOME for a leading ~ (see
// commandWordChoices). A variable the line does not set is one only the
// running shell knows: null then, and for any value this hook cannot read.
function boundCdTargets(raw, context) {
  const { bindings } = context;
  const lookup = name => {
    if (bindings.names.has(name)) return valuesOf(bindings, name, process.env);
    return name === 'HOME' && context.homeKnown ? [os.homedir()] : null;
  };
  const outcome = commandWordChoices(raw, lookup, bindings.ifs);
  if (!outcome.choices) return null;
  const targets = [];
  for (const fields of outcome.choices) {
    // A word that expands to nothing leaves a bare cd, which goes home; one
    // that splits into several is too many operands, and cd stays.
    if (fields.length === 0) {
      if (!context.homeKnown) return null;
      targets.push(os.homedir());
    } else if (fields.length === 1) {
      targets.push(fields[0]);
    }
  }
  return targets;
}

// Whether a sourced script, whose own commands run in its caller, has one
// that `acts` does. A script it sources in turn may bring anything; one it
// runs with a shell of its own acts only in that shell.
function actsInCaller(own, acts) {
  return own.some(segment => acts(segment) || ['source', '.'].includes(commandOf(segment).name));
}

// Where the line can be after a segment that runs a script it sources: that
// script's own cd moves the caller too, which this hook does not follow.
function sourcedMove(where, operands, own) {
  if (!operands.sources || !actsInCaller(own, segment => CWD_CHANGERS.has(commandOf(segment).name))) return where;
  return where.unknown ? where : { ...where, unknown: 'a script it sources moves the directory, which this hook does not follow' };
}

// Also gives, for each of `segments` and each segment collected from the
// scripts they run, the directories it can run in (null when only the
// running shell knows them), so each is judged there.
function scriptSegmentsOf(segments, cwd, depth, seen, context) {
  const collected = [];
  const committed = [];
  const bound = [];
  const places = [];
  const collectedPlaces = [];
  const outcome = blocked => ({ segments: collected, committed, bound, places, collectedPlaces, blocked });
  let homeKnown = context.homeKnown;
  let where = startCwd(cwd || process.cwd());
  for (const segment of segments) {
    places.push(where.unknown ? null : where.dirs);
    const here = { ...context, homeKnown, cwdKnown: context.cwdKnown && where.dirs.length === 1, cwdUnknown: context.cwdUnknown ?? where.unknown };
    const operands = scriptOperandsOf(segment, where.dirs, here);
    if (operands.blocked) return outcome(operands.blocked);
    let sourcedChangesHome = false;
    for (const { file, base, bases, args } of operands.files) {
      const found = fileSegmentsOf(file, { ...operands, base, bases, args }, depth, seen, here);
      collected.push(...found.segments);
      committed.push(...found.committed);
      bound.push(...found.bound);
      collectedPlaces.push(...found.places);
      if (found.blocked) return outcome(found.blocked);
      sourcedChangesHome = sourcedChangesHome || (operands.sources && actsInCaller(found.own, changesHome));
      where = sourcedMove(where, operands, found.own);
    }
    homeKnown = homeKnown && !changesHome(segment) && !sourcedChangesHome;
    const { name, args } = commandOf(segment);
    where = afterMove(where, name, args, word => cdTargetsOf(word, { ...here, homeKnown }, word && segment.slice(word.start, word.end)));
  }
  return outcome(null);
}

// The positional parameters a script gets from the words it is run with
// (see commandWordChoices), when this hook can read them all as written.
// Null otherwise: a word the shell expands, a script sourced without words
// of its own (it shares its caller's), and one that can move or reset them
// (shift, set, and eval or source, which may run either with code this hook
// does not read here) or defines a function, whose $1 and on are its own.
function scriptPositional(operands, file, segments, homeKnown) {
  const { args } = operands;
  if (!Array.isArray(args) || (operands.sources && args.length === 0)) return null;
  if (segments.some(changesPositionals)) return null;
  const words = positionalWords(args, homeKnown);
  return words === null ? null : { zero: file, words };
}

// The values of the words a script is run with, a leading ~ already the
// home directory, as the shell running the line hands them over; null when
// one of them only that shell can read.
function positionalWords(args, homeKnown) {
  const words = [];
  for (const word of args) {
    if (!literalWords([{ ...word, tilde: false }])) return null;
    const value = word.tilde ? expandedOperandValue(word, homeKnown) : word.value;
    if (value === null) return null;
    words.push(value);
  }
  return words;
}

const FUNCTION_DEFINITION_RE = /^\s*(?:function\s+\S|[\w.:-]+\s*\(\s*\))/;
const POSITIONAL_CHANGERS = new Set(['shift', 'eval', 'source', '.']);

function changesPositionals(segment) {
  if (FUNCTION_DEFINITION_RE.test(segment)) return true;
  const { name, args } = commandOf(segment);
  if (POSITIONAL_CHANGERS.has(name)) return true;
  return name === 'set' && setsPositionals(args.map(word => word.value));
}

// Whether set's words give the script new positional parameters: `--`, or
// any word that is no option (the name after an o, as in -o or -euo, is the
// option's).
function setsPositionals(values) {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === '--' || !/^[-+]./.test(values[i])) return true;
    if (/^[-+][A-Za-z]*o$/.test(values[i])) i += 1;
  }
  return false;
}

// The segments one script file brings, its own and those of the scripts it
// runs in turn, each marked committed or not. A script that cannot be
// analyzed fails closed whoever runs it: its commands could be anything.
const NO_FILE_SEGMENTS = { segments: [], own: [], committed: [], bound: [], places: [] };

// The values two sets of assignments give each variable, both kept.
function mergedBound(first, second) {
  const merged = Object.assign(Object.create(null), first);
  for (const [name, values] of Object.entries(second)) merged[name] = [...new Set([...(merged[name] ?? []), ...values])];
  return merged;
}

function fileSegmentsOf(file, operands, depth, seen, context) {
  const nested = nestedSegmentsOf(file, depth, seen);
  if (nested.blocked) return { ...NO_FILE_SEGMENTS, blocked: nested.blocked };
  if (nested.segments === null) return { ...NO_FILE_SEGMENTS, blocked: null };
  const committedFile = isCommittedUnchanged(file);
  // A script's command words are judged by every value they can take, from
  // what the script and its caller fix; one the hook cannot read fails closed
  // unless the script is committed, where only the grave denials apply.
  const ownBindings = bindingsOfSegments(nested.segments);
  const bindings = mergeBindings(context.bindings, ownBindings);
  const positional = scriptPositional(operands, file, nested.segments, context.homeKnown);
  const words = resolveCommandWords(nested.segments, bindings, !committedFile, positional);
  if (words.blocked) return { ...NO_FILE_SEGMENTS, blocked: `script ${file}: ${words.blocked}` };
  const reread = secondReadings(nested.text, bindings, !committedFile);
  if (reread.blocked) return { ...NO_FILE_SEGMENTS, blocked: `script ${file}: ${reread.blocked}` };
  const own = [...words.segments, ...reread.segments];
  const mark = committedFile ? { bound: boundAssignments(nested.segments, context.callerSet) } : false;
  // The script's targets are judged by what the script and its caller set.
  const scriptBound = mergedBound(context.bound ?? {}, lineBoundOf(nested.segments, ownBindings));
  // A script the wrapper moved into a directory runs its own children there.
  const ownWrites = writesOf(own, operands.base, false);
  const inner = scriptSegmentsOf(own, operands.bases ?? operands.base, depth + 1, seen, {
    own: false,
    cwdUnknown: operands.cwdUnknown,
    cwdKnown: true,
    homeKnown: context.homeKnown,
    scriptDir: path.dirname(file),
    dirVars: scriptDirVariables(nested.segments),
    bindings,
    bound: scriptBound,
    scriptVars: scriptVarsOf(ownBindings),
    callerSet: new Set([...context.callerSet, ...assignedNames(nested.segments)]),
    written: { paths: new Set([...context.written.paths, ...ownWrites.paths]), bulk: context.written.bulk },
  });
  // Its commands run where its own moves leave them, from where it starts;
  // one past a move only the running shell knows, and code it reads after
  // expanding, where it starts.
  const ownPlaces = own.map((_, i) => (i < words.segments.length ? inner.places[i] : null) ?? operands.bases ?? [operands.base]);
  return {
    segments: [...own, ...inner.segments],
    own,
    committed: [...own.map(() => mark), ...inner.committed],
    bound: [...own.map(() => scriptBound), ...inner.bound],
    places: [...ownPlaces, ...inner.collectedPlaces],
    blocked: inner.blocked,
  };
}

// Names these segments assign or export.
function assignedNames(segments) {
  const names = new Set();
  for (const segment of segments) {
    const words = shellWords(segment).map(word => word.value);
    for (const [i, word] of words.entries()) {
      const assignment = /^([A-Za-z_]\w*)\+?=/.exec(word);
      if (assignment) names.add(assignment[1]);
      else if (words[i - 1] === 'export' && /^[A-Za-z_]\w*$/.test(word)) names.add(word);
    }
  }
  return names;
}

// The variables these segments set, with every literal value each one takes,
// for the targets the validator judges through them: the assignments as
// written (a value may name another variable, which the validator follows)
// and the values the shell bindings read out of loops and declarations.
function lineBoundOf(segments, bindings) {
  const bound = boundAssignments(segments, new Set());
  for (const [name, entry] of bindings.names) {
    if (entry.values.size > 0) bound[name] = [...new Set([...(bound[name] ?? []), ...entry.values])];
  }
  return bound;
}

// What a committed script sets each variable to, for the ones neither the
// command nor the environment can set before it runs: the validator counts
// a variable as the script's own only when every value is a narrow target.
function boundAssignments(segments, callerSet) {
  // No prototype: `constructor=x` or `__proto__=x` name variables here.
  const values = Object.create(null);
  for (const segment of segments) {
    for (const word of shellWords(segment)) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.value);
      if (!assignment || callerSet.has(assignment[1])) continue;
      values[assignment[1]] = [...(values[assignment[1]] ?? []), assignment[2]];
    }
  }
  return values;
}

module.exports = {
  resolveCommandWords,
  bindingsOfSegments,
  secondReadings,
  scriptSegmentsOf,
  commandContext,
  lineBoundOf,
};
