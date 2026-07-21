'use strict';

const fs = require('fs');

function readFileDelta(filePath, lastSize) {
  const fd = fs.openSync(filePath, 'r');

  try {
    const stat = fs.fstatSync(fd);

    if (stat.size < lastSize) lastSize = 0;
    if (stat.size <= lastSize) {
      return { chunk: null, newSize: lastSize };
    }

    const buffer = Buffer.alloc(stat.size - lastSize);
    const bytesRead = fs.readSync(
      fd,
      buffer,
      0,
      buffer.length,
      lastSize
    );

    return {
      chunk: buffer.subarray(0, bytesRead).toString('utf8'),
      newSize: lastSize + bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readFileDelta };
