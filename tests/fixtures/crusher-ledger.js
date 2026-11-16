'use strict';

// One way to seed the Token Crusher ledger for a test: the rows go to the
// place the product reads them from (<home>/.egc/metrics/crusher.jsonl) and
// the environment a spawned egc gain needs comes back ready, so no suite
// repeats the mkdir, the JSONL join and the three variables by hand (#2146).

const fs = require('node:fs');
const path = require('node:path');

/**
 * Writes the rows as JSONL under the given home and returns the paths and the
 * environment that point a child process at them.
 *
 * @param {string} home A temporary directory the test owns.
 * @param {Array<object>} rows Ledger entries (ts, kind, cmd, layer, tokensSaved, bytesIn, bytesOut, ...).
 * @returns {{ home: string, ledgerDir: string, ledgerPath: string, env: Record<string, string> }}
 */
function seedLedger(home, rows) {
  const ledgerDir = path.join(home, '.egc', 'metrics');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = path.join(ledgerDir, 'crusher.jsonl');
  fs.writeFileSync(ledgerPath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  return {
    home,
    ledgerDir,
    ledgerPath,
    env: { ...process.env, HOME: home, USERPROFILE: home, EGC_CRUSHER_METRICS_FILE: ledgerPath },
  };
}

module.exports = { seedLedger };
