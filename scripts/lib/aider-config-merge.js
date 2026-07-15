'use strict';

const yaml = require('js-yaml');

const MERGE_YAML_READ_LIST_KIND = 'merge-yaml-read-list';

// Aider's .aider.conf.yml read: key accepts a list of file paths that get
// loaded into every session's context. Adding an entry must never touch any
// other key already in the file (model settings, lint commands, etc).
function mergeAiderConfigReadList(existingContent, readEntry) {
  const parsed = existingContent ? yaml.load(existingContent) : null;
  const config = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};

  const existingList = Array.isArray(config.read) ? config.read.slice() : [];
  if (!existingList.includes(readEntry)) {
    existingList.push(readEntry);
  }

  const merged = { ...config, read: existingList };
  return yaml.dump(merged);
}

const REMOVE_SENTINEL = Symbol('aider-config-remove-file');

// Inverse of mergeAiderConfigReadList: strips only the given entry from the
// read: list. If that leaves the config with no read: entries and no other
// keys (i.e. this file only ever existed because EGC created it), signals
// the caller to delete the file instead of leaving an empty stub behind.
function removeAiderConfigReadEntry(existingContent, readEntry) {
  if (!existingContent) {
    return REMOVE_SENTINEL;
  }

  const parsed = yaml.load(existingContent);
  const config = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const existingList = Array.isArray(config.read) ? config.read : [];
  const nextList = existingList.filter(entry => entry !== readEntry);

  const nextConfig = { ...config };
  if (nextList.length > 0) {
    nextConfig.read = nextList;
  } else {
    delete nextConfig.read;
  }

  if (Object.keys(nextConfig).length === 0) {
    return REMOVE_SENTINEL;
  }

  return yaml.dump(nextConfig);
}

module.exports = {
  MERGE_YAML_READ_LIST_KIND,
  REMOVE_SENTINEL,
  mergeAiderConfigReadList,
  removeAiderConfigReadEntry,
};
