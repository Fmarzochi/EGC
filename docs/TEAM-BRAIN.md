# Team Brain for one person

The Team Brain keeps your EGC memory in step across your own machines. You pick a git remote that you control, run `egc team init` once per machine, and `egc team sync` moves the project state between them. No EGC server is involved: the remote is a plain git repository, and the data in it is sealed with a key that only your machines hold.

This page covers one person with two or more machines. Teams of several people are a later step; see [VISION.md](VISION.md) and [ROADMAP.md](ROADMAP.md).

## What travels and what stays

| Travels to the remote, sealed | Never leaves the machine |
|---|---|
| The project state documents under `~/.egc/state/<project>/`, one file per branch: context, decisions, things to avoid, preferences, next steps. `<project>` is the name of the repository followed by `--` and the SHA-256 of its normalized `origin` URL (`app--3f9a...`), the same on every machine that has that repository, whatever the folder it sits in; a directory without a remote is named after the last two segments of its path (`Projects--app`), and a machine upgraded from a version before the remote identity can still hold that path-named directory next to the keyed one, read until the project is written again. Current versions name the file after the sanitized branch name (`/` becomes `-`, other unusual characters become `_`, and the readable part is cut at 120 characters) followed by `--` and the SHA-256 of the full branch name; versions before the hash named it after the branch alone (`main.md`), and a machine upgraded from one of them can hold both, which is why the examples below show `main.md` | The SQLite memory store under `~/.egc/memory/` (lessons, history, the session bus, working memory), and the integrity sidecars (`<file>.hmac`) next to the state documents, made with this machine's own integrity key and written anew after a merge |
| | The machine's own keys: `~/.egc/encryption.key`, which seals the local copy of the state, and `~/.egc/integrity.key`, which makes the sidecars |
| | Logs under `~/.egc/logs/` |
| | The team key, except inside `~/.egc/team.json` on each of your machines |

Each state document is encrypted with the team key (AES-256-GCM) and signed with a key derived from it (HMAC-SHA256) before it is committed. The signature covers the file's path in the repository, so a file copied to another path, edited in the repository or written by someone without the team key is not accepted. The remote sees these sealed files and their paths. It also sees the commits, whose message and author carry your local username (`sync: team memory update from <user>`, author `<user>@egc.local`).

An earlier version of `egc team sync` also copied `~/.egc/memory/` into the checkout in the clear, and pushed the integrity sidecars next to the state documents. The current version does neither, and it removes a pushed sidecar from the shared tree on the next sync, but a remote that received them keeps those files in its history. If you used the Team Brain with an earlier version, rewrite the history of that remote or start with a new repository.

The local copy of your state stays encrypted at rest with the machine's own key, as it is without the Team Brain. The two keys are unrelated: replacing one never touches the other.

## Before you start

- Node and git on every machine, and `egc` installed with the memory server built (`egc doctor` checks this).
- An empty git repository that you own, for example a private repository on your git host. Use a private one: the files are sealed, but their directory names show the names of your repositories (not the host, the owner or your folders), or the last two folder names of a directory without an `origin`, and their file names the names of your branches.
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

The state document of the first machine is now under `~/.egc/state/` on the second one, readable through `get_state` like any other. It is read for the same repository wherever this machine keeps its checkout: a project is matched by its `origin` remote, not by the folder path, so `/home/you/Projetos/app` on one machine and `/Users/you/Projects/app` on the other are one project. `Pulled` counts the files of the latest commit in the local checkout, so a sync that fetched nothing new can report the previous commit's files again.

Pass the same `--branch <name>` on every machine, or they sync to different branches and never meet. The branch and the remote are fixed when the checkout in `~/.egc/team-sync/` is first made: running `init` again with another `--branch` or another `--remote` is refused, the configuration goes back to what it was (the previous one, or none when there was none), and the message says what to do. To move a machine to another branch or to a new repository, delete `~/.egc/team-sync/` first (your state in `~/.egc/state/` is not affected) and run `init` again, with the same `--key <team key>` when the machine joins a team that exists; without `--key`, `init` starts a new team with a new key.

## The team key

- `egc team init` makes the key when you do not pass `--key`. It prints it once, and it is also stored in `~/.egc/team.json` on that machine. On Linux and macOS the file is created readable only by you (mode 0600); on Windows that mode is not enforced, so check the file's permissions. A later `egc team init` without `--key` makes a new key and a new team.
- Every machine of the team holds the same key. There is no other copy: EGC does not store it anywhere else.
- If you lose it on every machine, the sealed files on the remote can no longer be opened. You start a new team: delete `~/.egc/team-sync/` on each machine, run `egc team init` again (without `--key`) against a new empty repository, and join your other machines to it with the new key. Your local state on each machine is not affected.
- If the key leaks, anyone who can read the remote can read the shared state. Make a new team with a new key and a new empty repository (deleting `~/.egc/team-sync/` on each machine first), and delete the old repository.

## Reading the result of a sync

`egc team sync` prints `Sync complete:` and exits 0, or `Sync did not complete:` and exits 1 when it reports an error, including when it cannot read the remote. `egc team status` reads the local checkout only, so it answers while the remote is down.

| Line | Meaning |
|---|---|
| `Pulled: N files` | N files changed in the latest commit of the local checkout. After a no-op pull it repeats the previous commit's files. |
| `Pushed: N commits` | This machine had something new to push and pushed it. `1` or `0`. |
| `Rejected: N files (not verified team envelopes)` | N entries of the sync were refused during the merge. Most are files from the remote that did not open with your team key or were not at the path they were sealed for: they are not merged, they stay where they are in the local checkout of the remote, and this machine's state for those paths is not written over them. The count also carries a link found in the local or the sync tree, and a document whose local path goes through a link: a link is never state, and one in the checkout is removed. When at least one state file exists on the remote and none of them opened, the sync also pushes nothing, because a key that opened nothing is not shown to be the team's key. |
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

When both machines have a copy of the same document, the sync merges them section by section, the way `update_state` merges an update into the existing document (the merge rules of the AMI specification, `docs/spec/agent-memory-interchange.md`, section 5):

The copy with the later `updated:` time leads; two copies with the same time are ordered by the number of their entries (decisions, things to avoid and preferences together) and then by the SHA-256 of their text, so both machines reach the same result whichever one merges, and the result of a merge leads over the copies it came from.

- **Context**: the paragraph of the leading copy; a copy with no context keeps the paragraph of the other.
- **Active Decisions, Do Not Repeat, Preferences**: the union of both copies, one entry per text. The leading copy keeps its order, and an entry only the other copy has is placed where that copy kept it, among the entries both have, so what you added on the laptop in the morning and what you added on the desktop in the afternoon both survive the sync at night. The lists are capped afterwards (15, 10 and 15 entries): what the cap drops is the end of the merged list, the oldest of the entries both copies share, or an entry the older copy kept after all of them.
- **Next Session**: the list of the leading copy, whole; it describes the immediate future and is rewritten on every update.

An entry that left a document (pushed past a cap, or dropped when `update_state` rewrote the document) does not come back from a machine that still carries an older copy: the document keeps a short list of marks in its header (`retired:`, a hash of each entry and the time of the write or of the sync that dropped it), the merge keeps such an entry out of every copy that still carries it, whatever the time of that copy, and lets it back in when a machine that holds the retirement adds the entry again (that write records the return next to the retirement, and the return wins). A machine that never saw the removal and adds the same text again on its own sees it leave at its next sync; adding it once more, now with the removal in hand, brings it back everywhere. A mark is kept for up to thirty days, and the list holds at most forty marks, newest first, so the protection is bounded by both; `get_state` and the hooks never show the line. Merging the two copies in either order, at the same moment, gives the same document, merging a document with an identical copy returns it as it is, and merging it with a copy it already contains changes nothing in its content, so repeated syncs converge.

A document from a version before the merge, or any file without the five sections, still follows the old rule: the copy with the later `updated:` time stands, whole, and nothing in it is lost to the layout.

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
  Pushed: 0 commits
  Rejected: 1 files (not verified team envelopes)
  Error: Rejected sync file (not a verified team envelope for its path): demo-project\main.md
  Error: This team key opened none of the remote state (the one state file), so nothing was pushed and the shared state was left as it was. If the key is wrong, run egc team init again with the key of the team; if the key is right, the files on the remote are damaged and have to be removed from the repository by hand.
```

The path in the first error line uses the separator of your system. The file on the remote was sealed with a different key, so this machine was probably given the wrong one. The sync exits 1, and because no remote file opened it pushes nothing: the file stays in the local checkout and on the shared branch, exactly as it was, and no envelope sealed with the wrong key reaches the other machines.

Fix the key (`egc team init ... --key <the right key>`) and sync again. When at least one remote file opens, the key is taken as the team's: the files that still do not open are reported and left in place, this machine's state for those paths is not pushed over them, and the sync pushes the rest as usual. A file that stays unopened on every machine of the team is damaged or belongs to another key; remove it from the repository by hand. If a machine still holds that state locally, its next sync fills the path again; if no machine does, the contents of that file cannot be recovered by a sync. A first sync into an empty remote is not this case: nothing is on the remote to open, and the sync pushes this machine's state.

### `The remote <url> cannot be read: ...`

```text
$ egc team sync
Syncing team memory...
Sync did not complete:
  Pulled: 0 files
  Pushed: 0 commits
  Error: Sync backend init failed: The remote https://github.com/you/no-such-repo.git cannot be read: repository 'https://github.com/you/no-such-repo.git/' not found
```

The remote could not be reached for reading, so the sync stops before anything moves and exits 1; `egc team init` against such a remote stops the same way, with the reason on its last line. Typical causes are a mistyped URL, a host key that is not known yet (the reason then carries `Host key verification failed`), or a missing credential. Check the remote with plain git, outside EGC:

```bash
git ls-remote <your remote>
```

If that fails, fix it first. For an SSH remote (`git@host:owner/name.git`), run it once in a terminal so the host key is accepted. A repository that exists and can be read but has no branch yet is not this case: the first sync into it pulls nothing and pushes the first commit.

### `Push failed: ...`

The remote could be read but refused the push: your credentials have no write access to it, or the branch is protected. The reason git gave follows the prefix. The sync exits 1 after pulling and merging, so the local state is up to date and only this machine's state is missing on the remote. `egc team status` still answers, because it reads the local checkout only.

### `Local state file could not be decrypted and was left untouched`

A file in `~/.egc/state/` does not open with this machine's own key, for example after the key in `~/.egc/encryption.key` was replaced. EGC leaves that file as it is and does not send it to the remote.

### `The sync checkout at ~/.egc/team-sync follows <remote> on branch <branch>, not ...`

```text
$ egc team init --backend git --remote https://github.com/you/egc-memory.git --branch another --key <team key>
Error: The sync checkout at ~/.egc/team-sync follows https://github.com/you/egc-memory.git on branch main, not https://github.com/you/egc-memory.git on branch another. Remove that directory (your state under ~/.egc/state is not in it) and run egc team init again.
The previous configuration was kept.
```

This machine already has a checkout made for another remote (as `origin`, for fetching or for pushing) or another branch, and `init` does not move it. `~/.egc/team.json` goes back to what it was, so the next sync still follows the old configuration; when no configuration existed before, the new file is removed and the last line says `No configuration was written.` A configuration changed by hand stops `egc team sync` with the same sentence after `Sync backend init failed:`. To change the remote or the branch, delete `~/.egc/team-sync/` (it holds only the sealed copy of the shared repository; your state in `~/.egc/state/` is not in it) and run `init` again, with the same `--key <team key>` when the machine joins a team that exists.

### `Memory server not built` or `team sync needs the memory server`

The command line talks to the memory server. Run `egc doctor`, and `npm run build` in `mcp/servers/egc-memory/` when you work from a source checkout. When the line continues with `The memory server did not answer team_sync within 60 s; the server wrote: ...` or `The memory server exited with code <n> before answering ...`, the server started and the quoted lines are the last thing it logged; the troubleshooting guide covers both, and the usual cause of the first, a git remote that stopped to ask a question.

## Current limitations

- **Documents from before the remote identity keep their old name on the machine that wrote them.** A directory named after the folder path (`Projects--app`), written by a version before #2063, is still read there, and the sync shares its documents under the key of the repository as long as that machine still has the repository and no keyed document of the same branch exists yet, so your other machines read them for their own checkouts; the next `update_state` writes under the key, and the old directory is left as it is. A repository whose `origin` is declared only through an `include` of the git config, or that has no `origin`, is keyed by its path as before.
- **Only a checkout under your home directory, or under the temp directory, is keyed by its remote.** The identity is read from `.git/config` through the same trust boundary as the branch, so a repository under `/opt` or `/workspace` keeps the slug of its path on every machine. An `origin` declared only through an `include` of the git config, or only in a per-worktree config, is not seen either.
- **Every machine must run this version before the documents of the older one meet the others.** A document a machine on an earlier version shared under the slug of its path is read by the other machines only after that machine runs this version and syncs once, since only it can name the repository behind that path.
- **Two repositories on one host of your own that differ only by a leading slash are one identity.** The scp-like forms `host:dir/repo.git` and `host:/dir/repo.git` fold together, as GitHub, GitLab and the other hosting services treat them; use the `ssh://` form for both when a host of your own holds two such repositories.
- **Deleting a whole document does not propagate.** A document removed on one machine stays on the others and comes back at the next sync. An entry removed inside a document stays out while its retired mark is kept, up to thirty days and forty marks at most, unless a machine adds it again.
- **No machine identity in the envelope.** The signature proves that the holder of the team key wrote the file, not which machine. Tracked in [#2056](https://github.com/Fmarzochi/EGC/issues/2056).
- **Manual only.** Nothing syncs by itself; you run `egc team sync`. Automatic sync at the start and end of a session is tracked in [#2059](https://github.com/Fmarzochi/EGC/issues/2059).
- **No health line in `egc doctor`.** Tracked in [#2058](https://github.com/Fmarzochi/EGC/issues/2058).
- **One commit per sync, even with nothing new.** Every sync seals each document again with a fresh nonce, so the files differ byte for byte and each run commits and pushes, which grows the history of the remote.
- **The only backend is git.** `--backend` accepts `git` and nothing else.
- **Tested on Windows 10 with Node 25 and an HTTPS remote.** The outputs above come from those runs, with home directories shortened to `~`, the remote renamed and the key replaced by a placeholder. macOS and Linux runs are tracked in [#2061](https://github.com/Fmarzochi/EGC/issues/2061). An SSH remote has not been run to a successful sync for this guide.
