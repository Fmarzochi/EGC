import path from 'node:path';

// A flag like --file=/path carries a real filesystem target even though the
// argument starts with '-'; loops that skip dashed args entirely would let
// protected paths through inside the value.
export function embeddedPathCandidate(arg: string): string | null {
  if (!arg.startsWith('-')) return null;
  const eq = arg.indexOf('=');
  if (eq > 0 && eq < arg.length - 1) return arg.slice(eq + 1);
  return null;
}

// Bare comparison token for the destructive-CLI checks: shell quotes and
// backslash escapes stripped, lowercased, so `"prune"`, \reset and DELETE
// all compare equal to their plain spellings (the shell strips those before
// the real CLI sees them, so the validator must too). Quotes are stripped
// wherever they appear in the token, not just at the edges — a real shell
// removes a quote character from a word regardless of position (pru"ne"
// is shell-equivalent to prune), so an anchored-only strip leaves embedded
// quotes able to defeat every exact-match keyword check below. Path checks
// elsewhere keep the raw argument.
export function bareToken(a: string): string {
  return a.replaceAll('\\', '').replaceAll(/["']/g, '').toLowerCase();
}

// Same quote/backslash stripping as bareToken(), but case-preserving. Used
// wherever a flag's exact letter case is part of its identity (e.g. a
// wrapper's -e vs -E are two different flags with different arities) -
// lowercasing before the membership check would make an unrecognized
// uppercase flag collide with an unrelated lowercase entry in valueFlags,
// silently consuming (or failing to consume) the wrong number of tokens and
// misidentifying the real wrapped command.
export function stripQuotes(a: string): string {
  return a.replaceAll('\\', '').replaceAll(/["']/g, '');
}

// The name a command word runs by: its file name, without quotes, in lower
// case and without a Windows executable extension, so rm.exe, RM and
// /usr/bin/rm are all rm (Windows and a default macOS disk find a program
// whatever the case, and Windows runs it with or without its extension).
export function commandName(word: string): string {
  return path.basename(bareToken(word)).replace(/\.(?:exe|cmd|bat|com)$/, '');
}

export function stripEnclosingQuotes(s: string): string {
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function positionalsOf(tokens: string[]): string[] {
  return tokens.filter(t => t.length > 0 && !t.startsWith('-'));
}
