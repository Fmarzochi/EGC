'use strict';

// Turns a raw command string into a flat list of judgeable command-line
// segments: continuation/comment-aware joining, heredocs, pipelines,
// command/process substitutions, eval and shell -c, find -exec, terminal
// handoffs and egc run --shell. Part of the pre-bash-guardian-validate.js
// split (#1712).

const { commandName } = require('../lib/wrapper-options');
const { splitShellSegments, extractSubstitutionBodies, constructEnd } = require('../lib/shell-split');
const { stdinReaderOf, producedProgram, isRedirection, isRuntimeOnly } = require('../lib/stdin-programs');
const { handoffCommandsOf } = require('../lib/handoff-commands');
const { singleQuoted } = require('../lib/shell-bindings');
const { shellWords, SHELL_INTERPRETERS, consumedAsOptionValue, noteShellOption } = require('./pre-bash-guardian-shell-words');
const { skipEnvAndWrappers } = require('./pre-bash-guardian-wrapper-walk');

// Caps recursion into nested command/process substitutions
// ($(echo $(echo $(...)))) — a real script has no reason to nest these more
// than a couple of levels deep; this is purely a backstop against adversarial
// or pathological input, not a limit anyone should ever hit legitimately.
const MAX_SUBSTITUTION_DEPTH = 5;

// extractSegments returns null (instead of the usual segment array) when a
// command nests substitutions deeper than MAX_SUBSTITUTION_DEPTH allows
// fully unwrapping. Silently returning only the outer, already-parsed
// segments here (as this used to do) fails OPEN: the innermost
// substitution — the one actually worth hiding a destructive command in,
// e.g. `echo $(echo $(...(rm -rf /)...))` nested one level past the cap —
// is never extracted or validated, and stays buried as inert-looking text
// inside an outer segment whose own leading token (like `echo`) reads as
// safe. run() below hard-blocks on a null return instead, so a command too
// deep to fully analyze fails CLOSED rather than being treated as if
// nothing were found.

// Segmentation only splits the compound command on top-level, unquoted
// operators (&&, ||, ;, &, |, newline) — it no longer strips leading
// wrappers (sudo, env, xargs, ...) or env-var assignments itself. That
// unwrapping now happens once, centrally, in the guardian's own
// validateCommand (mcp/servers/egc-guardian/src/validator.ts), which both
// this hook and the validate_command MCP tool call through the CLI below —
// duplicating the same peeling logic in two places is exactly how earlier
// fixes here ended up covering only the specific wrapper names each audit
// happened to name (see the project's Guardian bypass post-mortem).
//
// Command/process substitutions ($(...), <(...), >(...), `...`) are also
// extracted and validated as their own additional segments, recursively (up
// to MAX_SUBSTITUTION_DEPTH): `echo $(rm -rf /)` must not slip through as
// one benign-looking `echo` segment just because `$`/backtick are not
// top-level separators.
// A backslash-newline continues the line where the shell reads it that way:
// outside single quotes; inside them it is two literal characters.
// The length of a backslash-newline pair at `at` (2, or 3 with a carriage
// return), 0 when the backslash starts something else.
function continuationLength(text, at) {
  if (text[at + 1] === '\n') return 2;
  return text[at + 1] === '\r' && text[at + 2] === '\n' ? 3 : 0;
}

// A `#` opening a word starts a comment; the caller asks only outside quotes
// and outside ${...}.
function opensComment(out, ch) {
  return ch === '#' && (out === '' || /[\s;&|(]/.test(out.at(-1)));
}

// A backslash-newline outside single quotes is a line continuation and is
// dropped; inside a comment it is comment text, and the newline still ends
// the comment, as bash reads it.
// A command body (`$(...)`, backquotes, and outside double quotes `<(...)`
// and `>(...)`) is copied as written: bash reads its comments, and so its
// line continuations, as a command of its own, and extractSegments joins it
// when it reads that body in turn.
function commandBodyEnd(text, i, double) {
  if (text[i] === '$' && text[i + 1] === '{') return null;
  if (double && text[i] !== '`' && !(text[i] === '$' && text[i + 1] === '(')) return null;
  return constructEnd(text, i);
}

// `state.open` holds the quotes and ${...} expansions open around the
// character, innermost last: a `"` inside a ${...} opens a string of its
// own, even when that ${...} sits in double quotes, as bash reads it.
function joinContinuations(text) {
  const state = { out: '', single: false, open: [], comment: false };
  let i = 0;
  while (i < text.length) i = joinStep(text, i, state);
  return state.out;
}

// Reads the character at `i` into `state.out`; the index to read next.
function joinStep(text, i, state) {
  const ch = text[i];
  if (state.comment) {
    state.comment = ch !== '\n';
    state.out += ch;
    return i + 1;
  }
  const double = state.open.includes('"');
  const body = state.single ? null : commandBodyEnd(text, i, double);
  if (body !== null) {
    const end = body === -1 ? text.length : body + 1;
    state.out += text.slice(i, end);
    return end;
  }
  if (state.single) {
    state.single = ch !== "'";
    state.out += ch;
    return i + 1;
  }
  if (state.open.length === 0) state.comment = opensComment(state.out, ch);
  if (ch === '\\') return escapeStep(text, i, state);
  return quoteStep(text, i, state, double);
}

// A quote, a `${` or its `}`, or any other character outside single quotes.
// `$'...'` is copied whole: its escapes are its own, an escaped quote too.
function quoteStep(text, i, state, double) {
  const ch = text[i];
  if (ch === '$' && text[i + 1] === "'" && !double) {
    const end = constructEndOfAnsi(text, i);
    state.out += text.slice(i, end);
    return end;
  }
  if (ch === '$' && text[i + 1] === '{') {
    state.open.push('{');
    state.out += '${';
    return i + 2;
  }
  const inner = state.open.at(-1);
  if (ch === '}' && inner === '{') state.open.pop();
  else if (ch === '"' && inner === '"') state.open.pop();
  else if (ch === '"') state.open.push('"');
  else if (ch === "'" && !double) state.single = true;
  state.out += ch;
  return i + 1;
}

// Index past the `$'...'` opening at `i`.
function constructEndOfAnsi(text, i) {
  let j = i + 2;
  while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

// A continuation is dropped; any other escape is kept with its character.
function escapeStep(text, i, state) {
  const skip = continuationLength(text, i);
  if (skip > 0) return i + skip;
  state.out += text.slice(i, i + 2);
  return i + 2;
}



// A heredoc body is stdin data for the command, not words the shell hands it:
// a commit message, a log line or a document that happens to name a protected
// path or a flag is not an argument, and reading it as one blocked the whole
// command, the parts before it included. The exception is an interpreter
// reading its script from the heredoc, where the body is code and keeps the
// analysis it already had.
// A delimiter is any word the shell can quote, not only an identifier:
// EOF-1 and v1.0 are as valid as EOF.
const HEREDOC_OPERATOR_RE = /(^|[^<])<<(?!<)-?\s*(['"]?)[^\s'"<>|&;()]+\2/;

// A segment split at its heredoc: `command` is the line the shell runs and
// `body` is the data it reads on stdin, or null when there is no heredoc.
function splitHeredoc(segment) {
  const newline = segment.indexOf('\n');
  if (newline === -1) return { command: segment, body: null };
  const firstLine = segment.slice(0, newline);
  if (!HEREDOC_OPERATOR_RE.test(firstLine)) return { command: segment, body: null };
  return { command: firstLine, body: segment.slice(newline + 1) };
}

// Whether the command of a line is a shell reading its input as code, after
// the same environment assignments and wrappers the interpreter-operand scan
// peels: `sudo bash <<EOF` reads the body exactly as `bash <<EOF` does.
function readsItsInputAsCode(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  const head = words[index];
  if (!head) return false;
  const isShell = head.value.startsWith('$') || SHELL_INTERPRETERS.has(commandName(head.value));
  if (!isShell) return false;
  // A file operand names the script the shell will run, and its standard
  // input is then that script's data. Anything else keeps the body as code:
  // -c does not make it data, because the script it carries can read standard
  // input and execute it (`bash -c 'sh' <<EOF`), which is exactly the shape
  // worth hiding a destructive command in.
  const rest = words.slice(index + 1).map(word => word.value);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    // A redirection is not a script operand; a bare one takes the next word.
    if (/^\d*[<>]/.test(value) || value.startsWith('&>')) {
      if (/^\d*[<>]+$/.test(value)) i += 1;
      continue;
    }
    if (value === '--') {
      return rest.slice(i + 1).every(word => /^\d*[<>]/.test(word) || word.startsWith('&>'));
    }
    if (!value.startsWith('-')) return false;
    // -c takes the script it carries as the next word, and -o an option name:
    // neither is the script file that would make the heredoc data.
    if (/^-[a-zA-Z]*c$/.test(value) || value === '--command' || value === '-o' || value === '+o') i += 1;
  }
  return true;
}

// `egc run --shell` joins the words after its options and hands them to a
// shell, so a whole script can arrive as one quoted token. The validator
// judges that token as one command and calls its metacharacters advisory,
// which is exactly where a compound script would hide a refused command.
// The script is read as the command line it is: its segments are extracted
// and validated like the body of a heredoc a shell reads.
// `egc run --shell` joins the words after its one option and hands them to a
// shell, so a whole script can arrive as one quoted token. The validator
// judges that token as one command and calls its metacharacters advisory,
// which is exactly where a compound script would hide a refused command.
// The script is read as the command line it is, heredocs included: its
// segments are extracted and validated like the body of a heredoc a shell
// reads. `egc run` reads a single option, and only as its first argument
// (scripts/crush-run.js), so `--shell` first and then the script, whatever
// it starts with.
function egcShellScriptOf(segment) {
  const words = shellWords(segment);
  const index = skipEnvAndWrappers(words);
  if (commandName(words[index]?.value) !== 'egc') return null;
  if (words[index + 1]?.value !== 'run' || words[index + 2]?.value !== '--shell') return null;
  const script = words.slice(index + 3);
  if (script.length === 0) return null;
  // The rewrite hook hands the whole script as one quoted word, which keeps
  // its line breaks; typed as bare words, the text after --shell is the
  // script, a heredoc fed to it included. Neither loses what the shell reads.
  if (script.length === 1) return script[0].value;
  return segment.slice(words[index + 2].end).replace(/^\s+/, '');
}

// `own` followed by the segments of `script`, read one level deeper; null
// when the depth cap is reached or the deeper analysis cannot continue.
function withNested(own, script, depth) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return null;
  const inner = extractSegments(script, depth + 1);
  if (inner === null) return null;
  return [...own, ...inner];
}

// The code `eval` or a shell's -c runs, read as the command line it is, so
// the commands inside are judged like any other: in a committed script the
// eval itself is only flagged, and what it runs still meets the grave
// denials. null when the stage runs no such code.
function inlineShellCodeOf(line) {
  const carrier = inlineCodeWords(line);
  if (carrier === null) return null;
  return carrier.evaluated ? carrier.words.map(word => word.value).join(' ') : withPositionals(carrier.words[0].value, carrier.words.slice(1));
}

// The words that carry that code: every word after eval, or the operand of
// a shell's -c followed by its $0, $1 and on; null when there is none.
function inlineCodeWords(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  const name = commandName(words[index]?.value);
  if (name === 'eval') return words.length > index + 1 ? { words: words.slice(index + 1), evaluated: true } : null;
  if (!SHELL_INTERPRETERS.has(name) || name === 'source' || name === '.') return null;
  const rest = words.slice(index + 1);
  const at = shellCommandIndex(rest);
  return at < 0 ? null : { words: rest.slice(at), evaluated: false };
}

// Where the string a shell's -c runs stands: its first operand after the
// options, when one of them is -c, alone or in a cluster such as -ec. The
// words after it are its $0, $1 and on, read into the code where it names
// them. Under -n or -o noexec the shell only parses the string, so it runs
// no code: -1 then, and when there is no -c.
function shellCommandIndex(words) {
  const state = { awaiting: null, noexec: false, command: false };
  for (const [i, word] of words.entries()) {
    if (consumedAsOptionValue(word, state)) continue;
    if (!/^[-+]/.test(word.value)) return state.command && !state.noexec ? i : -1;
    noteShellOption(word.value, state);
  }
  return -1;
}

// A positional parameter the code of a shell's -c reads, replaced by the
// word given for it: a find action's {} or a literal path is then judged as
// the target it is. One with no word given stays as written, a value the
// caller chooses.
function withPositionals(code, given) {
  return code.replace(/\$(?:\{(\d+|[@*])\}|(\d|[@*]))/g, (whole, braced, bare) => {
    const name = braced ?? bare;
    if (name === '@' || name === '*') return given.length > 1 ? given.slice(1).map(word => word.value).join(' ') : whole;
    const index = Number(name);
    return index < given.length ? given[index].value : whole;
  });
}

// find's actions that run a command, which ends at a `;` or `+`.
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_ENDS = new Set([';', String.raw`\;`, '+']);

// The commands a find in this stage runs through -exec and its kin, each
// read as its own command line, so what they run (a shell's -c included)
// is judged too.
function findExecCommandsOf(line) {
  const words = shellWords(line);
  const index = skipEnvAndWrappers(words);
  if (commandName(words[index]?.value) !== 'find') return [];
  const commands = [];
  let current = null;
  for (const word of words.slice(index + 1)) {
    if (current === null) {
      if (FIND_EXEC_FLAGS.has(word.value)) current = [];
    } else if (FIND_EXEC_ENDS.has(word.value)) {
      commands.push(current.map(word => singleQuoted(word)).join(' '));
      current = null;
    } else {
      current.push(word.value);
    }
  }
  // find refuses an action that has no end, so nothing runs past the last one.
  return commands;
}

// A program a command runs that this hook cannot read: the whole command
// is refused, with the reason.
class ProgramUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProgramUnreadable';
  }
}

const inlineCode = name => `${name} reads the program it runs from its standard input, which is inline code; write the code to a file and run the file instead`;
const runtimeOnly = (name, source) => `${name} reads the program it runs from ${source}, which only exists while the command runs, so this hook cannot read it; save it to a file, read it, and run the file instead`;
const expandedInput = (name, kind) => `${name} reads the program it runs from a ${kind} the shell expands when the command runs, which this hook cannot read as written; quote it (<<'EOF', <<< '...') or write the script to a file and run the file instead`;

// The words of a stage, environment assignments and wrappers skipped: the
// command it runs, first.
function stageWords(stage) {
  const words = shellWords(splitHeredoc(stage).command);
  return words.slice(skipEnvAndWrappers(words));
}

const stageValues = stage => stageWords(stage).map(word => word.value);

// Whether words are the text the command runs with: nothing the shell
// expands, globs, brace-expands or reads as ~, no escape it cannot place,
// and no quoted word that only reads like a redirection.
function literalWords(words) {
  return words.every(word => !word.expands && !word.globbed && !word.tilde && !word.unsure && !word.braced && (word.redirect || !isRedirection(word.value)));
}

// Whether a heredoc's body is the text the command reads: every delimiter
// on its line is quoted, or the body holds nothing the shell expands in it.
function literalHeredoc(line, body) {
  if (!/[$`\\]/.test(body)) return true;
  const delimiters = [...line.matchAll(/(?:^|[^<])<<(?!<)-?\s*(\S+)/g)].map(match => match[1]);
  return delimiters.length > 0 && delimiters.every(delimiter => /['"\\]/.test(delimiter));
}

// The word a here-string (`<<< word`) feeds a command's standard input.
function hereStringWord(line) {
  const words = shellWords(line);
  for (let i = 0; i < words.length; i += 1) {
    if (!words[i].redirect) continue;
    if (words[i].value === '<<<') return words[i + 1] ?? null;
    if (words[i].value.startsWith('<<<')) return { ...words[i], value: words[i].value.slice(3) };
  }
  return null;
}

// What a command that reads its program on standard input is given there,
// as the command lines to judge: a shell's or at's script, read like any
// other, and the files it reads, as the script operands they are. An
// interpreter of another language reading its code there is inline code,
// and a path only the running command has cannot be read at all.
function fedLines(reader, produced) {
  if (reader.kind === 'interpreter') {
    throw new ProgramUnreadable(reader.files.length > 0 ? runtimeOnly(reader.name, reader.files[0]) : inlineCode(reader.name));
  }
  const shell = reader.kind === 'shell' ? reader.name : 'sh';
  if (produced.text !== undefined) return [produced.text];
  const runtime = produced.files.find(isRuntimeOnly);
  if (runtime !== undefined) throw new ProgramUnreadable(runtimeOnly(reader.name, runtime));
  return produced.files.map(file => `${shell} ${singleQuoted(file)}`);
}

// What a stage writes to the pipe, when this hook can read it as written.
function producedBy(stage) {
  const words = stageWords(stage);
  const { command, body } = splitHeredoc(stage);
  if (!literalWords(words) || (body !== null && !literalHeredoc(command, body))) return null;
  return producedProgram(words.map(word => word.value), body);
}

// The stages of a pipeline, a heredoc's body given to the stage whose
// operator opened it: in `cat <<EOF | sh` the body is what cat reads, and sh
// reads cat's output, not a script operand on the line after it.
function pipelineStages(pipeline) {
  const { command: line, body } = splitHeredoc(pipeline);
  if (body === null) return splitShellSegments(pipeline, { splitOnPipe: true, stripComments: true });
  const stages = splitShellSegments(line, { splitOnPipe: true, stripComments: true });
  const owner = stages.findIndex(stage => HEREDOC_OPERATOR_RE.test(stage));
  return stages.map((stage, i) => (i === owner ? `${stage}\n${body}` : stage));
}

// The programs each stage of the pipelines in `command` hands the next one
// as the program that one reads on standard input.
function fedPrograms(command) {
  const fed = [];
  for (const pipeline of splitShellSegments(command, { stripComments: true })) {
    const stages = pipelineStages(pipeline);
    for (let s = 1; s < stages.length; s += 1) {
      const reader = stdinReaderOf(stageValues(stages[s]));
      // A reader with input of its own (a file, a heredoc, a here-string)
      // runs that, judged with the stage, not what the stage before writes.
      if (reader === null || reader.files.length > 0 || splitHeredoc(stages[s]).body !== null || hereStringWord(stages[s]) !== null) continue;
      const produced = producedBy(stages[s - 1]);
      if (produced === null && reader.kind !== 'interpreter') {
        throw new ProgramUnreadable(`${reader.name} reads the program it runs from the output of '${stageValues(stages[s - 1]).join(' ')}', which this hook cannot read; save that output to a file, read it, and run the file instead`);
      }
      fed.push(...fedLines(reader, produced ?? { text: '' }));
    }
  }
  return fed;
}

// The text a stage's own heredoc or here-string feeds its reader, refused
// when the shell expands it before the reader gets it.
function ownInputText(reader, line, body) {
  const here = hereStringWord(line);
  if (here !== null) {
    if (here.expands || here.unsure || here.tilde) throw new ProgramUnreadable(expandedInput(reader.name, 'here-string'));
    return here.value;
  }
  if (body === null) return null;
  if (!literalHeredoc(line, body)) throw new ProgramUnreadable(expandedInput(reader.name, 'heredoc'));
  return body;
}

// The program a stage's own input hands the command it runs: a heredoc or
// a here-string, and the files it reads instead (at's scripts, the file a
// shell's input comes from).
function ownFedPrograms(line, body) {
  const reader = stdinReaderOf(stageValues(line));
  if (reader === null) return [];
  const text = ownInputText(reader, line, body);
  const programs = text === null ? [] : fedLines(reader, { text });
  return reader.files.length === 0 ? programs : [...programs, ...fedLines(reader, { files: reader.files })];
}

// The command lines this stage hands to another process (a terminal
// multiplexer, a remote shell, a container) to run.
function handedOffCommandsOf(line) {
  const words = shellWords(line);
  return handoffCommandsOf(words.slice(skipEnvAndWrappers(words)).map(word => word.value));
}

// The segments one pipeline stage contributes: the stage itself and, when
// it hands a script to a shell, the segments of that script.
function segmentsOfStage(raw, depth) {
  // A script handed to `egc run --shell` runs in a shell of its own, so
  // it is read whole and its segments are judged like the body of a
  // heredoc a shell reads.
  const script = egcShellScriptOf(raw);
  if (script !== null) {
    const whole = raw.trim();
    return withNested(whole ? [whole] : [], script, depth);
  }
  const { command: line, body } = splitHeredoc(raw);
  const trimmed = line.trim();
  const inline = inlineShellCodeOf(line);
  let own = trimmed ? [trimmed] : [];
  for (const code of [...(inline === null ? [] : [inline]), ...findExecCommandsOf(line), ...handedOffCommandsOf(line), ...ownFedPrograms(line, readsItsInputAsCode(line) ? null : body)]) {
    own = own === null ? null : withNested(own, code, depth);
  }
  if (own === null) return null;
  // The body is stdin data, except when a shell is the one reading it:
  // there it is a script, and it is judged like any other script.
  if (body === null || !readsItsInputAsCode(line)) return own;
  return withNested(own, body, depth);
}

function extractSegments(rawCommand, depth = 0) {

  const command = joinContinuations(String(rawCommand));

  const bodies = extractSubstitutionBodies(command);
  // There is at least one more level of substitution here that recursing
  // would need to unwrap, and depth is already at the cap: analysis cannot
  // continue safely. Return null rather than the partial topLevel result so
  // the caller blocks instead of silently accepting an unanalyzed command.
  if (bodies.length > 0 && depth >= MAX_SUBSTITUTION_DEPTH) return null;

  const segments = [];
  for (const raw of splitShellSegments(command, { stripComments: true }).flatMap(pipelineStages)) {
    const stage = segmentsOfStage(raw, depth);
    if (stage === null) return null;
    segments.push(...stage);
  }

  for (const body of bodies) {
    const nested = extractSegments(body, depth + 1);
    if (nested === null) return null;
    segments.push(...nested);
  }

  for (const program of fedPrograms(command)) {
    const nested = withNested([], program, depth);
    if (nested === null) return null;
    segments.push(...nested);
  }

  return segments;
}

module.exports = {
  extractSegments,
  ProgramUnreadable,
  joinContinuations,
  pipelineStages,
  splitHeredoc,
  readsItsInputAsCode,
  literalHeredoc,
  inlineCodeWords,
  segmentsOfStage,
  literalWords,
};
