'use strict';

function pushSegment(current, segments) {
  if (current.trim()) segments.push(current.trim());
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

    // Inside quotes: handle escapes and closing quote
    if (quote) {
      if (ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    // Backslash escape outside quotes
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1];
      i++;
      continue;
    }

    // Opening quote
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const next = command[i + 1] || '';
    const prev = i > 0 ? command[i - 1] : '';

    // && operator
    if (ch === '&' && next === '&') {
      pushSegment(current, segments);
      current = '';
      i++;
      continue;
    }

    // || operator
    if (ch === '|' && next === '|') {
      pushSegment(current, segments);
      current = '';
      i++;
      continue;
    }

    // ; separator
    if (ch === ';') {
      pushSegment(current, segments);
      current = '';
      continue;
    }

    // Single & — but skip redirection patterns (&>, >&, digit>&)
    if (ch === '&' && next !== '&') {
      if (next === '>' || prev === '>') {
        current += ch;
        continue;
      }
      pushSegment(current, segments);
      current = '';
      continue;
    }

    current += ch;
  }

  pushSegment(current, segments);
  return segments;
}

module.exports = { splitShellSegments };
