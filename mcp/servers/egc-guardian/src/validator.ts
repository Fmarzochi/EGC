import path from 'path';
import os from 'os';

// Trust level tiers
export const SAFE_READONLY = ['ls', 'cat', 'grep', 'find', 'stat', 'head', 'git', 'dir', 'where', 'where.exe'];
export const SAFE_DEV = ['npm', 'npx', 'node', 'tsc', 'egc', 'gh', 'docker', 'prisma', 'php', 'pnpm', 'turbo'];
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
    path.join(home, '.egc'), // MCP internal data dir — protected from user/LLM access
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

const READONLY_OK: ValidationResult = { allowed: true, trust_level: 'SAFE_READONLY' };
const DEV_OK: ValidationResult = { allowed: true, trust_level: 'SAFE_DEV' };

type ArgValidator = (args: string[], baseCommand: string) => ValidationResult;

// First non-flag argument that resolves to a protected path, if any.
function firstProtectedPositional(args: string[]): string | undefined {
  return args.find(a => !a.startsWith('-') && isProtectedPath(a));
}

// True if `token` appears as a standalone arg or in a `--flag=token` form,
// case-insensitively, so `-X DELETE`, `--method DELETE` and `--method=delete`
// all match. Used to catch destructive verbs passed as option values.
function hasArgToken(args: string[], token: string): boolean {
  const t = token.toLowerCase();
  return args.some(a => {
    const lower = a.toLowerCase();
    return lower === t || lower.endsWith('=' + t);
  });
}

function validateGit(args: string[]): ValidationResult {
  if (
    args.includes('--force') ||
    args.includes('-f') ||
    (args.includes('push') && (args.includes('--force') || args.includes('-f')))
  ) {
    return { allowed: false, reason: 'git force-push is forbidden', trust_level: 'SAFE_READONLY' };
  }
  // Combined short flags like -fu, and --force-with-lease, used with push.
  if (args.includes('push') && args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force-with-lease')) {
    return { allowed: false, reason: 'git push with force flag is forbidden', trust_level: 'SAFE_READONLY' };
  }
  return READONLY_OK;
}

function validateGrep(args: string[]): ValidationResult {
  const home = os.homedir();
  const isRecursive = args.some(
    a => a === '-r' || a === '-R' || a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a),
  );
  // grep [options] PATTERN [FILE...]: first positional is the pattern.
  const positionalArgs = args.filter(a => a.length > 0 && !a.startsWith('-'));
  const pathArgs = positionalArgs.slice(1);

  if (isRecursive) {
    for (const p of pathArgs) {
      if (p === '/' || p === home || isProtectedPath(p)) {
        return { allowed: false, reason: `grep recursive over protected path '${p}' is forbidden`, trust_level: 'SAFE_READONLY' };
      }
    }
    if (positionalArgs.length === 1 && (positionalArgs[0] === '/' || isProtectedPath(positionalArgs[0]))) {
      return { allowed: false, reason: `grep over protected path '${positionalArgs[0]}' is forbidden`, trust_level: 'SAFE_READONLY' };
    }
  }
  for (const p of pathArgs) {
    if (isProtectedPath(p)) {
      return { allowed: false, reason: `grep over protected path '${p}' is forbidden`, trust_level: 'SAFE_READONLY' };
    }
  }
  return READONLY_OK;
}

// cat, find, ls, head, stat, and the Windows equivalents dir/where: read-only,
// but never over a protected path (the previous switch left dir/where without
// this check, so `dir ~/.ssh` slipped through the default branch).
function validateReadonlyPaths(args: string[], baseCommand: string): ValidationResult {
  const hit = firstProtectedPositional(args);
  if (hit) {
    return { allowed: false, reason: `${baseCommand} on protected path '${hit}' is forbidden`, trust_level: 'SAFE_READONLY' };
  }
  return READONLY_OK;
}

function validateDocker(args: string[]): ValidationResult {
  const positional = args.filter(a => !a.startsWith('-'));
  const destructiveSub = positional.some(a => a === 'prune' || a === 'rm' || a === 'rmi');
  const downWithVolumes = positional.includes('down') && (args.includes('-v') || args.includes('--volumes'));
  if (destructiveSub || downWithVolumes) {
    return { allowed: false, reason: 'destructive docker operation is forbidden', trust_level: 'DANGEROUS' };
  }
  // run/create with a host mount or elevated privileges can escape the sandbox.
  const startsContainer = positional.includes('run') || positional.includes('create');
  const mountsOrPrivileged = args.some(a =>
    a === '-v' || a === '--volume' || a === '--mount' || a === '--privileged' || a === '--cap-add' ||
    a.startsWith('--volume=') || a.startsWith('--mount=') || a.startsWith('--cap-add='),
  );
  if (startsContainer && mountsOrPrivileged) {
    return { allowed: false, reason: 'docker run with host mounts or elevated privileges is forbidden', trust_level: 'DANGEROUS' };
  }
  return DEV_OK;
}

function validateGh(args: string[]): ValidationResult {
  // Covers `gh <resource> delete`, `gh api -X DELETE`, `gh api --method DELETE`.
  if (hasArgToken(args, 'delete')) {
    return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
  }
  return DEV_OK;
}

function validatePrisma(args: string[]): ValidationResult {
  if (hasArgToken(args, 'reset') || hasArgToken(args, '--force-reset') || hasArgToken(args, '--accept-data-loss')) {
    return { allowed: false, reason: 'prisma data-loss operation is forbidden', trust_level: 'DANGEROUS' };
  }
  const lower = args.map(a => a.toLowerCase());
  if (lower.includes('db') && lower.includes('execute')) {
    return { allowed: false, reason: 'prisma db execute runs arbitrary SQL and is forbidden', trust_level: 'DANGEROUS' };
  }
  return DEV_OK;
}

const devOk: ArgValidator = () => DEV_OK;

// Each allowlisted command maps to its argument validator. Commands present in
// SAFE_READONLY/SAFE_DEV with no entry fall through to a read-only pass. Node,
// npm, php, pnpm and turbo are trusted dev tools by design, like `node -e`.
const ARG_VALIDATORS: Record<string, ArgValidator> = {
  git: validateGit,
  grep: validateGrep,
  cat: validateReadonlyPaths,
  find: validateReadonlyPaths,
  ls: validateReadonlyPaths,
  head: validateReadonlyPaths,
  stat: validateReadonlyPaths,
  dir: validateReadonlyPaths,
  where: validateReadonlyPaths,
  'where.exe': validateReadonlyPaths,
  docker: validateDocker,
  gh: validateGh,
  prisma: validatePrisma,
  npm: devOk,
  npx: devOk,
  node: devOk,
  tsc: devOk,
  egc: devOk,
  php: devOk,
  pnpm: devOk,
  turbo: devOk,
};

/**
 * Validate arguments for a specific allowed command.
 * Returns { allowed: false, reason } if the args are unsafe.
 */
export function validateCommandArgs(baseCommand: string, args: string[]): ValidationResult {
  const validator = ARG_VALIDATORS[baseCommand];
  if (!validator) {
    return READONLY_OK;
  }
  return validator(args, baseCommand);
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
