const path = require('node:path');
const { applyCommitPrivacyFilterCli } = require('./memory-filters');

// The repo root is fixed relative to this file (scripts/lib/ sits two levels
// below it). Deriving it from __dirname instead of argv keeps externally
// influenced strings out of the git-config command this ultimately feeds;
// mcp-register-cli and dashboard-launch resolve their paths the same way.
const rootDir = path.join(__dirname, '..', '..');

applyCommitPrivacyFilterCli({
  projectDir: process.cwd(),
  scriptPath: path.join(rootDir, 'scripts', 'check-state-leak.js'),
  log: (m) => console.log('  ' + m)
});
