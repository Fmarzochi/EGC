'use strict';

const { checkBudget, recordToolCall } = require('../lib/budget-tracker');

function getToolName(input) {
  if (!input || typeof input !== 'object') return 'Bash';
  const toolInput = input.tool_input || input.params?.arguments || {};
  if (input.tool) return input.tool;
  if (toolInput.name) return toolInput.name;
  if (toolInput.command !== undefined) return 'Bash';
  if (toolInput.file_path !== undefined || toolInput.file !== undefined) return 'Edit';
  if (toolInput.content !== undefined && toolInput.filePath !== undefined) return 'Write';
  return 'Bash';
}

function estimateExtraTokens(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return 0;
  const text = JSON.stringify(toolInput);
  return Math.ceil(text.length / 4);
}

function parseInput(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function run(rawInput) {
  const input = parseInput(rawInput);
  const toolName = getToolName(input);
  const toolInput = input.tool_input || input.params?.arguments || {};
  const extraTokens = estimateExtraTokens(toolName, toolInput);

  recordToolCall(toolName, extraTokens);

  const budgetCheck = checkBudget();

  if (budgetCheck.block) {
    const msg = `[EGC Budget Guardian] BLOCKED: ${budgetCheck.reason}`;
    return { exitCode: 2, stderr: msg + '\n' };
  }

  if (budgetCheck.warn) {
    console.error(`[EGC Budget Guardian] WARNING: ${budgetCheck.reason}`);
  }

  return { exitCode: 0 };
}

module.exports = { run };
