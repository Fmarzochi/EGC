import path from 'path';
import os from 'os';

// Trust level tiers
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git'];
export const SAFE_DEV = ['npm', 'npx', 'node', 'tsc'];
export const DANGEROUS = ['rm', 'mv'];

export const SHELL_META_REGEX = /[&|;<>$`\n\r]/;

// Protected file patterns (checked on full path string)
export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  /\.env$/,
  /\.env\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.npmrc$/,
  /\.pypirc$/,
];

export function buildDeniedPaths(): string[] {
  const home = os.homedir();
  const isWindows = process.platform === 'win32';

  const paths = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config'),
    path.join(home, '.cursor'),
    path.join(home, '.claude'),
    path.join(home, '.gemini'),
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

export function isProtectedPath(p: string): boolean {
  // Expand ~ at the start
  const expanded = p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;

  const normalizedP = path.resolve(expanded);

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
): ValidationResult {
  const allArgs = args.join(' ');

  switch (baseCommand) {
    case 'git': {
      // Block force pushes
      if (
        args.includes('--force') ||
        args.includes('-f') ||
        (args.includes('push') && (args.includes('--force') || args.includes('-f')))
      ) {
        return { allowed: false, reason: 'git force-push is forbidden', trust_level: 'SAFE_READONLY' };
      }
      // Additional check for combined flags like -fu, --force-with-lease used destructively
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
          if (p === '/' || p === home || isProtectedPath(p)) {
            return {
              allowed: false,
              reason: `grep recursive over protected path '${p}' is forbidden`,
              trust_level: 'SAFE_READONLY',
            };
          }
        }
        // If no explicit path args, grep defaults to '.', which is fine.
        // But if the only non-flag positional IS '/' (i.e., pattern was empty), still block.
        if (positionalArgs.length === 1 && (positionalArgs[0] === '/' || isProtectedPath(positionalArgs[0]))) {
          return {
            allowed: false,
            reason: `grep over protected path '${positionalArgs[0]}' is forbidden`,
            trust_level: 'SAFE_READONLY',
          };
        }
      }

      // Even without -r, block explicit protected paths
      for (const p of pathArgs) {
        if (isProtectedPath(p)) {
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
        if (!arg.startsWith('-') && isProtectedPath(arg)) {
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
      // First non-flag arg is typically the search root
      const pathArgs = args.filter(a => !a.startsWith('-'));
      for (const p of pathArgs) {
        if (isProtectedPath(p)) {
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
        if (!arg.startsWith('-') && isProtectedPath(arg)) {
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
      return { allowed: true, trust_level: 'SAFE_DEV' };
    }

    default:
      return { allowed: true, trust_level: 'SAFE_READONLY' };
  }
}

export function validateCommand(command: string): ValidationResult {
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

  // 3. Not in any allowlist: blocked
  if (!SAFE_READONLY.includes(baseCommand) && !SAFE_DEV.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command '${baseCommand}' is not in the allowlist`,
      trust_level: 'BLOCKED',
    };
  }

  // 4. In allowlist: validate args
  return validateCommandArgs(baseCommand, args);
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
