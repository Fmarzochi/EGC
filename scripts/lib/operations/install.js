'use strict';

const { createInstallPlanFromRequest } = require('../install/runtime');
const { applyInstallPlan } = require('../install-executor');

function installPlanOperation(params = {}) {
  const request = params.request || params;
  const options = params.options || {};
  return createInstallPlanFromRequest(request, options);
}

function installApplyOperation(params = {}) {
  const plan = params.plan || params;
  return applyInstallPlan(plan);
}

module.exports = {
  installPlanOperation,
  installApplyOperation,
};
