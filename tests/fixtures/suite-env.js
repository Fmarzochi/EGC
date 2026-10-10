'use strict';

/**
 * The environment tests/run-all.js gives every test file. The variables a
 * tool session sets come out (harness-variables.js), so do the ones that
 * move a tool's config directory away from the home a test passes, and git runs no
 * automatic maintenance: since Git 2.54 the maintenance a commit starts in
 * the background prunes a worktree a test builds by hand, and on Windows it
 * can still hold a repository a test is removing (#1718).
 *
 * The Guardian hook gets the budget of a CLI probe instead of the four
 * seconds a person gets: a hook test starts the validator fixture in a
 * fresh Node process for every command it judges, and a loaded Windows
 * runner took longer than four seconds to start one (a lane of #1846 on
 * 2026-10-10 fell on `echo 'ls' | sh` with a verdict never given). The
 * tests that exercise the timeout itself pass their own budget.
 */

const { withoutHarnessVariables, withoutConfigHomeVariables } = require('./harness-variables');
const { CLI_TIMEOUT_MS } = require('./subprocess-timeouts');

const NO_AUTO_MAINTENANCE = "'maintenance.auto'='false'";

function suiteEnv(env) {
  const copy = withoutConfigHomeVariables(withoutHarnessVariables(env));
  const existing = copy.GIT_CONFIG_PARAMETERS;
  copy.GIT_CONFIG_PARAMETERS = existing ? `${existing} ${NO_AUTO_MAINTENANCE}` : NO_AUTO_MAINTENANCE;
  copy.EGC_GUARDIAN_TIMEOUT_MS = String(CLI_TIMEOUT_MS);
  return copy;
}

module.exports = { suiteEnv };
