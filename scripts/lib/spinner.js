'use strict';

// Live progress line for long steps in the installers. On an interactive
// terminal the frame spins in place and the line is cleared before the
// result is printed; without a TTY (CI logs, output piped to a file) the
// label is printed once as a plain line and nothing else is written, so
// logs never carry carriage returns or escape sequences.

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];

// The legacy Windows console (cmd.exe, PowerShell 5.1) renders braille as
// boxes; Windows Terminal and the VS Code terminal render it fine.
function frameSet(environment = {}, platform = process.platform) {
  if (platform === 'win32' && !environment.WT_SESSION && environment.TERM_PROGRAM !== 'vscode') {
    return ASCII_FRAMES;
  }
  return BRAILLE_FRAMES;
}

function createSpinner(options = {}) {
  const stream = options.stream || process.stdout;
  const intervalMs = options.interval || 80;
  const indent = options.indent === undefined ? '  ' : options.indent;
  const frames = frameSet(options.environment || process.env, options.platform);
  const live = Boolean(stream.isTTY);

  let timer = null;
  let label = '';
  let index = 0;

  function render() {
    stream.write(`\r${indent}${frames[index]}  ${label}\x1b[K`);
    index = (index + 1) % frames.length;
  }

  function start(text) {
    label = text;
    if (!live) {
      stream.write(`${indent}${text}\n`);
      return;
    }
    render();
    timer = setInterval(render, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function update(text) {
    label = text;
    if (!live) {
      stream.write(`${indent}${text}\n`);
      return;
    }
    render();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (live) stream.write('\r\x1b[K');
  }

  return { start, update, stop, live };
}

module.exports = { createSpinner, frameSet, BRAILLE_FRAMES, ASCII_FRAMES };
