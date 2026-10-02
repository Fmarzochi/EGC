'use strict';

/**
 * The environment tests/run-all.js gives every test file. The variables a
 * tool session sets come out (harness-variables.js), and git runs no
 * automatic maintenance: since Git 2.54 the maintenance a commit starts in
 * the background prunes a worktree a test builds by hand, and on Windows it
 * can still hold a repository a test is removing (#1718).
 */

const { withoutHarnessVariables } = require('./harness-variables');

const NO_AUTO_MAINTENANCE = "'maintenance.auto'='false'";

function suiteEnv(env) {
  const copy = withoutHarnessVariables(env);
  const existing = copy.GIT_CONFIG_PARAMETERS;
  copy.GIT_CONFIG_PARAMETERS = existing ? `${existing} ${NO_AUTO_MAINTENANCE}` : NO_AUTO_MAINTENANCE;
  return copy;
}

module.exports = { suiteEnv };
