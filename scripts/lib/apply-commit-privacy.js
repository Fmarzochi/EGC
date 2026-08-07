const path = require('path');
const { applyCommitPrivacyFilterCli } = require('./apply-commit-privacy-filter-cli');

const scriptPath = process.argv[2]
  ? path.resolve(process.argv[2], 'scripts', 'git-hooks', 'commit-privacy-filter.js')
  : undefined;

applyCommitPrivacyFilterCli({
  projectDir: process.cwd(),
  scriptPath: scriptPath,
  log: (m) => console.log('  ' + m)
});
