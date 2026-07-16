'use strict';

const path = require('node:path');

function toCursorAgentFileName(fileName) {
  if (!fileName || fileName.startsWith('egc-')) {
    return fileName;
  }

  return `egc-${fileName}`;
}

function toCursorAgentRelativePath(relativePath) {
  const segments = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return relativePath;
  }

  const fileName = segments.pop();
  return path.join(...segments, toCursorAgentFileName(fileName));
}

module.exports = {
  toCursorAgentFileName,
  toCursorAgentRelativePath,
};
