// The environment git runs under inside the memory server. The server has no
// terminal: a git that stops to ask a question (an unknown host key, a key
// passphrase, a credential) waits for an answer that never comes, and the
// caller sees only a silent timeout. These settings make git fail at once
// with the reason instead, which the sync then reports. A choice the person
// made, in the environment or in core.sshCommand, is kept: the batch flag is
// added to their ssh command, never put in its place.

// The variables the server sets or forwards. simple-git guards every GIT_*
// variable and a few others (EDITOR, VISUAL, PAGER, PREFIX, SSH_ASKPASS):
// it drops them from the ambient environment and refuses them in an
// environment given to it unless they are allowed. The server allows these
// four (the variant goes with GIT_SSH, so a plink named there keeps its
// own argument style) and gives git none of the other guarded ones, which
// simple-git would have dropped anyway; SSH_ASKPASS_REQUIRE goes with
// SSH_ASKPASS.
export const GIT_ENVIRONMENT_KEYS = ['GIT_TERMINAL_PROMPT', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT'] as const;
const GUARDED_KEYS = new Set(['EDITOR', 'VISUAL', 'PAGER', 'PREFIX', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']);

// The name a variable is forwarded under: one of the four in its canonical
// case (Windows keeps whatever case the variable was set with), any other
// variable as it is, or nothing for a guarded one.
function forwardedName(key: string): string | null {
  const upper = key.toUpperCase();
  if ((GIT_ENVIRONMENT_KEYS as readonly string[]).includes(upper)) return upper;
  if (upper.startsWith('GIT_') || GUARDED_KEYS.has(upper)) return null;
  return key;
}

// The flag that keeps an ssh command from asking: OpenSSH takes
// -oBatchMode=yes, PuTTY's plink and tortoiseplink take -batch and refuse
// the OpenSSH spelling.
function batchFlag(sshCommand: string): string {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(sshCommand);
  const executable = match ? (match[1] ?? match[2] ?? match[3]) : sshCommand;
  return /(?:^|[\\/])(?:tortoise)?plink(?:\.exe)?$/i.test(executable) ? '-batch' : '-oBatchMode=yes';
}

export function gitEnvironment(base: NodeJS.ProcessEnv, configuredSshCommand: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const name = forwardedName(key);
    if (name !== null && value !== undefined && env[name] === undefined) env[name] = value;
  }
  if (!env.GIT_TERMINAL_PROMPT) env.GIT_TERMINAL_PROMPT = '0';
  // git takes GIT_SSH_COMMAND first, then core.sshCommand, then GIT_SSH: a
  // command of the person's own in the environment stands as it is; a
  // configured core.sshCommand is what git would run even over GIT_SSH, so
  // it is the one that gets the batch flag; GIT_SSH alone stands too.
  const configured = configuredSshCommand?.trim() || '';
  if (!env.GIT_SSH_COMMAND && (configured || !env.GIT_SSH)) {
    const ssh = configured || 'ssh';
    env.GIT_SSH_COMMAND = `${ssh} ${batchFlag(ssh)}`;
  }
  return env;
}
