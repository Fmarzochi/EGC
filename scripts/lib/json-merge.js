'use strict';

// JSON merge helpers shared by the installer (install/apply.js) and the
// lifecycle (install-lifecycle.js): one copy of the prototype-key invariant,
// so a hardening change lands in both at once.

// Keys that name the prototype chain rather than data: a payload carrying
// one of them is data from a manifest or a config file, never a request to
// change what every object inherits.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return structuredClone(value);
}

// A deep copy of a JSON value with every prototype key dropped from every
// plain object in it, arrays included, so no payload read from disk carries
// one into a config file, a merge or an uninstall.
function withoutPrototypeKeys(value) {
  if (Array.isArray(value)) {
    return value.map(withoutPrototypeKeys);
  }
  if (!isPlainObject(value)) {
    return cloneJsonValue(value);
  }
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROTOTYPE_KEYS.has(key)) clean[key] = withoutPrototypeKeys(entry);
  }
  return clean;
}

function deepMergeJson(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return withoutPrototypeKeys(patchValue);
  }

  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    if (isPlainObject(value)) {
      merged[key] = deepMergeJson(isPlainObject(merged[key]) ? merged[key] : {}, value);
    } else {
      merged[key] = withoutPrototypeKeys(value);
    }
  }
  return merged;
}

module.exports = {
  PROTOTYPE_KEYS,
  cloneJsonValue,
  deepMergeJson,
  isPlainObject,
  withoutPrototypeKeys,
};
