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
// three and gives git none of the other guarded ones, which simple-git
// would have dropped anyway.
export const GIT_ENVIRONMENT_KEYS = ['GIT_TERMINAL_PROMPT', 'GIT_SSH_COMMAND', 'GIT_SSH'] as const;
const GUARDED_KEYS = new Set(['EDITOR', 'VISUAL', 'PAGER', 'PREFIX', 'SSH_ASKPASS']);

function isForwarded(key: string): boolean {
  const upper = key.toUpperCase();
  if ((GIT_ENVIRONMENT_KEYS as readonly string[]).includes(upper)) return true;
  return !upper.startsWith('GIT_') && !GUARDED_KEYS.has(upper);
}

export function gitEnvironment(base: NodeJS.ProcessEnv, configuredSshCommand: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && isForwarded(key)) env[key] = value;
  }
  if (!env.GIT_TERMINAL_PROMPT) env.GIT_TERMINAL_PROMPT = '0';
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const ssh = configuredSshCommand?.trim() || 'ssh';
    env.GIT_SSH_COMMAND = `${ssh} -oBatchMode=yes`;
  }
  return env;
}
