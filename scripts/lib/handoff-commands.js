'use strict';

/**
 * The command lines a command hands to another process to run, for the Bash
 * hook to judge as commands of their own: what a tmux session, window, pane,
 * popup, pipe, run-shell or hook runs and the keys send-keys types into a
 * pane; what screen starts, stuffs into a window or execs; what ssh runs on
 * the remote host; and what docker, podman or kubectl exec runs in a
 * container. Each tool's words are read the way that tool reads them. A tmux
 * command given as one word comes back as a `tmux ...` line, which the hook
 * reads again with its own word splitter.
 */

const { singleQuoted } = require('./shell-bindings');

const argvLine = values => values.map(singleQuoted).join(' ');
// A command given as one word is a shell command line; as several, an argv.
const commandLine = values => (values.length === 1 ? values[0] : argvLine(values));

// One getopt-style cluster at `values[i]`: its letters go to `set`, the value
// of a letter in `valueLetters` (the rest of the cluster or the next word) to
// `given`. The index after it.
function readCluster(values, i, valueLetters, set, given) {
  const word = values[i];
  for (let k = 1; k < word.length; k += 1) {
    set.add(word[k]);
    if (!valueLetters.includes(word[k])) continue;
    const attached = word.slice(k + 1);
    given.set(word[k], attached || values[i + 1]);
    return attached ? i + 1 : i + 2;
  }
  return i + 1;
}

// The options from `start` up to the first operand or `--`.
function readShortOptions(values, start, valueLetters) {
  const set = new Set();
  const given = new Map();
  let i = start;
  while (i < values.length && values[i].startsWith('-') && values[i] !== '-') {
    if (values[i] === '--') return { set, given, end: i + 1 };
    i = readCluster(values, i, valueLetters, set, given);
  }
  return { set, given, end: i };
}

// tmux commands by full name, as tmux 3.4 lists them, for its own rule: an
// exact name or alias, or else the one name a prefix matches.
const TMUX_NAMES = [
  'attach-session', 'bind-key', 'break-pane', 'capture-pane', 'choose-buffer', 'choose-client', 'choose-tree',
  'clear-history', 'clear-prompt-history', 'clock-mode', 'command-prompt', 'confirm-before', 'copy-mode',
  'customize-mode', 'delete-buffer', 'detach-client', 'display-menu', 'display-message', 'display-panes',
  'display-popup', 'find-window', 'has-session', 'if-shell', 'join-pane', 'kill-pane', 'kill-server', 'kill-session',
  'kill-window', 'last-pane', 'last-window', 'link-window', 'list-buffers', 'list-clients', 'list-commands',
  'list-keys', 'list-panes', 'list-sessions', 'list-windows', 'load-buffer', 'lock-client', 'lock-server',
  'lock-session', 'move-pane', 'move-window', 'new-session', 'new-window', 'next-layout', 'next-window',
  'paste-buffer', 'pipe-pane', 'previous-layout', 'previous-window', 'refresh-client', 'rename-session',
  'rename-window', 'resize-pane', 'resize-window', 'respawn-pane', 'respawn-window', 'rotate-window', 'run-shell',
  'save-buffer', 'select-layout', 'select-pane', 'select-window', 'send-keys', 'send-prefix', 'server-access',
  'set-buffer', 'set-environment', 'set-hook', 'set-option', 'set-window-option', 'show-buffer', 'show-environment',
  'show-hooks', 'show-messages', 'show-options', 'show-prompt-history', 'show-window-options', 'source-file',
  'split-window', 'start-server', 'suspend-client', 'swap-pane', 'swap-window', 'switch-client', 'unbind-key',
  'unlink-window', 'wait-for',
];
// The commands that run something, with their alias, the option letters
// that take a value, and how their operands run.
const TMUX_RUNNERS = {
  'new-session': { alias: 'new', values: 'cefFnstxy', runs: 'command' },
  'new-window': { alias: 'neww', values: 'ceFnt', runs: 'command' },
  'split-window': { alias: 'splitw', values: 'celtF', runs: 'command' },
  'respawn-pane': { alias: 'respawnp', values: 'cet', runs: 'command' },
  'respawn-window': { alias: 'respawnw', values: 'cet', runs: 'command' },
  'display-popup': { alias: 'popup', values: 'bcdehsStTwxy', runs: 'command' },
  'pipe-pane': { alias: 'pipep', values: 't', runs: 'command' },
  'run-shell': { alias: 'run', values: 'cdt', runs: 'run' },
  'if-shell': { alias: 'if', values: 't', runs: 'if' },
  'send-keys': { alias: 'send', values: 'cNt', runs: 'keys' },
  'confirm-before': { alias: 'confirm', values: 'cpt', runs: 'tmux' },
  'command-prompt': { alias: null, values: 'IptT', runs: 'tmux' },
  'bind-key': { alias: 'bind', values: 'NT', runs: 'bind' },
  'set-hook': { alias: null, values: 't', runs: 'hook' },
  'set-option': { alias: 'set', values: 't', runs: 'option' },
};
const TMUX_ALIASES = new Map(Object.entries(TMUX_RUNNERS).filter(([, spec]) => spec.alias).map(([name, spec]) => [spec.alias, name]));
// tmux's own options that take a value; -c runs its value as a shell command.
const TMUX_GLOBAL_VALUES = 'cfLST';

function tmuxCommandName(word) {
  if (TMUX_NAMES.includes(word)) return word;
  if (TMUX_ALIASES.has(word)) return TMUX_ALIASES.get(word);
  const matches = TMUX_NAMES.filter(name => name.startsWith(word));
  return matches.length === 1 ? matches[0] : null;
}

// tmux reads `;` as the end of a command, alone or at the end of a word;
// `\;` reaching it is a literal semicolon. The Bash hook keeps backslashes
// on Windows, where Git Bash still hands tmux `x;` for a typed `x\;`: there
// the word's own `\;` ends the command too. The word before the end, or null.
const ESCAPED_SEMICOLON = String.raw`\;`;

function tmuxCommandEnd(value, platform = process.platform) {
  if (platform === 'win32') {
    if (!/(^|[^\\])\\?;$/.test(value)) return null;
    return value.slice(0, value.length - (value.endsWith(ESCAPED_SEMICOLON) ? 2 : 1));
  }
  return value.endsWith(';') && !value.endsWith(ESCAPED_SEMICOLON) ? value.slice(0, -1) : null;
}

function tmuxCommands(values) {
  const commands = [[]];
  for (const value of values) {
    const head = tmuxCommandEnd(value);
    const word = head ?? value;
    if (word) commands.at(-1).push(word);
    if (head !== null) commands.push([]);
  }
  return commands.filter(command => command.length > 0);
}

// A tmux command line given as one word, for the hook to read again.
const tmuxLine = line => `tmux ${line}`;

// Keys send-keys types: named keys that make text, others that make none.
const KEY_TEXT = new Map([['enter', '\n'], ['c-m', '\n'], ['kpenter', '\n'], ['c-j', '\n'], ['space', ' '], ['tab', '\t'], ['c-i', '\t']]);
const KEY_NAMES = new Set([
  'escape', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'npage', 'ppage',
  'bspace', 'btab', 'dc', 'ic', 'insert', 'delete',
]);
const isKeyName = name => KEY_NAMES.has(name) || /^(?:[cms]-)+./.test(name) || /^f\d{1,2}$/.test(name) || /^kp./.test(name);

function typedKey(key) {
  const name = key.toLowerCase();
  if (KEY_TEXT.has(name)) return KEY_TEXT.get(name);
  return isKeyName(name) ? '' : key;
}

function typedKeys(keys, options) {
  if (options.set.has('X')) return [];
  let text;
  if (options.set.has('H')) text = keys.map(hex => String.fromCodePoint(Number.parseInt(hex, 16) || 0)).join('');
  else if (options.set.has('l')) text = keys.join('');
  else text = keys.map(typedKey).join('');
  return text.trim() ? [text] : [];
}

function tmuxOption(operands) {
  const [name, value] = operands;
  if (value === undefined) return [];
  if (name === 'default-command') return [value];
  return name === 'default-shell' ? [singleQuoted(value)] : [];
}

function runsOfTmuxCommand(name, operands, options) {
  switch (TMUX_RUNNERS[name].runs) {
    case 'command': return operands.length > 0 ? [commandLine(operands)] : [];
    case 'run': return options.set.has('C') ? operands.map(tmuxLine) : operands.slice(0, 1);
    case 'if': return [...(options.set.has('F') ? [] : operands.slice(0, 1)), ...operands.slice(1).map(tmuxLine)];
    case 'keys': return typedKeys(operands, options);
    case 'tmux': return operands.slice(0, 1).map(tmuxLine);
    case 'bind': return operands.length > 1 ? [tmuxLine(argvLine(operands.slice(1)))] : [];
    case 'hook': return operands.slice(1, 2).map(tmuxLine);
    default: return tmuxOption(operands);
  }
}

// What the tmux commands in `values` (a command and its words, `;`
// separated) run.
function tmuxWords(values) {
  return tmuxCommands(values).flatMap(command => {
    const name = tmuxCommandName(command[0]);
    if (!TMUX_RUNNERS[name]) return [];
    const options = readShortOptions(command, 1, TMUX_RUNNERS[name].values);
    return runsOfTmuxCommand(name, command.slice(options.end), options);
  });
}

function tmuxRuns(values) {
  const options = readShortOptions(values, 1, TMUX_GLOBAL_VALUES);
  const shell = options.given.has('c') ? [options.given.get('c')] : [];
  return [...shell, ...tmuxWords(values.slice(options.end))];
}

// screen's options: the letters that take a value, the words that are one
// option of their own (with how many values they take), the words after
// which it starts nothing, and the letters that act on the session named
// next (-d and -D start one when -m goes with them).
const SCREEN_VALUES = 'cehpSTts';
const SCREEN_WORD_OPTIONS = new Map([['-Logfile', 1], ['-fn', 0], ['-fa', 0], ['-ln', 0]]);
const SCREEN_LISTS = new Set(['-ls', '-list', '-wipe', '-v']);
const SCREEN_SESSION_LETTERS = /[dDrRx]/;

// Text screen's stuff types, with its escapes for the keys that end a line.
const stuffed = text => text.replaceAll(/\\[nr]|\^[MJ]|\\01[25]/g, '\n');

// What a screen command sent with -X or -Q runs.
// A screen command line split into its words, quotes read as screen reads
// them: a word is a run of quoted and bare pieces, its quotes taken off.
const SCREEN_WORD_RE = /(?:"[^"]*"|'[^']*'|[^\s"']+)+/g;
function screenLineWords(line) {
  return (String(line).match(SCREEN_WORD_RE) ?? []).map(word => word.replaceAll(/"([^"]*)"|'([^']*)'/g, '$1$2'));
}

// A command bind or bindkey keeps for a key, after the key and its options.
function carriedCommand(rest) {
  const at = rest.findIndex(word => Object.hasOwn(SCREEN_COMMANDS, word));
  return at >= 0 ? screenCommand(rest.slice(at)) : [];
}

// The screen commands that run or type a command, and those that carry one:
// eval runs each of its arguments as a screen command, at runs one in other
// windows, and bind and bindkey keep one for a key.
const SCREEN_COMMANDS = {
  stuff: rest => (rest.length > 0 && rest[0].trim() ? [stuffed(rest[0])] : []),
  exec: rest => {
    const argv = /^[.!:|]+$/.test(rest[0] ?? '') ? rest.slice(1) : rest;
    return argv.length > 0 ? [argvLine(argv)] : [];
  },
  eval: rest => rest.flatMap(line => screenCommand(screenLineWords(line))),
  at: rest => screenCommand(rest.slice(1)),
  bind: carriedCommand,
  bindkey: carriedCommand,
  screen: rest => {
    const options = readShortOptions(rest, 0, 'tThs');
    return rest.length > options.end ? [argvLine(rest.slice(options.end))] : [];
  },
};

function screenCommand(words) {
  const [name, ...rest] = words;
  return Object.hasOwn(SCREEN_COMMANDS, name) ? SCREEN_COMMANDS[name](rest) : [];
}

function screenRuns(values) {
  const runs = [];
  // -m anywhere among the options makes -d and -r start a session detached
  // instead of naming one.
  const letters = new Set();
  let i = 1;
  while (i < values.length && values[i].startsWith('-')) {
    const word = values[i];
    if (word === '-X' || word === '-Q') return [...runs, ...screenCommand(values.slice(i + 1))];
    if (SCREEN_LISTS.has(word)) return runs;
    if (SCREEN_WORD_OPTIONS.has(word)) {
      i += 1 + SCREEN_WORD_OPTIONS.get(word);
      continue;
    }
    const given = new Map();
    const next = readCluster(values, i, SCREEN_VALUES, letters, given);
    if (given.has('s')) runs.push(singleQuoted(given.get('s')));
    const namesSession = next === i + 1 && SCREEN_SESSION_LETTERS.test(word) && !letters.has('m');
    i = next;
    if (namesSession && i < values.length && !values[i].startsWith('-')) return runs;
  }
  return i < values.length ? [...runs, argvLine(values.slice(i))] : runs;
}

// ssh's options that take a value, and those after which it runs no
// command (none asked for, a printed configuration or version, a subsystem,
// a forwarding, a control or a query). Options may follow the destination.
const SSH_VALUES = 'BbcDEeFIiJLlmOoPpQRSWw';
const SSH_NO_COMMAND = 'NGVsWOQ';
// The ssh_config keywords, given with -o, whose value is a command ssh runs:
// on the remote host (RemoteCommand) or on this machine (ProxyCommand,
// LocalCommand, KnownHostsCommand), whatever else the line asks for.
const SSH_COMMAND_KEYWORDS = new Set(['remotecommand', 'proxycommand', 'localcommand', 'knownhostscommand']);

// The command an -o option gives, as `Keyword=value` or `Keyword value`
// with the keyword in any case; null for another option or for `none`.
function sshOptionCommand(option) {
  const text = String(option ?? '').trim();
  const keywordEnd = text.search(/[\s=]/);
  if (keywordEnd <= 0 || !SSH_COMMAND_KEYWORDS.has(text.slice(0, keywordEnd).toLowerCase())) return null;
  let value = text.slice(keywordEnd).trimStart();
  if (value.startsWith('=')) value = value.slice(1).trimStart();
  return value && value.toLowerCase() !== 'none' ? value : null;
}

// Reads the ssh option cluster at `i` into `letters`, keeps the command an
// -o option gives, and returns the index after it.
function readSshOption(values, i, letters, optionCommands) {
  const given = new Map();
  const next = readCluster(values, i, SSH_VALUES, letters, given);
  const command = given.has('o') ? sshOptionCommand(given.get('o')) : null;
  if (command) optionCommands.push(command);
  return next;
}

function sshRuns(values) {
  const letters = new Set();
  const optionCommands = [];
  let destination = null;
  let i = 1;
  while (i < values.length) {
    const word = values[i];
    if (word === '--') {
      i += 1;
      break;
    }
    if (word.startsWith('-') && word !== '-') i = readSshOption(values, i, letters, optionCommands);
    else if (destination === null) {
      destination = word;
      i += 1;
    } else break;
  }
  if (destination === null && i < values.length) {
    destination = values[i];
    i += 1;
  }
  const runsNothing = [...letters].some(letter => SSH_NO_COMMAND.includes(letter));
  const positional = destination === null || i >= values.length || runsNothing ? [] : [values.slice(i).join(' ')];
  return [...optionCommands, ...positional];
}

// The options of docker, podman and kubectl, before and after their exec,
// that take a value, long or short.
const CONTAINER_VALUES = new Set([
  '-c', '--context', '-H', '--host', '-l', '--log-level', '--config', '-f', '--file', '-p', '--project-name', '--profile',
  '--env-file', '--project-directory', '--tlscacert', '--tlscert', '--tlskey', '--ansi', '--parallel', '--progress',
  '-e', '--env', '-u', '--user', '-w', '--workdir', '--detach-keys', '--index',
  '-n', '--namespace', '--kubeconfig', '--cluster', '-s', '--server', '--token', '--as', '--as-group', '--request-timeout',
  '--cache-dir', '-v', '--container', '--filename', '--pod-running-timeout',
]);
const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose', 'kubectl', 'oc']);
const KUBE_TOOLS = new Set(['kubectl', 'oc']);
const CONTAINER_GROUPS = new Set(['container', 'compose']);

// The index after the options that start at `start`.
function afterLongOptions(values, start) {
  let i = start;
  while (i < values.length && values[i].startsWith('-') && values[i] !== '--') {
    i += CONTAINER_VALUES.has(values[i]) ? 2 : 1;
  }
  return i;
}

// kubectl runs what follows `--`; docker and the others what follows the
// container, past a `--` there.
function containerRuns(name, values) {
  let i = afterLongOptions(values, 1);
  while (CONTAINER_GROUPS.has(values[i])) i = afterLongOptions(values, i + 1);
  if (values[i] !== 'exec') return [];
  const dashes = values.indexOf('--', i + 1);
  let start;
  if (KUBE_TOOLS.has(name) && dashes >= 0) start = dashes + 1;
  else {
    // The container follows the options, past a `--` that ends them;
    // kubectl reads options after the pod too, docker's end at the container.
    let target = afterLongOptions(values, i + 1);
    if (values[target] === '--') target += 1;
    const after = KUBE_TOOLS.has(name) ? afterLongOptions(values, target + 1) : target + 1;
    start = values[after] === '--' ? after + 1 : after;
  }
  return values.length > start ? [argvLine(values.slice(start))] : [];
}

const HANDOFF_READERS = { tmux: tmuxRuns, screen: screenRuns, ssh: sshRuns };

// The command lines the command in `values` (its name first, the words the
// shell hands it after) hands to another process.
function handoffCommandsOf(values) {
  const name = String(values[0] ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
  if (HANDOFF_READERS[name]) return HANDOFF_READERS[name](values);
  return CONTAINER_TOOLS.has(name) ? containerRuns(name, values) : [];
}

module.exports = { tmuxCommandEnd, handoffCommandsOf };
