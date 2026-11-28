import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// A file or a directory private to the user on every platform: the POSIX
// mode where modes exist, an ACL on Windows, where chmod changes nothing.
// The team configuration carries the team key, so the server protects it
// the way scripts/lib/team-config.js does for the CLI and the hooks; the two
// stay in step by hand.

type Runner = typeof spawnSync;

export interface PrivatePathOptions {
  directory?: boolean;
  platform?: NodeJS.Platform;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

// How long one icacls call may take before it is given up: a stalled call
// must never hold the write of the configuration.
export const ACL_TIMEOUT_MS = 5000;

// What the person reads when Windows did not take the access list: the file
// is written all the same, and they know to look at its permissions.
export const ACL_WARNING = 'team.json: Windows did not take the access list that keeps it to your account; check its permissions by hand.';

// The account that keeps a file to itself on Windows: DOMAIN\user when the
// session names a domain, the user name alone otherwise.
export function windowsAccount(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME || os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

// The icacls calls that leave one account on a file or a directory: the
// inherited entries removed and one full-control entry for the account. A
// directory may exist from before with entries someone added, so its list is
// reset to what the parent hands down first and the entry is inherited by
// what the directory will hold; a file comes through here only when this
// write just created it, so there is nothing on it to reset.
export function privateAclCommands(target: string, directory: boolean, account: string = windowsAccount()): Array<[string, string[]]> {
  const grant: [string, string[]] = ['icacls', [target, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)F' : 'F'}`]];
  return directory ? [['icacls', [target, '/reset']], grant] : [grant];
}

// A protection that cannot be applied never blocks the write: the path is
// left as it is and the caller learns it from the answer.
export function makePrivate(target: string, mode: number, options: PrivatePathOptions = {}): boolean {
  const { directory = false, platform = process.platform, run = spawnSync, env = process.env } = options;
  if (platform === 'win32') {
    try {
      return privateAclCommands(target, directory, windowsAccount(env)).every(([command, args]) => {
        const result = run(command, args, { stdio: 'ignore', windowsHide: true, timeout: ACL_TIMEOUT_MS });
        return Boolean(result) && result.status === 0;
      });
    } catch {
      return false;
    }
  }
  try {
    fs.chmodSync(target, mode);
    return true;
  } catch {
    return false;
  }
}
