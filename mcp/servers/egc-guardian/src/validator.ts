import path from 'node:path';
import os from 'node:os';

// Trust level tiers
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git'];
export const SAFE_DEV = ['npm', 'npx', 'node', 'tsc'];
// dd/shred/truncate have no legitimate small/safe use in an agent workflow
// (unlike e.g. chmod, which is mostly benign and only dangerous with
// specific destructive flags — a blanket ban there would be a false-positive
// magnet, not a security fix). rm/mv are the two most obviously reachable
// destructive commands; these three round out the same tier now that the
// allowlist-miss path is advisory-only by design (see validateCommand).
export const DANGEROUS = ['rm', 'mv', 'dd', 'shred', 'truncate'];

export const SHELL_META_REGEX = /[&|;<>$`\n\r]/;

// find flags that perform an action (delete, run arbitrary commands) rather
// than just filtering results. These bypass the DANGEROUS ['rm', 'mv'] check
// entirely because the base command is 'find', which is SAFE_READONLY.
export const FIND_ACTION_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fls'];

// Interpreters/shells whose inline-eval flags let an agent execute arbitrary
// code that bypasses every path- and content-based check in this file (the
// interpreter reads/writes/execs whatever the inline string tells it to,
// independent of the guardian's allowlist for base commands). Denied
// regardless of whether the interpreter itself is otherwise allowlisted,
// because 'allowed to run node' must not imply 'allowed to eval anything'.
const INLINE_EVAL_COMMANDS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  pwsh: ['-c', '-command', '-Command'],
  powershell: ['-c', '-command', '-Command'],
  'powershell.exe': ['-c', '-command', '-Command'],
};

// Protected file patterns (checked on full path string).
//
// AI coding tool home directories (~/.claude, ~/.cursor, ~/.gemini, ~/.config/*)
// mix real credential files with functional data the tool's own assistant
// legitimately writes (skills, agents, native memory, user-requested config
// edits). Blocking the whole directory breaks that functional data for no
// security gain, since the actual secret is always one specific file, not
// the directory. Deny the credential file by pattern instead. Sources: each
// tool's official docs, verified 2026-07-11 (see docs/architecture or the
// PR that introduced this comment for the full per-tool research).
export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  /\.env$/,
  // .env.example/.sample/.template are conventionally committed templates
  // with placeholder values, never real secrets — excluded so they're
  // readable/writable like any other file. .env.local/.production/.staging
  // and everything else still match (real per-environment secret files).
  /\.env\.(?!example$|sample$|template$)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.npmrc$/,
  /\.pypirc$/,
  // Claude Code: OAuth session lives in .credentials.json inside ~/.claude,
  // and in ~/.claude.json at the home root (sibling of ~/.claude, not inside
  // it). settings.json, skills, agents, and projects/*/memory/ are functional.
  /\.claude[\\/]\.credentials\.json$/,
  /(^|[\\/])\.claude\.json$/,
  // Gemini CLI + Antigravity (share ~/.gemini). settings.json, GEMINI.md,
  // skills/, extensions/, and antigravity/brain (native memory) are functional.
  /\.gemini[\\/]oauth_creds\.json$/,
  /\.gemini[\\/]google_accounts\.json$/,
  /\.gemini[\\/].*mcp-oauth-tokens\.json$/,
  /\.gemini[\\/]a2a-oauth-tokens\.json$/,
  // Codex CLI: OAuth/API key auth file.
  /\.codex[\\/]auth\.json$/,
  // Amp: OAuth tokens live under this subfolder; config is elsewhere.
  /\.amp[\\/]oauth([\\/]|$)/,
  // Kiro: the CLI's token cache lives outside ~/.kiro, under XDG data dir.
  /\.local[\\/]share[\\/]kiro-cli[\\/]data\.sqlite3$/,
  // Continue.dev: not yet an EGC install target, but its real secret file is
  // .env (already caught by the generic pattern above) plus these two
  // environment dotfiles. config.yaml, prompts/, sessions/, and index/ are
  // functional and must stay writable once Continue.dev is integrated.
  /\.continue[\\/]\.local$/,
  /\.continue[\\/]\.staging$/,
  // Shell startup files and git config: not credential stores, but a
  // write here is a persistence mechanism — code planted here runs on
  // every new shell (rc files) or every git invocation that hits an
  // aliased subcommand (gitconfig aliases can run arbitrary shell via
  // `alias.x = "!sh -c ..."`), long after the current session ends.
  /(^|[\\/])\.bashrc$/,
  /(^|[\\/])\.zshrc$/,
  /(^|[\\/])\.bash_profile$/,
  /(^|[\\/])\.zprofile$/,
  /(^|[\\/])\.profile$/,
  /(^|[\\/])\.gitconfig$/,
];

export function buildDeniedPaths(): string[] {
  const home = os.homedir();
  const isWindows = process.platform === 'win32';

  const paths = [
    // Pure credential stores: no legitimate reason for an AI tool to write here.
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.egc'),
    // A binary planted here (named e.g. 'git' or 'node') sits ahead of
    // /usr/bin on most PATH configurations, silently hijacking every
    // "safe, allowlisted" command this same guardian trusts by name.
    path.join(home, '.local', 'bin'),
    // User-level systemd units auto-run on login without any further
    // action from the agent that planted one — a persistence mechanism
    // equivalent in effect to a shell rc file.
    path.join(home, '.config', 'systemd', 'user'),
    // ~/.config is XDG_CONFIG_HOME, shared by many unrelated apps and by
    // OpenCode/Zed's functional (non-secret) config, which EGC itself
    // installs into. Deny only the specific subdirectories confirmed to
    // hold credentials for tools that don't expose them elsewhere.
    path.join(home, '.config', 'github-copilot'),
    path.join(home, '.config', 'Trae'),
    '/etc',
  ];

  if (isWindows) {
    const appData = process.env.APPDATA || '';
    const userProfile = process.env.USERPROFILE || home;
    paths.push(
      path.join(userProfile, '.ssh'),
      path.join(userProfile, '.aws'),
      appData,
    );
  }

  return paths.filter(Boolean);
}

export const DENIED_PATHS: string[] = buildDeniedPaths();

// baseDir defaults to process.cwd() (path.resolve's own implicit behavior
// when given one argument) so existing callers are unaffected. Callers that
// know the real invocation directory of the command being checked (e.g. the
// PreToolUse hook, which receives it from the harness on every call) should
// pass it explicitly -- otherwise a relative path is judged against this
// process's own cwd, which is not guaranteed to match the shell the command
// actually runs in.
export function isProtectedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Expand ~ at the start
  const expanded = p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;

  const normalizedP = path.resolve(baseDir, expanded);

  for (const denied of DENIED_PATHS) {
    if (normalizedP === denied || normalizedP.startsWith(denied + path.sep)) {
      return true;
    }
  }

  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(normalizedP)) {
      return true;
    }
  }

  return false;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  trust_level?: 'SAFE_READONLY' | 'SAFE_DEV' | 'DANGEROUS' | 'BLOCKED';
}

/**
 * Validate arguments for a specific allowed command.
 * Returns { allowed: false, reason } if the args are unsafe.
 */
export function validateCommandArgs(
  baseCommand: string,
  args: string[],
  cwd?: string,
): ValidationResult {
  const allArgs = args.join(' ');

  switch (baseCommand) {
    case 'git': {
      // Block force pushes, including --force-with-lease/--force-if-includes
      // (startsWith, not includes, so these are caught even though their
      // second character is '-' and they carry a value after '=').
      const hasForceFlag = args.some(
        a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes'),
      );
      if (hasForceFlag) {
        return { allowed: false, reason: 'git force-push is forbidden', trust_level: 'SAFE_READONLY' };
      }
      // Additional check for combined short flags like -fu used destructively
      if (args.includes('push') && args.some(a => /^-[a-zA-Z]*f/.test(a))) {
        return { allowed: false, reason: 'git push with force flag is forbidden', trust_level: 'SAFE_READONLY' };
      }
      return { allowed: true, trust_level: 'SAFE_READONLY' };
    }

    case 'grep': {
      const home = os.homedir();

      // Detect if any recursive flag is present
      const isRecursive = args.some(
        a => a === '-r' || a === '-R' || a === '--recursive' ||
             // combined short flags: -rn, -Rn, -rl, etc.
             /^-[a-zA-Z]*[rR]/.test(a),
      );

      // Non-flag, non-empty args are candidates for pattern or path.
      // In grep: grep [options] PATTERN [FILE…]
      // The first non-flag arg is the pattern; the rest are paths.
      const positionalArgs = args.filter(a => a.length > 0 && !a.startsWith('-'));

      // Paths are all positional args after the first one (the pattern).
      const pathArgs = positionalArgs.slice(1);

      if (isRecursive) {
        for (const p of pathArgs) {
          if (p === '/' || p === home || isProtectedPath(p, cwd)) {
            return {
              allowed: false,
              reason: `grep recursive over protected path '${p}' is forbidden`,
              trust_level: 'SAFE_READONLY',
            };
          }
        }
        // If no explicit path args, grep defaults to '.', which is fine.
        // But if the only non-flag positional IS '/' (i.e., pattern was empty), still block.
        if (positionalArgs.length === 1 && (positionalArgs[0] === '/' || isProtectedPath(positionalArgs[0], cwd))) {
          return {
            allowed: false,
            reason: `grep over protected path '${positionalArgs[0]}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }

      // Even without -r, block explicit protected paths
      for (const p of pathArgs) {
        if (isProtectedPath(p, cwd)) {
          return {
            allowed: false,
            reason: `grep over protected path '${p}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }

      return { allowed: true, trust_level: 'SAFE_READONLY' };
    }

    case 'cat': {
      for (const arg of args) {
        if (!arg.startsWith('-') && isProtectedPath(arg, cwd)) {
          return {
            allowed: false,
            reason: `cat of protected path '${arg}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }
      return { allowed: true, trust_level: 'SAFE_READONLY' };
    }

    case 'find': {
      // -delete/-exec/etc. make find perform an action instead of just
      // filtering, which reproduces 'rm -rf' through a base command that
      // isn't in the DANGEROUS list. Deny regardless of path.
      const actionFlag = args.find(a => FIND_ACTION_FLAGS.includes(a));
      if (actionFlag) {
        return {
          allowed: false,
          reason: `find with action flag '${actionFlag}' is forbidden (use a read-only find, then a separate reviewed command)`,
          trust_level: 'DANGEROUS',
        };
      }

      // First non-flag arg is typically the search root
      const pathArgs = args.filter(a => !a.startsWith('-'));
      for (const p of pathArgs) {
        if (isProtectedPath(p, cwd)) {
          return {
            allowed: false,
            reason: `find over protected path '${p}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }
      return { allowed: true, trust_level: 'SAFE_READONLY' };
    }

    case 'head':
    case 'stat':
    case 'ls': {
      // These are read-only but we still block protected paths
      for (const arg of args) {
        if (!arg.startsWith('-') && isProtectedPath(arg, cwd)) {
          return {
            allowed: false,
            reason: `${baseCommand} on protected path '${arg}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }
      return { allowed: true, trust_level: 'SAFE_READONLY' };
    }

    case 'npm':
    case 'npx':
    case 'node':
    case 'tsc': {
      // node -e/-p can read, write, or exfiltrate anything the process can
      // touch, including files DENIED_PATHS protects (e.g. the state
      // encryption key) — inline eval is caught by the interpreter check in
      // validateCommand, but a defense-in-depth check here means this branch
      // is still safe even if it's ever reached directly.
      const evalFlags = INLINE_EVAL_COMMANDS[baseCommand];
      if (evalFlags && args.some(a => evalFlags.includes(a))) {
        return {
          allowed: false,
          reason: `inline code execution via '${baseCommand}' eval flag is forbidden`,
          trust_level: 'DANGEROUS',
        };
      }

      // Any argument that resolves to a protected path (a script path, a
      // require target, etc.) is denied the same way 'cat'/'find' deny it —
      // being in SAFE_DEV means "safe to run", not "exempt from path checks".
      for (const arg of args) {
        if (!arg.startsWith('-') && isProtectedPath(arg, cwd)) {
          return {
            allowed: false,
            reason: `${baseCommand} on protected path '${arg}' is forbidden`,
            trust_level: 'SAFE_DEV',
          };
        }
      }

      return { allowed: true, trust_level: 'SAFE_DEV' };
    }

    default:
      return { allowed: true, trust_level: 'SAFE_READONLY' };
  }
}

export function validateCommand(command: string, cwd?: string): ValidationResult {
  // 1. Shell metacharacters check
  if (SHELL_META_REGEX.test(command)) {
    return {
      allowed: false,
      reason: 'Shell chaining/metacharacters are forbidden',
      trust_level: 'BLOCKED',
    };
  }

  const parts = command.trim().split(/\s+/);
  const baseCommand = parts[0];
  const args = parts.slice(1);

  // 2. Dangerous commands: denied regardless of args
  if (DANGEROUS.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `'${baseCommand}' is a destructive command and is always denied`,
      trust_level: 'DANGEROUS',
    };
  }

  // 3. Inline code execution (python3 -c, bash -c, node -e, etc.) is a hard
  // deny, not an allowlist check. This runs before the allowlist-membership
  // check on purpose: the base command being outside SAFE_READONLY/SAFE_DEV
  // (e.g. 'python3', 'bash') is only advisory at the enforcement hook layer,
  // by design, so that legitimate commands outside this tiny allowlist
  // (docker, pytest, cargo, go...) don't get hard-blocked wholesale. Inline
  // eval is different: it lets ANY base command execute arbitrary code that
  // bypasses every other check in this file, so it must hard-block
  // regardless of allowlist status. Using DANGEROUS here (not BLOCKED) keeps
  // the reason string out of the hook's advisory-reason list.
  const evalFlagsForBase = INLINE_EVAL_COMMANDS[baseCommand];
  if (evalFlagsForBase && args.some(a => evalFlagsForBase.includes(a))) {
    return {
      allowed: false,
      reason: `inline code execution via '${baseCommand}' eval flag is forbidden — write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
  }

  // 4. Not in any allowlist: blocked
  if (!SAFE_READONLY.includes(baseCommand) && !SAFE_DEV.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command '${baseCommand}' is not in the allowlist`,
      trust_level: 'BLOCKED',
    };
  }

  // 5. In allowlist: validate args
  return validateCommandArgs(baseCommand, args, cwd);
}

export function validateWrite(filepath: string): ValidationResult {
  if (isProtectedPath(filepath)) {
    return {
      allowed: false,
      reason: `Path '${filepath}' is protected`,
      trust_level: 'BLOCKED',
    };
  }
  return { allowed: true };
}
