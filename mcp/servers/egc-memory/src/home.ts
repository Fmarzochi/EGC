/**
 * The single home-directory resolution this package uses everywhere it
 * needs "the user's home" (encryption.ts, integrity.ts, index.ts,
 * global-state.ts). Before this module existed, three different formulas
 * lived side by side: a bare os.homedir() (encryption.ts, integrity.ts,
 * index.ts), process.env.HOME || os.homedir() (the JS mirror,
 * scripts/lib/state-crypto.js), and process.env.HOME ||
 * process.env.USERPROFILE || os.homedir() (scripts/lib/utils.js,
 * state-store-path.ts). On Windows, os.homedir() reads USERPROFILE and
 * never looks at HOME, so a process (or a test) that sets only HOME was
 * seen by the third formula but invisible to the bare os.homedir() one --
 * exactly the Windows-only CI failure already fixed once in
 * state-crypto.js (PR #1168) by adding the HOME check, but never
 * propagated to encryption.ts and integrity.ts. Left unfixed there, the
 * same split let a state file get encrypted under one resolved home and
 * fail to decrypt under another.
 *
 * resolveHome() is the formula already proven correct in utils.js and
 * state-store-path.ts: process.env values checked explicitly before
 * falling back to the platform default, so every call in this package
 * (and the JS mirror in scripts/lib) agrees on the same home no matter
 * which single environment variable a caller or a test set.
 */
import os from 'node:os';
import path from 'node:path';

export function resolveHome(): string {
  // Each candidate is validated independently (trimmed non-blank) and
  // resolved to an absolute path before being accepted, matching
  // getHomeDir()'s contract in scripts/lib/utils.js: a whitespace-only
  // override must not win over a usable one, and a relative override must
  // not stay relative (cubic review, confidence 9).
  for (const candidate of [process.env.HOME, process.env.USERPROFILE]) {
    if (candidate && candidate.trim().length > 0) {
      return path.resolve(candidate);
    }
  }
  return os.homedir();
}
