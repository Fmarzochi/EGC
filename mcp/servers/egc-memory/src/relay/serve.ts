import fs from 'node:fs';

import { parseTeamKey } from '../sync/envelope';
import { TEAM_CONFIG_PATH, getTeamConfig } from '../sync/TeamSync';
import { startHub } from './hub';
import { DEFAULT_MESH_PORT, meshAuthKey } from './protocol';

// `egc mesh serve`: the central in the foreground, letting in the machines
// that hold this machine's team key. The key is read from ~/.egc/team.json,
// never from the command line, and only the key derived from it for the
// challenge reaches the central: the central process cannot open a box.
// The machine that runs this command does hold the team key, so it is a
// machine of the person's own; the credential that lets a rented server
// hold the challenge key alone comes with the guide of that option.
export interface ServeArgs { port: number; host: string }

export const SERVE_USAGE = 'Usage: egc mesh serve [--port <0-65535>, default 47470] [--host <address>, default 0.0.0.0]';

function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

// The options, or the message that says what is wrong with them.
export function parseServeArgs(argv: readonly string[]): ServeArgs | string {
  const args: ServeArgs = { port: DEFAULT_MESH_PORT, host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--port') {
      const port = parsePort(value);
      if (port === null) return `--port takes a number from 0 to 65535.\n${SERVE_USAGE}`;
      args.port = port;
    } else if (argv[i] === '--host' && value && !value.startsWith('--')) {
      args.host = value;
    } else {
      return `Unknown option ${argv[i]}.\n${SERVE_USAGE}`;
    }
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseServeArgs(argv);
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n`);
    process.exitCode = 2;
    return;
  }
  const teamKey = parseTeamKey(getTeamConfig()?.teamKey);
  if (!teamKey) {
    // A configuration that exists but holds no usable key is repaired or
    // restored, never re-initialized: `egc team init` without `--key`
    // would write a new key over it.
    process.stderr.write(fs.existsSync(TEAM_CONFIG_PATH)
      ? `The team configuration at ${TEAM_CONFIG_PATH} holds no valid team key: repair or restore that file. Do not run \`egc team init\` without \`--key\` for it, since that writes a new key over the file.\n`
      : 'No team on this machine: run `egc team init` first. The central lets in the machines that hold the key of the team.\n');
    process.exitCode = 1;
    return;
  }
  let hub;
  try {
    hub = await startHub({ authKey: meshAuthKey(teamKey), port: args.port, host: args.host });
  } catch (error) {
    process.stderr.write(`The mesh central did not start on ${args.host}:${args.port}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`EGC mesh central listening on ${hub.host}:${hub.port}\n`);
  const stop = (): void => {
    hub.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`The mesh central stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
