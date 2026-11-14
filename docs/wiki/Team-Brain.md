# Team-Brain

The Team Brain keeps your EGC project state in step across your own machines. You choose a private git remote that you control, and `egc team` moves the state between machines, sealed with a key only your machines hold. No EGC server is involved.

The full guide, with real command output and troubleshooting, is [docs/TEAM-BRAIN.md](https://github.com/Fmarzochi/EGC/blob/main/docs/TEAM-BRAIN.md). This page is the short version.

## Commands

| Command | What it does |
|---|---|
| `egc team init --backend git --remote <url> [--branch <name>] [--autosync]` | Configures this machine and makes a new team key, printed once. |
| `egc team init --backend git --remote <url> [--branch <name>] --key <64 hex> [--autosync]` | Joins this machine to an existing team. |
| `egc team sync` | Pulls the sealed state, merges it, and pushes this machine's state. |
| `egc team autosync on` / `egc team autosync off` | Turns the sync around the session on or off: before the state is read when a session starts, and after a response that changed it. Off by default; the switch is `autosync: true` in `~/.egc/team.json`. |
| `egc team status` | Shows the last commit time, uncommitted changes, the remote, the autosync switch and its last run. |

The `--key` value is visible in the process list while the command runs and is saved in your shell history. The CLI has no other way to take the key, so remove that line from the history afterwards and do not run it on a shared machine.

The same operations exist as the MCP tools `team_init`, `team_sync` and `team_status`. With autosync on, each sync the hooks attempt leaves one line in `~/.egc/logs/team-autosync.log`; a response that changed no state document attempts none. Nothing about it reaches the chat. `egc doctor` prints a `Team` block after the MCP servers: the remote (without any credential it carries) and the branch, the key, the last sync, the state to seal, the autosync switch and whether the remote answers, with a bad key, an unreadable `team.json` or a checkout that follows another remote or branch as warnings that name the init to run with `--key <team key>`, and a remote that does not answer as a warning with the reason git gave.

## What travels and what stays

- Travels, sealed with the team key: the project state documents under `~/.egc/state/`.
- Stays on the machine, in current versions: the SQLite memory store, the machine's own encryption and integrity keys, the integrity sidecars next to the state documents, the logs.
- A remote used with EGC 1.1.23 or earlier may still hold, in its history, the memory store those versions committed in the clear and the integrity sidecars they pushed. Rewrite that history or move the team to a new repository.
- The team key lives in `~/.egc/team.json` on each machine. Share it between your machines by a trusted channel. If every copy is lost, start a new team.

## Two machines in four steps

1. On the first machine: `egc team init --backend git --remote <url>`. Note the team key.
2. On the first machine: `egc team sync`.
3. On the second machine: `egc team init --backend git --remote <url> --key <team key>`.
4. On the second machine: `egc team sync`. The state of the first machine arrives.

## Limits to know

- A project is matched across machines by its `origin` remote, so the same repository under different folders is one project. A directory without a remote is matched by the last two segments of its path; a directory written by a version before the remote identity keeps its old name on the machine that wrote it, and the sync shares its documents under the key of the repository while that machine still has it ([#2063](https://github.com/Fmarzochi/EGC/issues/2063)).
- When both machines changed the same document, the one with the later `updated:` time replaces the other as a whole ([#2055](https://github.com/Fmarzochi/EGC/issues/2055)).
- The repository carries a marker of its team key (`TEAM`, an HMAC of a fixed text under a derived key, never the key itself), written by the first sync of a machine whose key is the team's. `egc team init` and `egc team sync` refuse a key that does not match it and opens none of the state files of the repository (read for that alone), before anything is merged, written locally or pushed, with `This key is not the key of the team that uses <remote>`; a marker that does not match while the key opens the files is damaged, and the sync says so and writes it again. On a repository from before the marker, `init` asks the key to open one of the state files it already holds; an empty repository takes any key, since it starts the team, and its first sync pushes as before and writes the marker. A repository from an older version has no marker until the right key syncs once; until then a key that opens none of the state files already on the remote pushes nothing, the sync exits 1 and the shared state stays as it was. Fix the key with `egc team init ... --key <team key>` and sync again.
- A remote that cannot be read stops `egc team init` and `egc team sync` with the reason git gave and exit 1. Check it with `git ls-remote <url>`.
- `init` with another `--branch` or `--remote` on a machine that already has a checkout is refused, and the configuration goes back to what it was. Delete `~/.egc/team-sync/` first (your state is not in it) and run `init` again, with the same `--key <team key>` when the machine joins a team that exists; without `--key` it starts a new team.
