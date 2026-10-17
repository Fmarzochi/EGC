import type { ValidationResult } from './validator-session.js';
import { bareToken, positionalsOf, commandName } from './validator-tokens.js';

// Destructive variants of CLIs that are otherwise advisory-only at the
// enforcement hook (see the allowlist-miss comment in validateCommand):
// plain `docker build` / `gh pr list` / `prisma migrate dev` keep today's
// advisory behavior, but the data-destroying forms below hard-block the
// same way inline eval does. Returning null means "nothing destructive
// here" and the command falls through to the ordinary allowlist handling.

// docker management groups whose next positional is the real subcommand
// (`docker system prune`, `docker volume rm`, `docker compose down`).
const DOCKER_MGMT_GROUPS = new Set(['container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'compose']);

// Global docker flags that take a value and can appear BEFORE the subcommand
// (`docker -H tcp://x system prune`, `docker --log-level debug rm c1`) — a
// small, stable, fully-documented set (unlike run's much larger per-
// subcommand flag surface below), so it can be enumerated completely.
// Stripping these, and their values, before computing positionals is what
// keeps a global value-flag from shifting the real subcommand out of the
// position checkDockerDestructive looks at.
const DOCKER_GLOBAL_VALUE_FLAGS = new Set([
  '-h', '--host', '-l', '--log-level', '-c', '--context', '--config',
  '--tlscacert', '--tlscert', '--tlskey',
]);

function stripDockerGlobalFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.indexOf('=');
    if (eq > 0 && DOCKER_GLOBAL_VALUE_FLAGS.has(t.slice(0, eq))) continue;
    if (DOCKER_GLOBAL_VALUE_FLAGS.has(t)) {
      // Only consume the next token as this flag's value if it doesn't
      // itself look like a flag — mirrors how real getopt-style parsers
      // never let one flag silently swallow the next flag as a value.
      if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

// run/create flags that consume the following token as a value; skipping the
// value keeps the option-window scan below from mistaking it for the image.
// Cannot be exhaustive against docker's full run-flag surface — that is why
// runWindowMountsOrPrivileges never treats "unrecognized flag" as proof the
// window has ended (see its own comment); this set only needs to cover the
// common cases so their values are not misread as the image.
const DOCKER_RUN_VALUE_FLAGS = new Set([
  '-e', '--env', '-p', '--publish', '-w', '--workdir', '--name', '-u', '--user',
  '--network', '-l', '--label', '--entrypoint', '--platform', '--pull', '--add-host',
  '-m', '--memory', '--memory-swap', '-h', '--hostname', '--gpus', '--device',
  '--dns', '--dns-search', '--restart', '--tmpfs', '--ip', '--ip6', '--mac-address',
  '--health-cmd', '--health-interval', '--health-retries', '--health-timeout',
  '--health-start-period', '--security-opt', '--log-driver', '--log-opt',
  '--stop-signal', '--stop-timeout', '--shm-size', '--ulimit', '--pid', '--ipc',
  '--uts', '--cgroup-parent', '--blkio-weight', '--cpus', '--cpuset-cpus', '--cpu-shares',
]);

// A docker volume/mount SOURCE is a real host-escape risk only if it looks
// like a path — absolute, relative, home-relative, or a Windows drive
// letter. A bare identifier (docker's named-volume naming rule is
// [a-zA-Z0-9][a-zA-Z0-9_.-]*) is a Docker-managed named volume with no host
// filesystem access, and is the common form for stateful dev containers
// (postgres/redis/mongo data volumes). Anything that fails to parse as a
// clean identifier is treated as a path — fail closed on ambiguity.
function isHostMountSource(source: string): boolean {
  if (source.length === 0) return true;
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source)) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source);
}

function volumeValueIsHostMount(value: string): boolean {
  return isHostMountSource(value.split(':')[0]);
}

// In docker syntax every option of run/create precedes the image name, and
// everything after the image is the command executed INSIDE the container.
// Scanning only that option window is what lets `docker run alpine rm -rf
// /tmp/x` or `docker run img tar -xvf a.tar` pass while a host mount or
// privilege escalation before the image still blocks. The bundled/glued
// short-flag test (-itv, -v/:/host) is why exact `-v` membership is not
// enough. -v/--volume get their value checked (isHostMountSource) so a
// named volume — the common stateful-dev-container pattern — does not
// hard-block; every other spelling of a mount/privilege flag stays an
// unconditional block, same as before.
const DOCKER_UNCONDITIONAL_PRIVILEGE_FLAGS = new Set(['--privileged', '--mount', '--cap-add']);

function isUnconditionalPrivilegeFlag(t: string): boolean {
  return DOCKER_UNCONDITIONAL_PRIVILEGE_FLAGS.has(t) || t.startsWith('--mount=') || t.startsWith('--cap-add=');
}

// A volume flag carrying its value inline (--volume=..., -v/...) is judged on
// that value. Bundled short flags (-itv, -dv...): the value's position inside
// the bundle is ambiguous, so they stay unconditionally dangerous rather than
// risk mis-parsing a host mount as a safe named volume.
function inlineVolumeIsHostMount(t: string): boolean {
  if (t.startsWith('--volume=')) return volumeValueIsHostMount(t.slice('--volume='.length));
  if (t.startsWith('-v') && t.length > 2) return volumeValueIsHostMount(t.slice(2));
  return !t.startsWith('--') && /^-[a-z]*v/.test(t);
}

function runWindowMountsOrPrivileges(tokens: string[], startIdx: number): boolean {
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) return false;
    if (isUnconditionalPrivilegeFlag(t)) return true;
    if (t === '-v' || t === '--volume') {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('-') || volumeValueIsHostMount(value)) return true;
      i++;
      continue;
    }
    if (inlineVolumeIsHostMount(t)) return true;
    if (DOCKER_RUN_VALUE_FLAGS.has(t)) i++;
  }
  return false;
}

function checkDockerDestructive(args: string[]): ValidationResult | null {
  const tokens = stripDockerGlobalFlags(args.map(bareToken));
  const positionals = positionalsOf(tokens);
  // The destructive subcommand is the first positional, or the second when
  // the first is a management group. A later `rm`/`prune` (e.g. the command
  // run inside a container) is not a docker subcommand and must not match.
  const sub = DOCKER_MGMT_GROUPS.has(positionals[0] ?? '') ? positionals[1] : positionals[0];
  if (sub === 'rm' || sub === 'rmi' || sub === 'prune') {
    return { allowed: false, reason: 'destructive docker operation is forbidden', trust_level: 'DANGEROUS' };
  }
  const volumesFlag = tokens.some(t => t === '-v' || t === '--volumes' || t.startsWith('--volumes='));
  if (sub === 'down' && volumesFlag) {
    return { allowed: false, reason: 'destructive docker operation is forbidden', trust_level: 'DANGEROUS' };
  }
  const startIdx = tokens.findIndex(t => t === 'run' || t === 'create');
  if (startIdx >= 0 && runWindowMountsOrPrivileges(tokens, startIdx)) {
    return { allowed: false, reason: 'docker run with host mounts or elevated privileges is forbidden', trust_level: 'DANGEROUS' };
  }
  return null;
}

// gh options that take the next word: without skipping their values, a
// global option in front (`gh -R owner/repo repo delete`) shifts the verb out
// of the position the subcommand check reads.
const GH_VALUE_FLAGS = new Set([
  '-r', '--repo', '--hostname', '-t', '--template', '-q', '--jq', '-h', '--header',
  '-f', '--field', '--raw-field', '-x', '--method', '--input', '--cache', '-p', '--preview', '--json',
]);

function ghPositionals(tokens: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.includes('=') && GH_VALUE_FLAGS.has(token)) i += 1;
  }
  return positionals;
}

function checkGhDestructive(args: string[]): ValidationResult | null {
  const tokens = args.map(bareToken);
  const positionals = ghPositionals(tokens);
  // `gh <resource> delete` always puts the verb in the second positional;
  // a later token spelled delete (an issue title word, a repo actually
  // named delete in `gh repo view delete`) is data, not a subcommand. gh
  // also has compound noun-verb subcommand names for the same action
  // (`item-delete`, `field-delete` on `gh project`), so the suffix is
  // checked too, not just an exact match.
  if (positionals[1] === 'delete' || (positionals[1] ?? '').endsWith('-delete')) {
    return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
  }
  // gh api with an explicit DELETE method, in every spelling getopt
  // accepts: -X DELETE, -XDELETE, -X=DELETE, --method DELETE, --method=delete.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-xdelete' || t === '--method=delete' || t === '-x=delete') {
      return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
    }
    if ((t === '-x' || t === '--method') && tokens[i + 1] === 'delete') {
      return { allowed: false, reason: 'gh delete operations are forbidden', trust_level: 'DANGEROUS' };
    }
  }
  return null;
}

function checkPrismaDestructive(args: string[]): ValidationResult | null {
  const tokens = args.map(bareToken);
  const positionals = positionalsOf(tokens);
  // Subcommand context, not token presence: `prisma migrate dev --name
  // reset` names a migration and must pass; `prisma migrate reset` wipes.
  if (positionals[0] === 'migrate' && positionals[1] === 'reset') {
    return { allowed: false, reason: 'prisma data-loss operation is forbidden', trust_level: 'DANGEROUS' };
  }
  if (tokens.some(t =>
    t === '--force-reset' || t.startsWith('--force-reset=') ||
    t === '--accept-data-loss' || t.startsWith('--accept-data-loss='),
  )) {
    return { allowed: false, reason: 'prisma data-loss operation is forbidden', trust_level: 'DANGEROUS' };
  }
  if (positionals[0] === 'db' && positionals[1] === 'execute') {
    return { allowed: false, reason: 'prisma db execute runs arbitrary SQL and is forbidden', trust_level: 'DANGEROUS' };
  }
  return null;
}

const DESTRUCTIVE_CLI_CHECKS: Record<string, (args: string[]) => ValidationResult | null> = {
  docker: checkDockerDestructive,
  'docker-compose': checkDockerDestructive,
  gh: checkGhDestructive,
  prisma: checkPrismaDestructive,
};

// Package runners re-execute their first non-flag argument, so `npx prisma
// migrate reset` must be judged as prisma, not as npx (which is SAFE_DEV) —
// and `yarn prisma ...` must not slide through as a plain allowlist miss.
const RUNNER_CLIS = new Set(['npx', 'pnpx', 'bunx', 'yarn', 'pnpm', 'bun']);
// 'run' included alongside dlx/x/exec: `yarn run <bin>`/`bun run <bin>`
// re-execute a node_modules/.bin binary the same way dlx/x/exec do.
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'x', 'exec', 'run']);
// Runner flags that consume the following token as a value (the package to
// install/run, a cwd, a registry). Without skipping the value too, the
// unwrap loop below mistakes it for the inner command and judges the wrong
// (misaligned) argument slice, e.g. `npx -p prisma prisma migrate reset`.
const RUNNER_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--cwd', '--registry']);

export function destructiveVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  const check = DESTRUCTIVE_CLI_CHECKS[baseCommand];
  if (check) return check(args);
  if (!RUNNER_CLIS.has(baseCommand)) return null;
  let i = 0;
  while (i < args.length) {
    const t = bareToken(args[i]);
    if (RUNNER_VALUE_FLAGS.has(t)) { i += 2; continue; }
    if (!t.startsWith('-') && !RUNNER_SUBCOMMANDS.has(t)) break;
    i += 1;
  }
  if (i >= args.length) return null;
  // prisma@5.x and ./node_modules/.bin/prisma both resolve to prisma.
  let inner = commandName(args[i]);
  if (!inner.startsWith('@')) inner = inner.split('@')[0];
  const innerCheck = DESTRUCTIVE_CLI_CHECKS[inner];
  return innerCheck ? innerCheck(args.slice(i + 1)) : null;
}
