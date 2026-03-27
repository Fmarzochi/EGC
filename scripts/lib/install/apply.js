'use strict';

const fs = require('fs');
const path = require('path');

const { writeInstallState } = require('../install-state');

function mergeHookEntries(existingEntries, incomingEntries) {
  const mergedEntries = [];
  const seenEntries = new Set();

  for (const entry of [...existingEntries, ...incomingEntries]) {
    const entryKey = JSON.stringify(entry);
    if (seenEntries.has(entryKey)) {
      continue;
    }

    seenEntries.add(entryKey);
    mergedEntries.push(entry);
  }

  return mergedEntries;
}

function mergeHooksIntoSettings(plan) {
  if (!plan.adapter || plan.adapter.target !== 'claude') {
    return;
  }

  const hooksJsonPath = path.join(plan.targetRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) {
    return;
  }

  let hooksConfig;
  try {
    hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse hooks config at ${hooksJsonPath}: ${error.message}`);
  }

  const incomingHooks = hooksConfig.hooks;
  if (!incomingHooks || typeof incomingHooks !== 'object' || Array.isArray(incomingHooks)) {
    return;
  }

  const settingsPath = path.join(plan.targetRoot, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to parse existing settings at ${settingsPath}: ${error.message}`);
    }
  }

  const existingHooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const mergedHooks = { ...existingHooks };

  for (const [eventName, incomingEntries] of Object.entries(incomingHooks)) {
    const currentEntries = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
    const nextEntries = Array.isArray(incomingEntries) ? incomingEntries : [];
    mergedHooks[eventName] = mergeHookEntries(currentEntries, nextEntries);
  }

  const mergedSettings = {
    ...settings,
    hooks: mergedHooks,
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2) + '\n', 'utf8');
}

function applyInstallPlan(plan) {
  for (const operation of plan.operations) {
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.copyFileSync(operation.sourcePath, operation.destinationPath);
  }

  mergeHooksIntoSettings(plan);
  writeInstallState(plan.installStatePath, plan.statePreview);

  return {
    ...plan,
    applied: true,
  };
}

module.exports = {
  applyInstallPlan,
};
