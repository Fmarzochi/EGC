# Team-Brain

The Team Brain keeps your EGC project state in step across your own machines. You choose a private git remote that you control, and `egc team` moves the state between machines, sealed with a key only your machines hold. No EGC server is involved.

The full guide, with real command output and troubleshooting, is [docs/TEAM-BRAIN.md](https://github.com/Fmarzochi/EGC/blob/main/docs/TEAM-BRAIN.md). This page is the short version.

## Commands

| Command | What it does |
|---|---|
| `egc team init --backend git --remote <url> [--branch <name>]` | Configures this machine and makes a new team key, printed once. |
| `egc team init --backend git --remote <url> [--branch <name>] --key <64 hex>` | Joins this machine to an existing team. |
| `egc team sync` | Pulls the sealed state, merges it, and pushes this machine's state. |
| `egc team status` | Shows the last commit time, uncommitted changes and the remote. |

The `--key` value is visible in the process list while the command runs and is saved in your shell history. The CLI has no other way to take the key, so remove that line from the history afterwards and do not run it on a shared machine.

The same operations exist as the MCP tools `team_init`, `team_sync` and `team_status`.

## What travels and what stays

- Travels, sealed with the team key: the project state documents under `~/.egc/state/`.
- Stays on the machine, in current versions: the SQLite memory store, the machine's own encryption and integrity keys, the integrity sidecars next to the state documents, the logs.
- A remote used with EGC 1.1.23 or earlier may still hold the memory store (from the mirror those versions committed) and the integrity sidecars they pushed in its history. Rewrite that history or move the team to a new repository.
- The team key lives in `~/.egc/team.json` on each machine. Share it between your machines by a trusted channel. If every copy is lost, start a new team.

## Two machines in four steps

1. On the first machine: `egc team init --backend git --remote <url>`. Note the team key.
2. On the first machine: `egc team sync`.
3. On the second machine: `egc team init --backend git --remote <url> --key <team key>`.
4. On the second machine: `egc team sync`. The state of the first machine arrives.

## Limits to know

- A project is matched across machines by the last two segments of its folder path, not by its repository ([#2063](https://github.com/Fmarzochi/EGC/issues/2063)).
- When both machines changed the same document, the one with the later `updated:` time replaces the other as a whole ([#2055](https://github.com/Fmarzochi/EGC/issues/2055)).
- A key that opens none of the state files already on the remote pushes nothing: the sync exits 1 and the shared state stays as it was (a first sync into an empty remote pushes as before). Fix the key with `egc team init ... --key <team key>` and sync again.
- A remote that cannot be read stops `egc team init` and `egc team sync` with the reason git gave and exit 1. Check it with `git ls-remote <url>`.
