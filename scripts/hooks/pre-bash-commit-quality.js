#!/usr/bin/env node
/**
 * PreToolUse Hook: Pre-commit Quality Check
 *
 * Runs quality checks before git commit commands:
 * - Detects staged files
 * - Runs linter on staged files (if available)
 * - Checks for common issues (console.log, TODO, etc.)
 * - Validates commit message format (if provided)
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Exit codes:
 *   0 - Success (allow commit)
 *   2 - Block commit (quality issues found)
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const MAX_STDIN = 1024 * 1024; // 1MB limit

/**
 * Detect staged files for commit
 * @returns {string[]} Array of staged file paths
 */
function getStagedFiles() {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(f => f.length > 0);
}

function getStagedFileContent(filePath) {
  const result = spawnSync('git', ['show', `:${filePath}`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Check if a file should be quality-checked
 * @param {string} filePath 
 * @returns {boolean}
 */
function shouldCheckFile(filePath) {
  const checkableExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs'];
  return checkableExtensions.some(ext => filePath.endsWith(ext));
}

/**
 * Find issues in file content
 * @param {string} filePath 
 * @returns {object[]} Array of issues found
 */
function findFileIssues(filePath) {
  const issues = [];
  
  try {
    const content = getStagedFileContent(filePath);
    if (content === null || content === undefined) {
      return issues;
    }
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      
      if (line.includes('console.log') && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
        issues.push({
          type: 'console.log',
          message: `console.log found at line ${lineNum}`,
          line: lineNum,
          severity: 'warning'
        });
      }
      
      if (/\bdebugger\b/.test(line) && !line.trim().startsWith('//')) {
        issues.push({
          type: 'debugger',
          message: `debugger statement at line ${lineNum}`,
          line: lineNum,
          severity: 'error'
        });
      }
      
      // Check for TODO/FIXME without issue reference
      const todoMatch = line.match(/\/\/\s*(TODO|FIXME):?\s*(.+)/);
      if (todoMatch && !todoMatch[2].match(/#\d+|issue/i)) {
        issues.push({
          type: 'todo',
          message: `TODO/FIXME without issue reference at line ${lineNum}: "${todoMatch[2].trim()}"`,
          line: lineNum,
          severity: 'info'
        });
      }
      
      const secretPatterns = [
        { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
        { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
        { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS Access Key' },
        { pattern: /api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i, name: 'API key' }
      ];
      
      for (const { pattern, name } of secretPatterns) {
        if (pattern.test(line)) {
          issues.push({
            type: 'secret',
            message: `Potential ${name} exposed at line ${lineNum}`,
            line: lineNum,
            severity: 'error'
          });
        }
      }
    });
  } catch {
    // File not readable, skip
  }
  
  return issues;
}

/**
 * Validate commit message format
 * @param {string} command 
 * @returns {object|null} Validation result or null if no message to validate
 */
function validateCommitMessage(command) {
  // Extract commit message from command
  const messageMatch = command.match(/(?:-m|--message)[=\s]+["']?([^"']+)["']?/);
  if (!messageMatch) return null;
  
  const message = messageMatch[1];
  const issues = [];
  
  const conventionalCommit = /^(feat|fix|docs|style|refactor|test|chore|build|ci|perf|revert)(\(.+\))?:\s*.+/;
  if (!conventionalCommit.test(message)) {
    issues.push({
      type: 'format',
      message: 'Commit message does not follow conventional commit format',
      suggestion: 'Use format: type(scope): description (e.g., "feat(auth): add login flow")'
    });
  }
  
  if (message.length > 72) {
    issues.push({
      type: 'length',
      message: `Commit message too long (${message.length} chars, max 72)`,
      suggestion: 'Keep the first line under 72 characters'
    });
  }
  
  if (conventionalCommit.test(message)) {
    const afterColon = message.split(':')[1];
    if (afterColon && /^[A-Z]/.test(afterColon.trim())) {
      issues.push({
        type: 'capitalization',
        message: 'Subject should start with lowercase after type',
        suggestion: 'Use lowercase for the first letter of the subject'
      });
    }
  }
  
  if (message.endsWith('.')) {
    issues.push({
      type: 'punctuation',
      message: 'Commit message should not end with a period',
      suggestion: 'Remove the trailing period'
    });
  }
  
  return { message, issues };
}

function getPathEnv() {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return process.env[pathKey] || '';
}

function isPathLike(command) {
  return command.includes(path.sep) || (process.platform === 'win32' && /[\\/]/.test(command));
}

function getExecutableCandidates(command) {
  if (process.platform !== 'win32' || path.extname(command)) {
    return [command];
  }

  const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return [command, ...pathExt.split(';').filter(Boolean).map(ext => `${command}${ext.toLowerCase()}`)];
}

function resolveCommand(command) {
  if (isPathLike(command)) {
    return getExecutableCandidates(command).find(candidate => fs.existsSync(candidate)) || null;
  }

  for (const dir of getPathEnv().split(path.delimiter).filter(Boolean)) {
    for (const candidate of getExecutableCandidates(path.join(dir, command))) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function runLinterCommand(command, args) {
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    shell: useShell
  });
}

function commandOutput(result) {
  return result.stdout || result.stderr || result.error?.message || '';
}

/**
 * Report per-file lint issues to stderr, returning issue counts.
 * @param {string[]} filesToCheck
 * @returns {{ totalIssues: number, errorCount: number, warningCount: number, infoCount: number }}
 */
function reportLintResults(filesToCheck) {
  let totalIssues = 0;
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const file of filesToCheck) {
    const fileIssues = findFileIssues(file);
    if (fileIssues.length > 0) {
      console.error(`\n[FILE] ${file}`);
      for (const issue of fileIssues) {
        const label = issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARNING' : 'INFO';
        console.error(`  ${label} Line ${issue.line}: ${issue.message}`);
        totalIssues++;
        if (issue.severity === 'error') errorCount++;
        if (issue.severity === 'warning') warningCount++;
        if (issue.severity === 'info') infoCount++;
      }
    }
  }

  return { totalIssues, errorCount, warningCount, infoCount };
}

/**
 * Report commit message validation issues to stderr, returning issue counts.
 * @param {object} messageValidation - Result from validateCommitMessage
 * @returns {{ totalIssues: number, warningCount: number }}
 */
function reportCommitMessageIssues(messageValidation) {
  let totalIssues = 0;
  let warningCount = 0;

  if (messageValidation && messageValidation.issues.length > 0) {
    console.error('\nCommit Message Issues:');
    for (const issue of messageValidation.issues) {
      console.error(`  WARNING ${issue.message}`);
      if (issue.suggestion) {
        console.error(`     TIP ${issue.suggestion}`);
      }
      totalIssues++;
      warningCount++;
    }
  }

  return { totalIssues, warningCount };
}

function tryRunPylint(pyFiles) {
  try {
    const pylintPath = resolveCommand('pylint');
    if (!pylintPath) return null;
    const result = runLinterCommand(pylintPath, ['--output-format=text', ...pyFiles]);
    return { success: result.status === 0, output: commandOutput(result) };
  } catch {
    return null;
  }
}

function tryRunGolint(goFiles) {
  try {
    const golintPath = resolveCommand('golint');
    if (!golintPath) return null;
    const result = runLinterCommand(golintPath, goFiles);
    return { success: !result.stdout || result.stdout.trim() === '', output: commandOutput(result) };
  } catch {
    return null;
  }
}

/**
 * Run linter on staged files
 * @param {string[]} files
 * @returns {object} Lint results
 */
function runLinter(files) {
  const jsFiles = files.filter(f => /\.(js|jsx|ts|tsx)$/.test(f));
  const results = { eslint: null, pylint: null, golint: null };

  if (jsFiles.length > 0) {
    const eslintBin = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
    const eslintPath = path.join(process.cwd(), 'node_modules', '.bin', eslintBin);
    if (fs.existsSync(eslintPath)) {
      const result = runLinterCommand(eslintPath, ['--format', 'compact', ...jsFiles]);
      results.eslint = { success: result.status === 0, output: commandOutput(result) };
    }
  }

  const pyFiles = files.filter(f => f.endsWith('.py'));
  if (pyFiles.length > 0) results.pylint = tryRunPylint(pyFiles);

  const goFiles = files.filter(f => f.endsWith('.go'));
  if (goFiles.length > 0) results.golint = tryRunGolint(goFiles);

  return results;
}

function reportLinterErrors(lintResults) {
  let totalIssues = 0;
  let errorCount = 0;
  const linters = [
    { key: 'eslint', label: 'ESLint' },
    { key: 'pylint', label: 'Pylint' },
    { key: 'golint', label: 'golint' },
  ];
  for (const { key, label } of linters) {
    if (lintResults[key] && !lintResults[key].success) {
      console.error(`\n${label} Issues:`);
      console.error(lintResults[key].output);
      totalIssues++;
      errorCount++;
    }
  }
  return { totalIssues, errorCount };
}

/**
 * Core logic: exported for direct invocation
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {{output:string, exitCode:number}} Pass-through output and exit code
 */
function evaluate(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const command = input.tool_input?.command || '';
    
    // Only run for git commit commands
    if (!command.includes('git commit')) {
      return { output: rawInput, exitCode: 0 };
    }
    
    if (command.includes('--amend')) {
      return { output: rawInput, exitCode: 0 };
    }
    
    const stagedFiles = getStagedFiles();
    
    if (stagedFiles.length === 0) {
      console.error('[Hook] No staged files found. Use "git add" to stage files first.');
      return { output: rawInput, exitCode: 0 };
    }
    
    console.error(`[Hook] Checking ${stagedFiles.length} staged file(s)...`);
    
    const filesToCheck = stagedFiles.filter(shouldCheckFile);

    const lintCounts = reportLintResults(filesToCheck);
    let totalIssues = lintCounts.totalIssues;
    let errorCount = lintCounts.errorCount;
    let warningCount = lintCounts.warningCount;
    let infoCount = lintCounts.infoCount;

    const messageValidation = validateCommitMessage(command);
    const msgCounts = reportCommitMessageIssues(messageValidation);
    totalIssues += msgCounts.totalIssues;
    warningCount += msgCounts.warningCount;
    
    const lintResults = runLinter(filesToCheck);
    const linterErrors = reportLinterErrors(lintResults);
    totalIssues += linterErrors.totalIssues;
    errorCount += linterErrors.errorCount;

    if (totalIssues > 0) {
      console.error(`\nSummary: ${totalIssues} issue(s) found (${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info)`);
      if (errorCount > 0) {
        console.error('\n[Hook] ERROR: Commit blocked due to critical issues. Fix them before committing.');
        return { output: rawInput, exitCode: 2 };
      }
      console.error('\n[Hook] WARNING: Warnings found. Consider fixing them, but commit is allowed.');
      console.error('[Hook] To bypass these checks, use: git commit --no-verify');
    } else {
      console.error('\n[Hook] PASS: All checks passed!');
    }

  } catch (error) {
    console.error(`[Hook] Error: ${error.message}`);
  }

  return { output: rawInput, exitCode: 0 };
}

function run(rawInput) {
  const result = evaluate(rawInput);
  return {
    stdout: result.output,
    exitCode: result.exitCode,
  };
}

// ── stdin entry point ────────────────────────────────────────────
if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) {
      const remaining = MAX_STDIN - data.length;
      data += chunk.substring(0, remaining);
    }
  });
  
  process.stdin.on('end', () => {
    const result = evaluate(data);
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  });
}

module.exports = { run, evaluate };
