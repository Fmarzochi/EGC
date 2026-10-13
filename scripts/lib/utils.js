/**
 * Cross-platform utility functions for EGC hooks and scripts.
 * Works on Windows, macOS and Linux.
 *
 * Thin re-export over four split modules: platform detection and shell
 * commands (utils-platform), EGC/home/session directories (utils-paths),
 * date/time plus session and project naming (utils-session), and file
 * content operations, string sanitisation, hook I/O and forensic tracing
 * (utils-file). The path and the exported keys below stay exactly as they
 * were, so nothing that imports this module needs to change.
 */

const platform = require('./utils-platform');
const paths = require('./utils-paths');
const session = require('./utils-session');
const file = require('./utils-file');

module.exports = {
  // Platform info
  isWindows: platform.isWindows,
  isMacOS: platform.isMacOS,
  isLinux: platform.isLinux,

  // Forensics
  trace: file.trace,

  // Directories
  getHomeDir: paths.getHomeDir,
  getEGCDir: paths.getEGCDir,
  getLearningDir: paths.getLearningDir,
  resolveEGCDir: paths.resolveEGCDir,
  getKnownHarnessDirs: paths.getKnownHarnessDirs,
  resolveHarnessDirFromEnv: paths.resolveHarnessDirFromEnv,
  getClaudeDir: paths.getClaudeDir, // NOSONAR: deprecated alias kept as a public export for backward compatibility
  getSessionsDir: paths.getSessionsDir,
  getLegacySessionsDir: paths.getLegacySessionsDir,
  getSessionSearchDirs: paths.getSessionSearchDirs,
  getLearnedSkillsDir: paths.getLearnedSkillsDir,
  getTempDir: paths.getTempDir,
  ensureDir: paths.ensureDir,
  ensurePrivateDir: paths.ensurePrivateDir,

  // Date/Time
  getDateString: session.getDateString,
  getTimeString: session.getTimeString,
  getDateTimeString: session.getDateTimeString,

  // Session/Project
  sanitizeSessionId: session.sanitizeSessionId,
  getSessionIdShort: session.getSessionIdShort,
  getGitRepoName: session.getGitRepoName,
  getProjectName: session.getProjectName,

  // File operations
  findFiles: file.findFiles,
  readFile: file.readFile,
  writeFile: file.writeFile,
  appendFile: file.appendFile,
  replaceInFile: file.replaceInFile,
  countInFile: file.countInFile,
  grepFile: file.grepFile,

  // String sanitisation
  stripAnsi: file.stripAnsi,
  formatOSC8: file.formatOSC8,

  // Hook I/O
  readStdinJson: file.readStdinJson,
  readHookStdin: file.readHookStdin,
  readHookInput: file.readHookInput,
  log: file.log,
  output: file.output,

  // System
  commandExists: platform.commandExists,
  runCommand: platform.runCommand,
  isGitRepo: platform.isGitRepo,
  getGitModifiedFiles: platform.getGitModifiedFiles,
};
