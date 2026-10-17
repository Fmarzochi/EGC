// The verdict of one validation, and the state one synchronous validation
// sets for the checks that run inside it.

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  trust_level?: 'SAFE_READONLY' | 'SAFE_DEV' | 'DANGEROUS' | 'BLOCKED';
  // True only for the two verdicts the enforcement hook may treat as advice
  // (allowlist miss, shell metacharacters). The hook reads this field, so
  // whatever text a command puts into a reason cannot soften a hard block.
  advisory?: boolean;
}

// A command read out of a script committed in git and unchanged since is
// project code, not something the agent may have just written: it is held
// to the grave denials (writing or deleting a protected or top-level path,
// git and container overrides), while a rule that exists only to stop a
// command from hiding (eval, -c, reading a protected file) records its
// reason and lets the remaining checks run, so the verdict flags the command
// instead of blocking it. Both are set only for one synchronous validation.
interface ValidationSession {
  committedScript: boolean;
  committedFlag: ValidationResult | null;
  // What the committed script itself sets its variables to, for the ones the
  // command and the environment cannot set first (see isNarrowTarget).
  committedBound: ReadonlyMap<string, readonly string[]>;
  // The variables the command line sets, by name, with every literal value the
  // line gives each one: a target spelled with one of them is judged by the
  // files those values name as well as by its own spelling.
  lineBound: ReadonlyMap<string, readonly string[]>;
  // Set when a resolution had to leave values unread: the verdict then refuses
  // the command, since a target spelled with them could go unjudged.
  lineOverflow: boolean;
}

// One object, so every module reads and writes the same state: the entry
// points set it and restore it around one synchronous validation.
export const session: ValidationSession = {
  committedScript: false,
  committedFlag: null,
  committedBound: new Map(),
  lineBound: new Map(),
  lineOverflow: false,
};

export function flagsInCommittedScript(denial: ValidationResult): boolean {
  if (!session.committedScript) return false;
  session.committedFlag ??= denial;
  return true;
}

// A read of a protected file: the denial for a typed command, null in a
// committed script, where it is flagged instead.
export function readDenial(reason: string, trustLevel: ValidationResult['trust_level'] = 'SAFE_READONLY'): ValidationResult | null {
  const denial: ValidationResult = { allowed: false, reason, trust_level: trustLevel };
  return flagsInCommittedScript(denial) ? null : denial;
}
