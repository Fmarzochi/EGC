'use strict';

/**
 * The directories a command line can be in as it runs, followed through cd,
 * pushd and popd, so the Bash hook finds a script named after them where the
 * shell does.
 *
 * A move is added to the directories the line could already be in, never put
 * in their place: a cd that fails leaves the next command after `;` where it
 * was, and one inside a subshell does not outlive it, and the hook does not
 * follow either. A target only known when the command runs (a variable the
 * line does not fix, a substitution, a CDPATH search, a directory stack the
 * shell had before the line) leaves the directory unknown from there on,
 * with the reason, and the caller fails closed on a script named by a
 * relative path after it.
 */

const fs = require('node:fs');
const path = require('node:path');

const CWD_CHANGERS = new Set(['cd', 'pushd', 'popd', 'chdir']);
const MAX_DIRS = 16;
const CD_OPTION_RE = /^-[LPe@]+$/;
const STACK_INDEX_RE = /^[+-]\d+$/;
const INHERITED_STACK = 'uses a directory stack the shell had before this command, which this hook does not know';

function startCwd(dir) {
  return { dirs: [dir], stack: [], previous: null, unknown: null };
}

// The operands of cd, pushd and popd. Options come before the first operand
// only, so `cd dir -P` is two operands, an error that leaves the directory.
function moveOperands(args) {
  const operands = [];
  let literal = false;
  for (const word of args) {
    if (!literal && operands.length === 0 && word.value === '--') literal = true;
    else if (literal || operands.length > 0 || !CD_OPTION_RE.test(word.value)) operands.push(word);
  }
  return operands;
}

// Whether a cd resolves its target physically: the last of -L and -P among
// its options decides, and -L (logical) is the default.
function isPhysicalMove(name, args) {
  let physical = false;
  if (name !== 'cd') return false;
  for (const word of args) {
    if (!CD_OPTION_RE.test(word.value)) break;
    for (const letter of word.value) {
      if (letter === 'P') physical = true;
      else if (letter === 'L') physical = false;
    }
  }
  return physical;
}

// Where cd -P lands: symlinks followed before each `..`, as the system does,
// instead of `..` removing the name before it. A target that is not there
// keeps the plain resolution; the cd fails and the line stays anyway.
function physicalPath(dir, target) {
  try {
    return fs.realpathSync.native(path.isAbsolute(target) ? target : `${dir}${path.sep}${target}`);
  } catch {
    return path.resolve(dir, target);
  }
}

function unknownAfter(state, reason) {
  return { ...state, unknown: reason };
}

// `state` with `targets` added: each resolved against each directory the
// line could be in. Too many to follow is unknown.
function movedTo(state, targets, name, physical = false) {
  const moved = state.dirs.flatMap(dir => targets.map(target => (physical ? physicalPath(dir, target) : path.resolve(dir, target))));
  const dirs = [...new Set([...state.dirs, ...moved])];
  if (dirs.length > MAX_DIRS) return unknownAfter(state, `${name} moves through more directories than this hook follows`);
  return { ...state, dirs, previous: state.dirs, stack: name === 'pushd' ? [...state.stack, state.dirs] : state.stack };
}

// popd returns to the directories the last pushd of this line left.
function popped(state, operands) {
  if (operands.length > 0) return unknownAfter(state, `popd ${operands[0].value} takes a directory from a stack this hook does not follow`);
  if (state.stack.length === 0) return unknownAfter(state, `popd ${INHERITED_STACK}`);
  const back = state.stack.at(-1);
  return { ...state, dirs: [...new Set([...state.dirs, ...back])], previous: state.dirs, stack: state.stack.slice(0, -1) };
}

// The directories the line can be in after the command `name` with `args`.
// `targetsOf(word)` gives the directories a target word names (null when
// only the running shell knows it; `word` null asks for the home directory).
function afterMove(state, name, args, targetsOf) {
  if (!CWD_CHANGERS.has(name) || state.unknown) return state;
  const operands = moveOperands(args);
  if (name === 'popd') return popped(state, operands);
  if (name === 'pushd' && operands.length === 0) {
    return state.stack.length === 0 ? unknownAfter(state, `pushd ${INHERITED_STACK}`) : movedTo(state, state.stack.at(-1), name);
  }
  // Too many operands is an error, and the directory stays.
  if (operands.length > 1) return state;
  const word = operands[0];
  if (name === 'pushd' && STACK_INDEX_RE.test(word.value)) return unknownAfter(state, `pushd ${word.value} rotates a stack this hook does not follow`);
  if (word?.value === '-') return returned(state, name, `${name} -`);
  const targets = targetsOf(word ?? null);
  const spelled = word ? `${name} ${word.value}` : name;
  if (targets === null) return unknownAfter(state, `${spelled} moves to a directory only known when the command runs`);
  // The shell reads options after expanding the word: `cd "$X"` with X set
  // to - is cd -, and to -P or +1 an option or a stack rotation.
  const expanded = targets.filter(target => target !== word?.value);
  if (expanded.length > 0 && targets.every(target => target === '-')) return returned(state, name, spelled);
  if (expanded.some(target => /^[-+]/.test(target))) return unknownAfter(state, `${spelled} expands to an option, which moves where only the running shell knows`);
  return movedTo(state, targets, name, isPhysicalMove(name, args));
}

// cd - returns to where the last move of this line started.
function returned(state, name, spelled) {
  return state.previous ? movedTo(state, state.previous, name) : unknownAfter(state, `${spelled} returns to a directory only the running shell knows`);
}

module.exports = { startCwd, afterMove, CWD_CHANGERS };
