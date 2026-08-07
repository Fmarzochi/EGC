const path = require('path');
const { applyCommitPrivacyFilterCli } = require('./memory-filters');

const rootDir = process.argv[2] || process.cwd();
const scriptPath = path.join(rootDir, 'scripts', 'check-state-leak.js');

try {
  applyCommitPrivacyFilterCli({
    projectDir: process.cwd(),
    scriptPath: scriptPath,
    log: (m) => console.log('  ' + m)
  });
} catch (err) {
  console.log(`  note: commit-privacy filter setup failed (non-fatal): ${err.message}`);
  process.exitCode = 1;
}
