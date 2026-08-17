#!/usr/bin/env node
'use strict';

// Scrubber write hook: on Write/Edit/MultiEdit, clean the text being written
// (invisible Unicode carriers + long dashes) before it hits disk, so files are
// born clean without anyone asking. Only touches text files it is confident
// about; binary and unknown content passes through untouched. Fail-open: any
// parse or engine error emits the original input verbatim, so a crash never
// blocks or corrupts a write.

const { clean } = require('../lib/scrubber/engine');
const { looksBinary, hasTextExtension } = require('../lib/scrubber/binary-guard');

const MAX_STDIN = 4 * 1024 * 1024;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function cleanField(text) {
  if (typeof text !== 'string' || text === '') return null;
  if (looksBinary(text)) return null;
  const result = clean(text);
  return result.changed ? result.cleaned : null;
}

// Returns { changed, input }. Never mutates the original object.
function scrubToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return { changed: false, input: toolInput };

  const filePath = toolInput.file_path || toolInput.path || '';
  if (filePath && !hasTextExtension(filePath)) return { changed: false, input: toolInput };

  const next = { ...toolInput };
  let changed = false;

  if (typeof next.content === 'string') {
    const cleaned = cleanField(next.content);
    if (cleaned !== null) {
      next.content = cleaned;
      changed = true;
    }
  }

  if (typeof next.new_string === 'string') {
    const cleaned = cleanField(next.new_string);
    if (cleaned !== null) {
      next.new_string = cleaned;
      changed = true;
    }
  }

  if (Array.isArray(next.edits)) {
    next.edits = next.edits.map(edit => {
      if (edit && typeof edit === 'object' && typeof edit.new_string === 'string') {
        const cleaned = cleanField(edit.new_string);
        if (cleaned !== null) {
          changed = true;
          return { ...edit, new_string: cleaned };
        }
      }
      return edit;
    });
  }

  return { changed, input: next };
}

function passthrough(rawInput) {
  return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
}

function run(rawInput) {
  let parsed;
  try {
    parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch {
    return passthrough(rawInput);
  }

  try {
    if (!parsed || !WRITE_TOOLS.has(parsed.tool_name)) return passthrough(rawInput);
    const { changed, input } = scrubToolInput(parsed.tool_input);
    if (!changed) return passthrough(rawInput);
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: input,
      },
    });
  } catch {
    return passthrough(rawInput);
  }
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
  });
  process.stdin.on('end', () => {
    process.stdout.write(run(raw));
    process.exit(0);
  });
  process.stdin.on('error', () => {
    process.stdout.write(raw);
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { run, scrubToolInput };
