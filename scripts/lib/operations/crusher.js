'use strict';

const { readAll, aggregateBreakdown } = require('../crusher/metrics');

function crusherSavingsOperation(params = {}) {
  const entries = params.entries || readAll();
  const report = aggregateBreakdown(entries, params.options || {});
  return {
    ...report.sinceInstall,
    ...report,
    entries: entries.length,
  };
}

module.exports = {
  crusherSavingsOperation,
};
