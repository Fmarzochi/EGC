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

The same operations exist as the MCP tools `team_init`, `team_sync` and `team_status`.

## What travels and what stays

- Travels, sealed with the team key: the project state documents under `~/.egc/state/`.
- Stays on the machine: the SQLite memory store, the machine's own encryption key, the logs.
- The team key lives in `~/.egc/team.json` on each machine. Share it between your machines by a trusted channel. If every copy is lost, start a new team.

## Two machines in four steps

1. On the first machine: `egc team init --backend git --remote <url>`. Note the team key.
2. On the first machine: `egc team sync`.
3. On the second machine: `egc team init --backend git --remote <url> --key <team key>`.
4. On the second machine: `egc team sync`. The state of the first machine arrives.

## Limits to know

- A project is matched across machines by the last two segments of its folder path, not by its repository ([#2063](https://github.com/Fmarzochi/EGC/issues/2063)).
- When both machines changed the same document, the one with the later `updated:` time replaces the other as a whole ([#2055](https://github.com/Fmarzochi/EGC/issues/2055)).
- A wrong team key makes the sync reject the remote files and then commit their removal. Fix the key, then sync from a machine that holds the right one.
- `Pulled: 0 files` and `Pushed: 0 commits` on a first sync can mean the remote was not reachable. Check it with `git ls-remote <url>`.
