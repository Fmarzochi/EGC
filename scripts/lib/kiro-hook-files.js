'use strict';

const fs = require('node:fs');
const { writeProtocolFile } = require('./protocol-file-write');

function serializeHookDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function writeOwnedHookFile(hookFilePath, document) {
  const desired = serializeHookDocument(document);
  try {
    if (fs.readFileSync(hookFilePath, 'utf8') === desired) {
      return { changed: false };
    }
  } catch { /* missing or unreadable: write below */ }
  writeProtocolFile(hookFilePath, desired);
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
  try {
    const onDisk = JSON.parse(fs.readFileSync(hookFilePath, 'utf8'));
    return JSON.stringify(onDisk) === JSON.stringify(document) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

module.exports = {
  inspectOwnedHookFile,
  removeOwnedHookFile,
  writeOwnedHookFile,
};
