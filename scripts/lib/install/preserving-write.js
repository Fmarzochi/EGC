'use strict';

const fs = require('node:fs');

// Files the installer and its repair replay manage land in one atomic
// replacement: the content is written next to the destination and renamed
// over it, so a hard link at the destination is replaced instead of written
// through, and nothing outside the managed location is modified.
function replaceFileWith(destinationPath, writeTemporary) {
  let existingMode;
  try {
    existingMode = fs.statSync(destinationPath).mode & 0o777;
  } catch {
    existingMode = null;
  }
  const temporary = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeTemporary(temporary);
    if (existingMode !== null) fs.chmodSync(temporary, existingMode);
    fs.renameSync(temporary, destinationPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// A destination created here takes the source's permission bits (an MCP
// file may carry credentials and be mode-restricted); one that already
// exists keeps the mode its owner chose.
function writeTextKeepingMode(destinationPath, text, sourcePath) {
  const sourceMode = fs.statSync(sourcePath).mode & 0o777;
  replaceFileWith(destinationPath, temporary => {
    fs.writeFileSync(temporary, text);
    fs.chmodSync(temporary, sourceMode);
  });
}

function copyFileKeepingMode(sourcePath, destinationPath) {
  replaceFileWith(destinationPath, temporary => fs.copyFileSync(sourcePath, temporary));
}

module.exports = { copyFileKeepingMode, replaceFileWith, writeTextKeepingMode };
