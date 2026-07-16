'use strict';

function pushSegment(current, segments) {
  if (current.trim()) segments.push(current.trim());
}

function handleInsideQuotes(ch, i, command, quote) {
  if (ch === '\\' && i + 1 < command.length) {
    return { chars: ch + command[i + 1], advance: 1, closeQuote: false };
  }
  return { chars: ch, advance: 0, closeQuote: ch === quote };
}

function handleEscape(ch, i, command) {
  if (ch === '\\' && i + 1 < command.length) {
    return { chars: ch + command[i + 1], advance: 1, handled: true };
  }
  return { handled: false };
}

function handleDoubleOperator(ch, next, current, segments) {
  if (ch === '&' && next === '&') {
    pushSegment(current, segments);
    return { current: '', advance: 1, handled: true };
  }
  if (ch === '|' && next === '|') {
    pushSegment(current, segments);
    return { current: '', advance: 1, handled: true };
  }
  return { handled: false };
}

function handleSingleAmpersand(ch, next, prev, current, segments) {
  if (ch !== '&') return { handled: false };
  if (next === '>' || prev === '>') {
    return { current: current + ch, handled: true };
  }
  pushSegment(current, segments);
  return { current: '', handled: true };
}

/**
 * Split a shell command into segments by operators (&&, ||, ;, &)
 * while respecting quoting (single/double) and escaped characters.
 * Redirection operators (&>, >&, 2>&1) are NOT treated as separators.
 */
function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      const r = handleInsideQuotes(ch, i, command, quote);
      current += r.chars;
      i += r.advance;
      if (r.closeQuote) quote = null;
      continue;
    }

    const esc = handleEscape(ch, i, command);
    if (esc.handled) {
      current += esc.chars;
      i += esc.advance;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const next = command[i + 1] || '';
    const prev = i > 0 ? command[i - 1] : '';

    const dbl = handleDoubleOperator(ch, next, current, segments);
    if (dbl.handled) {
      current = dbl.current;
      i += dbl.advance;
      continue;
    }

    if (ch === ';') {
      pushSegment(current, segments);
      current = '';
      continue;
    }

    const amp = handleSingleAmpersand(ch, next, prev, current, segments);
    if (amp.handled) {
      current = amp.current;
      continue;
    }

    current += ch;
  }

  pushSegment(current, segments);
  return segments;
}

module.exports = { splitShellSegments };
