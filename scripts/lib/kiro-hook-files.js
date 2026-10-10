'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { writeProtocolFile } = require('./protocol-file-write');

function serializeHookDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readHookDocument(hookFilePath) {
  try {
    return { found: true, value: JSON.parse(fs.readFileSync(hookFilePath, 'utf8')) };
  } catch {
    return { found: false };
  }
}

function matchesDocument(hookFilePath, document) {
  const onDisk = readHookDocument(hookFilePath);
  return onDisk.found && isDeepStrictEqual(onDisk.value, document);
}

function writeOwnedHookFile(hookFilePath, document) {
  if (matchesDocument(hookFilePath, document)) {
    return { changed: false };
  }
  writeProtocolFile(hookFilePath, serializeHookDocument(document));
  return { changed: true };
}

function removeOwnedHookFile(hookFilePath) {
  try {
    fs.unlinkSync(hookFilePath);
    return { changed: true };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { changed: false };
    }
    throw error;
  }
}

function inspectOwnedHookFile(hookFilePath, document) {
  return matchesDocument(hookFilePath, document) ? 'ok' : 'drifted';
}

module.exports = {
  inspectOwnedHookFile,
  removeOwnedHookFile,
  writeOwnedHookFile,
};
