const path = require('path');
const { applyCommitPrivacyFilterCli } = require('./memory-filters');

const scriptPath = process.argv[2]
  ? path.resolve(process.argv[2], 'scripts', 'check-state-leak.js')
  : undefined;

applyCommitPrivacyFilterCli({
  projectDir: process.cwd(),
  scriptPath: scriptPath,
  log: (m) => console.log('  ' + m)
});
