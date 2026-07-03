#!/usr/bin/env node

const {
  readBudgetConfig,
  writeBudgetConfig,
  readBudgetUsage,
  checkBudget,
  resetBudgetUsage,
  getDefaultBudget,
} = require('./lib/budget-tracker');

function showHelp() {
  console.log(`
EGC Budget Guardian — Set token/cost limits per session

Usage:
  egc budget set [--tokens <n>] [--cost <$>] [--warn-at <n>] [--action warn|block]
  egc budget status
  egc budget reset

Commands:
  set      Configure budget limits (max tokens, max cost, warning threshold, action)
  status   Show current budget config and session usage
  reset    Reset session usage counter

Options:
  --tokens      Maximum tokens per session (e.g. 100000)
  --cost        Maximum cost in USD per session (e.g. 2.00)
  --warn-at     Warning threshold percent (default: 80)
  --action      Action when threshold is exceeded: warn (default) or block

Examples:
  egc budget set --tokens 100000
  egc budget set --cost 2.00 --warn-at 75 --action block
  egc budget status
  egc budget reset
`);
}

async function main() {
  const args = process.argv.slice(3);
  const firstArg = args[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (firstArg) {
    case 'set': {
      const tokensIdx = args.indexOf('--tokens');
      const costIdx = args.indexOf('--cost');
      const warnAtIdx = args.indexOf('--warn-at');
      const actionIdx = args.indexOf('--action');

      const maxTokens = tokensIdx !== -1 ? parseInt(args[tokensIdx + 1], 10) : undefined;
      const maxCost = costIdx !== -1 ? parseFloat(args[costIdx + 1]) : undefined;
      const warnAtPercent = warnAtIdx !== -1 ? parseInt(args[warnAtIdx + 1], 10) : undefined;
      const action = actionIdx !== -1 ? args[actionIdx + 1] : undefined;

      if (maxTokens !== undefined && (isNaN(maxTokens) || maxTokens <= 0)) {
        console.error('Error: --tokens must be a positive integer');
        process.exit(1);
      }
      if (maxCost !== undefined && (isNaN(maxCost) || maxCost <= 0)) {
        console.error('Error: --cost must be a positive number');
        process.exit(1);
      }
      if (warnAtPercent !== undefined && (isNaN(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 100)) {
        console.error('Error: --warn-at must be between 1 and 100');
        process.exit(1);
      }
      if (action !== undefined && action !== 'warn' && action !== 'block') {
        console.error('Error: --action must be "warn" or "block"');
        process.exit(1);
      }

      const existing = readBudgetConfig() || getDefaultBudget();
      const config = {
        max_tokens: maxTokens !== undefined ? maxTokens : existing.max_tokens,
        max_cost_usd: maxCost !== undefined ? maxCost : existing.max_cost_usd,
        warn_at_percent: warnAtPercent !== undefined ? warnAtPercent : existing.warn_at_percent,
        action: action !== undefined ? action : existing.action,
      };

      writeBudgetConfig(config);
      console.log('Budget config saved:');
      console.log(`  Max tokens: ${config.max_tokens !== null ? config.max_tokens.toLocaleString() : 'not set'}`);
      console.log(`  Max cost:   ${config.max_cost_usd !== null ? `$${config.max_cost_usd.toFixed(2)}` : 'not set'}`);
      console.log(`  Warn at:    ${config.warn_at_percent}%`);
      console.log(`  Action:     ${config.action}`);
      break;
    }

    case 'status': {
      const config = readBudgetConfig();
      if (!config) {
        console.log('Budget guardian: not configured');
        console.log('Set a budget with: egc budget set --tokens 100000');
        process.exit(0);
      }

      const usage = readBudgetUsage();
      const maxTokens = config.max_tokens;
      const maxCost = config.max_cost_usd;

      console.log('Budget Config:');
      if (maxTokens) {
        const pct = Math.round((usage.tokens_used / maxTokens) * 100);
        console.log(`  Tokens:     ${usage.tokens_used.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%)`);
      } else {
        console.log(`  Tokens:     ${usage.tokens_used.toLocaleString()} (no limit)`);
      }
      if (maxCost) {
        const pct = Math.round((usage.cost_usd / maxCost) * 100);
        console.log(`  Cost:       $${usage.cost_usd.toFixed(4)} / $${maxCost.toFixed(2)} (${pct}%)`);
      } else {
        console.log(`  Cost:       $${usage.cost_usd.toFixed(4)} (no limit)`);
      }
      console.log(`  Tool calls: ${usage.tool_calls}`);
      console.log(`  Warn at:    ${config.warn_at_percent}%`);
      console.log(`  Action:     ${config.action}`);
      console.log(`  Session:    ${usage.session_start}`);

      const check = checkBudget();
      if (check.block) {
        console.log(`\n  Status:     BLOCKED — ${check.reason}`);
      } else if (check.warn) {
        console.log(`\n  Status:     WARNING — ${check.reason}`);
      } else if (config.max_tokens || config.max_cost_usd) {
        console.log(`\n  Status:     OK — within budget`);
      }
      break;
    }

    case 'reset': {
      resetBudgetUsage();
      console.log('Session budget usage reset.');
      console.log(`  Tokens:     0`);
      console.log(`  Cost:       $0.00`);
      console.log(`  Tool calls: 0`);
      break;
    }

    default:
      console.error(`Unknown budget subcommand: ${firstArg}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
