# Team Brain for one person

The Team Brain keeps your EGC memory in step across your own machines. You pick a git remote that you control, run `egc team init` once per machine, and `egc team sync` moves the project state between them. No EGC server is involved: the remote is a plain git repository, and the data in it is sealed with a key that only your machines hold.

This page covers one person with two or more machines. Teams of several people are a later step; see [VISION.md](VISION.md) and [ROADMAP.md](ROADMAP.md).

## What travels and what stays

| Travels to the remote, sealed | Never leaves the machine |
|---|---|
| The project state documents under `~/.egc/state/<project>/`, one file per branch: context, decisions, things to avoid, preferences, next steps. Current versions name the file after the branch followed by `--` and the SHA-256 of the branch name; versions before the hash named it after the branch alone (`main.md`), and a machine upgraded from one of them can hold both, which is why the examples below show `main.md`. The integrity sidecars (`<file>.hmac`) next to them are staged too | The SQLite memory store under `~/.egc/memory/` (lessons, history, the session bus, working memory) |
| | The machine's own encryption key, `~/.egc/encryption.key` |
| | Logs under `~/.egc/logs/` |
| | The team key, except inside `~/.egc/team.json` on each of your machines |

Each state document is encrypted with the team key (AES-256-GCM) and signed with a key derived from it (HMAC-SHA256) before it is committed. The signature covers the file's path in the repository, so a file copied to another path, edited in the repository or written by someone without the team key is not accepted. The remote sees these sealed files and their paths. It also sees the commits, whose message and author carry your local username (`sync: team memory update from <user>`, author `<user>@egc.local`).

An earlier version of `egc team sync` also copied `~/.egc/memory/` into the checkout in the clear. The current version no longer does, but a remote that received it keeps that copy in its history. If you used the Team Brain with an earlier version, rewrite the history of that remote or start with a new repository.

The local copy of your state stays encrypted at rest with the machine's own key, as it is without the Team Brain. The two keys are unrelated: replacing one never touches the other.

## Before you start

- Node and git on every machine, and `egc` installed with the memory server built (`egc doctor` checks this).
- An empty git repository that you own, for example a private repository on your git host. Use a private one: the files are sealed, but their paths show your project names.
- Credentials for that remote on every machine (an SSH key or a credential helper). `egc team sync` runs git without a terminal, so it cannot ask for a password.

## Set up the first machine

```text
$ egc team init --backend git --remote https://github.com/you/egc-memory.git
Team initialized:
  Backend: git
  Remote:  https://github.com/you/egc-memory.git
  Branch:  main
  Config:  ~/.egc/team.json
Team key (share it out of band; teammates join with --key):
  <64 hexadecimal characters>
Sync backend configured successfully.
```

`--branch <name>` picks another branch than `main`. Use it if `main` of that repository holds something else.

Then sync once:

```text
$ egc team sync
Syncing team memory...
Sync complete:
  Pulled: 0 files
  Pushed: 1 commits
```

## Set up a second machine

Copy the team key from the first machine by a channel you trust (a password manager, a message to yourself over an encrypted app). Then run the same `init` with `--key`. The command line is the only way to pass the key, so it is visible in the process list while the command runs and is saved in your shell history. Remove that line from the history afterwards, and do not run it on a shared machine.

```text
$ egc team init --backend git --remote https://github.com/you/egc-memory.git --key <64 hexadecimal characters>
Team initialized:
  Backend: git
  Remote:  https://github.com/you/egc-memory.git
  Branch:  main
  Config:  ~/.egc/team.json
Sync backend configured successfully.
```

The key is not printed this time, because you supplied it. Sync:

```text
$ egc team sync
Syncing team memory...
Sync complete:
  Pulled: 1 files
  Pushed: 1 commits
```

The state document of the first machine is now under `~/.egc/state/` on the second one, readable through `get_state` like any other. `Pulled` counts the files of the latest commit in the local checkout, so a sync that fetched nothing new can report the previous commit's files again.

Pass the same `--branch <name>` on every machine, or they sync to different branches and never meet. The branch and the remote are fixed when the checkout in `~/.egc/team-sync/` is first made: running `init` again with another `--branch` changes the config but leaves the checkout on the old branch. To move a machine to another branch or to a new repository, delete `~/.egc/team-sync/` first (your state in `~/.egc/state/` is not affected) and then run `init`.

## The team key

- `egc team init` makes the key when you do not pass `--key`. It prints it once, and it is also stored in `~/.egc/team.json` on that machine. On Linux and macOS the file is created readable only by you (mode 0600); on Windows that mode is not enforced, so check the file's permissions. A later `egc team init` without `--key` makes a new key and a new team.
- Every machine of the team holds the same key. There is no other copy: EGC does not store it anywhere else.
- If you lose it on every machine, the sealed files on the remote can no longer be opened. You start a new team: delete `~/.egc/team-sync/` on each machine, run `egc team init` again (without `--key`) against a new empty repository, and join your other machines to it with the new key. Your local state on each machine is not affected.
- If the key leaks, anyone who can read the remote can read the shared state. Make a new team with a new key and a new empty repository (deleting `~/.egc/team-sync/` on each machine first), and delete the old repository.

## Reading the result of a sync

`egc team sync` prints `Sync complete:` and exits 0, or `Sync did not complete:` and exits 1 when it reports an error. One failure is not reported as an error: when the remote cannot be read and there is nothing to push, the sync prints `Sync complete:` with `0 files` and `0 commits` and exits 0 (see the troubleshooting section).

| Line | Meaning |
|---|---|
| `Pulled: N files` | N files changed in the latest commit of the local checkout. After a no-op pull it repeats the previous commit's files. |
| `Pushed: N commits` | This machine had something new to push and pushed it. `1` or `0`. |
| `Rejected: N files (not verified team envelopes)` | N files from the remote did not open with your team key, or were not at the path they were sealed for. They were not merged, and were removed from the local checkout of the remote. |
| `Conflicts: N` | The local checkout of the remote is in a merge conflict. Resolve it by hand in `~/.egc/team-sync/`. |
| `Error: ...` | One line per problem. See the troubleshooting section. |

`egc team status` shows the time of the last commit in the local checkout, whether it holds uncommitted changes, and the remote:

```text
$ egc team status
Last sync: 2026-11-02T13:26:06+05:30
Uncommitted changes: false
Remote: https://github.com/you/egc-memory.git
```

The time is that of the last commit in `~/.egc/team-sync/`, which is also set by a pull that fetched a teammate's commit. It does not prove that your own last sync reached the remote.

## How two copies are merged

Each state document has an `updated:` line. When both machines have a copy of the same file, the one with the later `updated:` time replaces the other, as a whole file. Nothing is merged inside a document: if you changed the same project on two machines between syncs, the older document is overwritten by the newer one.

A sync never deletes a local state file. A file removed on the remote is not removed from your machine, and it comes back to the remote at your next sync.

## Troubleshooting

### `Error: Team not initialized. Run "egc team init" first.`

`~/.egc/team.json` does not exist on this machine. Run `egc team init --backend git --remote <url>`, adding `--key <team key>` and `--branch <name>` when you join a team that exists.

### `Error: --key must be followed by 64 hexadecimal characters ...`

The key is not 64 characters of `0-9` and `a-f`. Copy it again, whole, with no spaces or line breaks.

### `Error: --remote is required for team init`

Add `--remote <url>`.

### `Team key missing or invalid in team.json`

`~/.egc/team.json` has no usable `teamKey`, for example after editing it by hand. Run `egc team init` again with `--key` to restore it. Nothing was synced.

### `Rejected sync file (not a verified team envelope for its path)`

```text
$ egc team sync
Syncing team memory...
Sync did not complete:
  Pulled: 1 files
  Pushed: 1 commits
  Rejected: 1 files (not verified team envelopes)
  Error: Rejected sync file (not a verified team envelope for its path): demo-project\main.md
```

The path in the last line uses the separator of your system. The file on the remote was sealed with a different key, so this machine was probably given the wrong one. The sync exits 1.

Fix the key first (`egc team init ... --key <the right key>`), before you sync again. This case is worse than it looks, because the rejected file is removed from the local checkout and the sync then commits that removal: the file disappears from the shared branch for every machine. If it happens, run `egc team sync` on a machine that holds the right key. Its state is sealed again and pushed back. The deleted file stays in the git history of the remote if you need it.

### `Pulled: 0 files` and `Pushed: 0 commits` on a first sync that should have moved something

The remote could not be reached for reading, and there was nothing to push. A failing pull is not reported as an error. Typical causes are a mistyped URL, a host key that is not known yet, or a missing credential. Check the remote with plain git, outside EGC:

```bash
git ls-remote <your remote>
```

If that fails, fix it first. For an SSH remote (`git@host:owner/name.git`), run it once in a terminal so the host key is accepted. In a clean home directory, without a known host key, the sync above did exactly this: it reported `Sync complete:` with `0 files` and `0 commits`, and `ssh` itself said `Host key verification failed.`

### `Push failed: ... Repository not found`

```text
$ egc team sync
Syncing team memory...
Sync did not complete:
  Pulled: 0 files
  Pushed: 0 commits
  Error: Push failed: Error: Push failed after setting upstream: Error: Pushing to https://github.com/you/no-such-repo.git
remote: Repository not found.
fatal: repository 'https://github.com/you/no-such-repo.git/' not found

```

The remote does not exist or your credentials cannot write to it. The sync exits 1. `egc team status` still answers, because it reads the local checkout only.

### `Local state file could not be decrypted and was left untouched`

A file in `~/.egc/state/` does not open with this machine's own key, for example after the key in `~/.egc/encryption.key` was replaced. EGC leaves that file as it is and does not send it to the remote.

### `Memory server not built` or `team sync needs the memory server`

The command line talks to the memory server. Run `egc doctor`, and `npm run build` in `mcp/servers/egc-memory/` when you work from a source checkout.

## Current limitations

- **Project identity is not the repository.** The state of a project is stored under a name made from the last two segments of its absolute path (`.../Projects/app` becomes `Projects--app`). The same repository under different folder names on two machines gives two projects that never meet. Tracked in [#2063](https://github.com/Fmarzochi/EGC/issues/2063).
- **The later document wins, per file.** There is no merge inside a document. Tracked in [#2055](https://github.com/Fmarzochi/EGC/issues/2055).
- **The integrity sidecars travel with the state.** Each `.hmac` file is made with the integrity key of the machine that wrote it, so the receiving machine can report an integrity warning for a document it received. The sync stages every file under `~/.egc/state/`; it does not skip the sidecars.
- **Deletions do not propagate.** A document removed on one machine stays on the others.
- **No machine identity in the envelope.** The signature proves that the holder of the team key wrote the file, not which machine. Tracked in [#2056](https://github.com/Fmarzochi/EGC/issues/2056).
- **Manual only.** Nothing syncs by itself; you run `egc team sync`. Automatic sync at the start and end of a session is tracked in [#2059](https://github.com/Fmarzochi/EGC/issues/2059).
- **No health line in `egc doctor`.** Tracked in [#2058](https://github.com/Fmarzochi/EGC/issues/2058).
- **One commit per sync, even with nothing new.** Every sync seals each document again with a fresh nonce, so the files differ byte for byte and each run commits and pushes, which grows the history of the remote.
- **The only backend is git.** `--backend` accepts `git` and nothing else.
- **Tested on Windows 10 with Node 25 and an HTTPS remote.** The outputs above come from those runs, with home directories shortened to `~`, the remote renamed and the key replaced by a placeholder. macOS and Linux runs are tracked in [#2061](https://github.com/Fmarzochi/EGC/issues/2061). An SSH remote has not been run to a successful sync for this guide.
