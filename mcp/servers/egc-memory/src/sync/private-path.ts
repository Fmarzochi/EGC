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

// The account that keeps a file to itself on Windows: DOMAIN\user when the
// session names a domain, the user name alone otherwise.
export function windowsAccount(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME || os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

// The icacls call that leaves one account on a file or a directory: the
// inherited entries removed, one full-control entry for the account, and on
// a directory that entry inherited by what the directory will hold.
export function privateAclArguments(target: string, directory: boolean, account: string = windowsAccount()): [string, string[]] {
  return ['icacls', [target, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)F' : 'F'}`]];
}

// A protection that cannot be applied never blocks the write: the path is
// left as it is and the caller learns it from the answer.
export function makePrivate(target: string, mode: number, options: PrivatePathOptions = {}): boolean {
  const { directory = false, platform = process.platform, run = spawnSync, env = process.env } = options;
  if (platform === 'win32') {
    try {
      const [command, args] = privateAclArguments(target, directory, windowsAccount(env));
      const result = run(command, args, { stdio: 'ignore', windowsHide: true });
      return Boolean(result) && result.status === 0;
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
