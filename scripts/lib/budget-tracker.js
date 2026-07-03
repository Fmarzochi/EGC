'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUDGET_CONFIG_PATH = path.join(os.homedir(), '.egc', 'budget.json');
const BUDGET_USAGE_PATH = path.join(os.homedir(), '.egc', 'state', 'budget-usage.json');

const TOOL_COST_ESTIMATES = {
  Read:     { tokens: 500,   cost: 0.001 },
  Write:    { tokens: 1500,  cost: 0.003 },
  Edit:     { tokens: 2000,  cost: 0.004 },
  Bash:     { tokens: 3000,  cost: 0.006 },
  Glob:     { tokens: 300,   cost: 0.0005 },
  Grep:     { tokens: 800,   cost: 0.0015 },
  Task:     { tokens: 10000, cost: 0.02 },
};

const DEFAULT_TOOL_COST = { tokens: 1000, cost: 0.002 };

function getDefaultBudget() {
  return {
    max_tokens: null,
    max_cost_usd: null,
    warn_at_percent: 80,
    action: 'warn',
  };
}

function readBudgetConfig() {
  try {
    if (fs.existsSync(BUDGET_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(BUDGET_CONFIG_PATH, 'utf-8'));
      return { ...getDefaultBudget(), ...data };
    }
  } catch {
    // corrupt config, return defaults
  }
  return null;
}

function writeBudgetConfig(config) {
  const dir = path.dirname(BUDGET_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(BUDGET_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function readBudgetUsage() {
  try {
    if (fs.existsSync(BUDGET_USAGE_PATH)) {
      return JSON.parse(fs.readFileSync(BUDGET_USAGE_PATH, 'utf-8'));
    }
  } catch {
    // corrupt usage, reset
  }
  return { tokens_used: 0, cost_usd: 0, tool_calls: 0, session_start: new Date().toISOString() };
}

function writeBudgetUsage(usage) {
  const dir = path.dirname(BUDGET_USAGE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(BUDGET_USAGE_PATH, JSON.stringify(usage, null, 2), 'utf-8');
}

function getToolCost(toolName) {
  return TOOL_COST_ESTIMATES[toolName] || DEFAULT_TOOL_COST;
}

function recordToolCall(toolName, extraTokens) {
  const usage = readBudgetUsage();
  const cost = getToolCost(toolName);
  const tokens = cost.tokens + (extraTokens || 0);
  usage.tokens_used += tokens;
  usage.cost_usd = parseFloat((usage.cost_usd + cost.cost).toFixed(6));
  usage.tool_calls += 1;
  writeBudgetUsage(usage);
  return usage;
}

function checkBudget() {
  const config = readBudgetConfig();
  if (!config) {
    return { withinBudget: true, usage: null, config: null };
  }

  const usage = readBudgetUsage();
  const result = { withinBudget: true, usage, config, warn: false, block: false, reason: null };

  const maxTokens = config.max_tokens;
  const maxCost = config.max_cost_usd;
  const warnPercent = (config.warn_at_percent || 80) / 100;

  let percentUsed = 0;

  if (maxTokens) {
    percentUsed = usage.tokens_used / maxTokens;
  } else if (maxCost) {
    percentUsed = usage.cost_usd / maxCost;
  }

  if (percentUsed >= 1) {
    result.withinBudget = false;
    result.block = true;
    result.reason = config.max_tokens
      ? `Budget exceeded: ${usage.tokens_used}/${config.max_tokens} tokens used`
      : `Budget exceeded: $${usage.cost_usd.toFixed(4)}/$${config.max_cost_usd.toFixed(2)} used`;
  } else if (percentUsed >= warnPercent) {
    result.warn = true;
    result.reason = config.max_tokens
      ? `Budget warning: ${usage.tokens_used}/${config.max_tokens} tokens used (${Math.round(percentUsed * 100)}%)`
      : `Budget warning: $${usage.cost_usd.toFixed(4)}/$${config.max_cost_usd.toFixed(2)} used (${Math.round(percentUsed * 100)}%)`;
    if (config.action === 'block') {
      result.withinBudget = false;
      result.block = true;
    }
  }

  return result;
}

function resetBudgetUsage() {
  const empty = { tokens_used: 0, cost_usd: 0, tool_calls: 0, session_start: new Date().toISOString() };
  writeBudgetUsage(empty);
  return empty;
}

module.exports = {
  readBudgetConfig,
  writeBudgetConfig,
  readBudgetUsage,
  recordToolCall,
  checkBudget,
  resetBudgetUsage,
  getDefaultBudget,
  BUDGET_CONFIG_PATH,
  BUDGET_USAGE_PATH,
};
