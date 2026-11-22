# Team Brain for one person

The Team Brain keeps your EGC memory in step across your own machines. You pick a git remote that you control, run `egc team init` once per machine, and `egc team sync` moves the project state between them. No EGC server is involved: the remote is a plain git repository, and the data in it is sealed with a key that only your machines hold.

This page covers one person with two or more machines. Teams of several people are a later step; see [VISION.md](VISION.md) and [ROADMAP.md](ROADMAP.md).

## What travels and what stays

| Travels to the remote, sealed | Never leaves the machine |
|---|---|
| The project state documents under `~/.egc/state/<project>/`, one file per branch: context, decisions, things to avoid, preferences, next steps. `<project>` is the name of the repository followed by `--` and the SHA-256 of its normalized `origin` URL (`app--3f9a...`), the same on every machine that has that repository, whatever the folder it sits in; a directory without a remote is named after the last two segments of its path (`Projects--app`), and a machine upgraded from a version before the remote identity can still hold that path-named directory next to the keyed one, read until the project is written again. Current versions name the file after the sanitized branch name (`/` becomes `-`, other unusual characters become `_`, and the readable part is cut at 120 characters) followed by `--` and the SHA-256 of the full branch name; versions before the hash named it after the branch alone (`main.md`), and a machine upgraded from one of them can hold both, which is why the examples below show `main.md` | The SQLite memory store under `~/.egc/memory/` as a file (what it holds of lessons, decisions and working memory travels as the sealed records of the row above; the session bus stays home), and the integrity sidecars (`<file>.hmac`) next to the state documents, made with this machine's own integrity key and written anew after a merge |
| The user-wide memory, `~/.egc/global/state.md` (what `update_state` writes with `scope: "global"`, appended to every project's state), kept in the `global/` tree of the repository next to the `state/` tree and merged section by section like a project document. Each tree's documents are signed over their path within that tree (`state.md` in `global/`, `<project>/<branch>--<sha256>.md` in `state/`, with the names in the form described above). Every machine that holds the team key reads the user-wide memory, so keep the key on your own machines. Only the Markdown documents of the two trees leave: a lock beside a document while it is written, or the backup of a document that did not open, stays where it is | The machine's own keys: `~/.egc/encryption.key` (or the file `EGC_ENCRYPTION_KEY_FILE` names), which seals the local copy of the state, and `~/.egc/integrity.key`, which makes the sidecars |
| The lessons, the decisions of the history and the working memory, one sealed record per row, kept under `records/` in the repository and signed over its path within that tree (`<kind>/<id>.json`), merged by id on the other machines: a lesson reinforced on two machines keeps the higher confidence and the later dates, a decision is written once, a working memory entry comes only when written later and never once expired. Each record names the machine it was written on (shown by `lesson_recall`, `query_history` and `search_history`) and, for a repository with an `origin` remote, the repository by that remote, so `working_memory_get` on another machine reads the entry of the same repository under its own folder; a project without a remote is known by its path, and its working memory meets only the same path on another machine. A record that holds what looks like a credential, or is above 64 KiB, stays on the machine, as a state document would, and the sync says so | |
| | Logs under `~/.egc/logs/` |
| A marker of the team key, the file `TEAM` at the root of the repository: the HMAC-SHA256 of a fixed text under a key derived from the team key, 64 hexadecimal characters that name the team without holding anything the key can be recovered from. Written by the first sync of a machine whose key is the team's, and checked by every init and sync before a state file is read | The team key, except inside `~/.egc/team.json` on each of your machines |

Each state document is encrypted with the team key (AES-256-GCM) and signed with a key derived from it (HMAC-SHA256) before it is committed. The signature covers the file's path in the repository, so a file copied to another path, edited in the repository or written by someone without the team key is not accepted. The remote sees these sealed files and their paths. It also sees the commits, whose message and author carry your local username (`sync: team memory update from <user>`, author `<user>@egc.local`).

An earlier version of `egc team sync` also copied `~/.egc/memory/` into the checkout in the clear, and pushed the integrity sidecars next to the state documents. The current version does neither, and it removes a pushed sidecar from the shared tree on the next sync, but a remote that received them keeps those files in its history. If you used the Team Brain with an earlier version, rewrite the history of that remote or start with a new repository.

The local copy of your state stays encrypted at rest with the machine's own key, as it is without the Team Brain. The two keys are unrelated: replacing one never touches the other.

## What is refused on the way out

Before a document is sealed for the push, three checks keep it on the machine:

- A document that holds what looks like a credential (a private key block, an AWS access key id in its `AKIA` or temporary `ASIA` form, a GitHub, Slack or Google token, an Anthropic or OpenAI key, a JSON web token, or an assignment of a name such as `password`, `secret`, `token`, `api_key` or `client_secret` to a quoted value of eight characters or more or a bare one of twelve or more, with `=` or `:`) is not staged. The sync warns `Not pushed: state/<path> holds what looks like a GitHub token`; remove or replace that content on that machine and sync again (an `update_state` that leaves the entry in place keeps the document refused). The version pushed before, if any, stays on the remote.
- A document above 256 KiB of text is not staged, with its size in the warning.
- A push carries at most 4 MiB of new or changed documents; a document already on the remote as it is costs nothing, so a state larger than that goes out over several pushes, the documents left over refused with the same warning until their turn.

The automatic pull has a floor: several sessions starting on one machine within 20 seconds pull once, not once each (one of them holds a claim while it pulls, the others see the claim or the record it leaves). The automatic push at the end of a response runs only when a document changed since the last run; the pull when a session starts and `egc team sync` by hand push whatever is new.

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

On the same network, nothing is copied. On the first machine run `egc team invite`; on the new one run `egc team join` (it finds the invitation by itself; where it does not, `egc team invite` prints the address to give it, `egc team join 192.168.1.50:51234`). The two machines exchange keys (X25519) and both screens show the same six digits taken from that exchange: read them side by side and answer yes on both. No key is copied by hand. The digits are a check, not a proof: digits that differ mean the two machines did not make the same exchange (something may stand between them), and the same digits make an intermediary unlikely, not impossible. Only then does the team cross, sealed by the exchange, with the address of the central when the first machine has one. Different digits on the two screens mean someone stands between the machines: answer no, and nothing is shared. The new machine then syncs from its next session; `egc team sync` pulls the state at once.

Where the invitation is not found by itself (the machines are not on the same network), `egc team join <host:port>` still pairs over any address the new machine can reach, a VPN or a routed network included. Where no direct connection exists, copy the team key from the first machine by a channel you trust (a password manager, a message to yourself over an encrypted app). Then run the same `init` with `--key` alone: it asks for the key and does not show it as you type, so the key reaches neither the process list nor your shell history. `--key <64 hexadecimal characters>` on the command line still works, for a script, and then the key shows in both: remove that line from the history afterwards, and do not run it on a shared machine.

```text
$ egc team init --backend git --remote https://github.com/you/egc-memory.git --key
Team key (64 hexadecimal characters, not shown):
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

`egc team sync` prints `Sync complete:` and exits 0, or `Sync did not complete:` and exits 1 when it reports an error, including when it cannot read the remote. A `Warning:` line under a complete sync says what the sync fixed on the way without failing: the one case today is the `TEAM` marker of the repository that did not match the key while the key opened the state files, written again with that sync. `egc team status` reads the local checkout only, so it answers while the remote is down.

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

## Syncing by itself

The sync around the session is on from `egc team init`: the sessions sync by themselves, and `egc team init ... --no-autosync` leaves it off on a machine that should only sync by hand with `egc team sync`. To change it later:

```text
$ egc team autosync off
Autosync: off
Nothing syncs by itself; run "egc team sync".
```

`egc team autosync on` turns it back on. The switch is `autosync: true` in `~/.egc/team.json` of that machine, nowhere else: set it where you want it. A `team.json` written before this version keeps the switch it has until `egc team init` runs again on that machine: `init` writes the switch on unless `--no-autosync` is passed.

With it on:

- When a session starts in Claude Code or OpenCode, the hook that restores the project state syncs first, so the state your other machine pushed is what the session restores. A compaction, which runs the same hook in Claude Code, does not sync. The hooks of the plugin manifest (`hooks/hooks.json`, the layout the retired Gemini CLI loaded) carry the same sync for an install that still loads them.
- When a response ends (the Stop hook of Claude Code, the session-end hook of the plugin manifest), the state syncs again when a state document changed since the last run, so what `update_state` wrote leaves the machine. After the first run, a response that changed nothing syncs nothing; the markers the hooks keep next to the state and the integrity sidecars do not count as a change.
- In Antigravity, Codex, Trae, Amp and Kiro, which have no session start or stop hook, the hook of the turn boundary does it: a sync once per session before its first prompt is answered, which pulls what the other machine pushed and pushes what this machine has that the remote lacks, and on the later turns a push when a state document changed since the last run. The sync gets 6 seconds and the whole wait stays under the 10 seconds of the strictest host; a remote that does not answer is given up for that turn, and the session goes on with the local state. A first sync the server or the budget denied is tried again at the next prompt; one that found another session of this machine pulling at that moment takes that pull as its own.
- Each hook has a budget of 15 seconds, shared with its other work: the session-end hook gives the sync what is left after its commit list, and skips it, saying so once on its stderr, when less than two seconds remain. A remote that does not answer in time is given up for that run and the session goes on with the local state. Nothing of this reaches the chat.

The outcome of every run is one line in `~/.egc/logs/team-autosync.log`, and `egc team status` shows the last one:

```text
$ egc team status
Last sync: 2026-11-14T06:40:12+00:00
Uncommitted changes: false
Remote: https://github.com/you/egc-memory.git
Autosync: on (last run 2026-11-14T06:40:12.418Z, session-end, ok: pulled 0 files, pushed 1 commits)
```

Offline is normal: the run is logged as failed with git's reason and the next session tries again. The OpenCode plugin waits up to 25 seconds for the restore when the switch is on: the sync's 15 seconds, the moments the sync gives a server that answered to leave, and the restore itself.

## Leaving the team

```text
$ egc team leave
Left the team:
  Removed: ~/.egc/team.json (the configuration and the key of this machine)
  Removed: ~/.egc/team-sync (the sync checkout)
  Kept:    the state files of this machine under ~/.egc/state, and the sealed state on https://github.com/you/egc-memory.git
To join again: egc team init --backend git --remote https://github.com/you/egc-memory.git --branch main --key <team key>
```

The state files of this machine stay where they are and keep working without a team; nothing is removed from the remote, so the other machines go on syncing. The key leaves with the configuration: keep it on another machine, or out of band, before the last machine leaves. The remote is printed as the configuration has it, with a credential embedded in the URL masked; a `team.json` that is not a readable configuration is refused, not removed.

## How two copies are merged

When both machines have a copy of the same document, the sync merges them section by section, the way `update_state` merges an update into the existing document (the merge rules of the AMI specification, `docs/spec/agent-memory-interchange.md`, section 5):

The copy with the later `updated:` time leads; two copies with the same time are ordered by the number of their entries (decisions, things to avoid and preferences together) and then by the SHA-256 of their text, so both machines reach the same result whichever one merges, and the result of a merge leads over the copies it came from.

- **Context**: the paragraph of the leading copy; a copy with no context keeps the paragraph of the other.
- **Active Decisions, Do Not Repeat, Preferences**: the union of both copies, one entry per text. The leading copy keeps its order, and an entry only the other copy has is placed where that copy kept it, among the entries both have, so what you added on the laptop in the morning and what you added on the desktop in the afternoon both survive the sync at night. The lists are capped afterwards (15, 10 and 15 entries): what the cap drops is the end of the merged list, the oldest of the entries both copies share, or an entry the older copy kept after all of them.
- **Next Session**: the list of the leading copy, whole; it describes the immediate future and is rewritten on every update.

An entry that left a document (pushed past a cap, or dropped when `update_state` rewrote the document) does not come back from a machine that still carries an older copy: the document keeps a short list of marks in its header (`retired:`, a hash of each entry and the time of the write or of the sync that dropped it), the merge keeps such an entry out of every copy that still carries it, whatever the time of that copy, and lets it back in when a machine that holds the retirement adds the entry again (that write records the return next to the retirement, and the return wins). A machine that never saw the removal and adds the same text again on its own sees it leave at its next sync; adding it once more, now with the removal in hand, brings it back everywhere. A mark is kept for up to thirty days, and the list holds at most forty marks, newest first, so the protection is bounded by both; `get_state` and the hooks never show the line. Merging the two copies in either order, at the same moment, gives the same document, merging a document with an identical copy returns it as it is, and merging it with a copy it already contains changes nothing in its content, so repeated syncs converge.

A document from a version before the merge, or any file without the five sections, still follows the old rule: the copy with the later `updated:` time stands, whole, and nothing in it is lost to the layout.

A sync never deletes a local state file. A file removed on the remote is not removed from your machine, and it comes back to the remote at your next sync.

## Checking the team with `egc doctor`

`egc doctor` prints a `Team` block after the MCP servers (the lines about the state store, when there are any, come after it):

```text
Team: git https://github.com/you/egc-memory.git, branch main, key present
  Last sync: 2026-11-14T06:40:12+00:00
  Local state: 3 files to seal
  Autosync: on (last run 2026-11-14T06:40:12.418Z, session-end, ok)
  Remote: reachable
Team summary: warnings=0
```

Without a team the block is one line, `Team: not configured (egc team init --backend git --remote <url>, with --key <team key> to join a team)`, and no warning. `Last sync` is the time of the last commit of `~/.egc/team-sync/` (`never` before the first sync), `Local state` counts the documents under `~/.egc/state/` the next sync would seal (hidden entries and `.hmac` sidecars left out), and `Remote` is one `git ls-remote` with a budget of 5 seconds, `reachable, no branch pushed yet` before the first sync of the team, skipped with `not checked` when no network interface is up. A remote URL that carries a credential is shown without it, in the block and in the warnings. These are warnings, counted in the doctor's total and never errors: a team key missing or not 64 hexadecimal characters, a `~/.egc/team.json` that exists but cannot be read as a configuration, a backend other than git, a `~/.egc/team-sync/` that is not a git repository or that follows another remote or branch than `team.json` (the next sync would refuse it), and a remote that cannot be read or did not answer within the budget, with the reason git gave. The warnings about the configuration and the checkout name the init to run with `--key <team key>`, since an init without the key starts a new team; the remote warning carries the reason alone, since no init fixes a remote that does not answer. The block reads files and runs git; it never calls the memory server.

A `Mesh` block follows the Team block, from files alone (no server, no network): the central this machine points at and who the machine is on the mesh, whether its bridge runs and is connected (or is moving to a central changed with `egc mesh connect`), and how many other machines it sees. Its warnings are the things that keep the bridge off: a `~/.egc/mesh.json` without a central, a central configured on a machine without a team, a bridge that cannot reach its central. Without a mesh configuration (no `~/.egc/mesh.json`) the block is one line, `Mesh: not configured (egc mesh connect <address> joins the central of your team; egc mesh serve starts one)`, and no warning. A `mesh.json` that holds no address the mesh accepts (another scheme, a user name in it, no host) is reported as `Mesh: configuration unreadable (~/.egc/mesh.json)`, with a warning that says what to run.

```text
Mesh: central ws://192.168.1.50:47470, this machine desk (a1b2c3d4)
  Bridge: connected (pid 41822)
  Online: 2 other machine(s)
Mesh summary: warnings=0
```

## Troubleshooting

### `Error: Team not initialized. Run "egc team init" first.`

`~/.egc/team.json` does not exist on this machine. Run `egc team init --backend git --remote <url>`, adding `--key <team key>` and `--branch <name>` when you join a team that exists.

### `Error: --key must be followed by 64 hexadecimal characters ...`

The key is not 64 characters of `0-9` and `a-f`. Copy it again, whole, with no spaces or line breaks.

### `Error: --remote is required for team init`

Add `--remote <url>`.

### `Team key missing or invalid in team.json`

`~/.egc/team.json` has no usable `teamKey`, for example after editing it by hand. Run `egc team init` again with `--key` to restore it. Nothing was synced.

### `This key is not the key of the team that uses <remote>`

```text
$ egc team init --backend git --remote https://github.com/you/egc-memory.git --key <another key>
Error: This key is not the key of the team that uses https://github.com/you/egc-memory.git: the TEAM marker of the repository was written with another key, and this key opens none of its state files. Join with the key of that team, or use an empty repository for a new one.
No configuration was written.
```

The repository carries the marker of its team, and the key you gave is not that team's: the marker does not match it, and it opens none of the state files of the repository (read for that alone). `egc team init` refuses before the configuration stands: the configuration this machine had is put back (`The previous configuration was kept.`), or none remains (`No configuration was written.`). `egc team sync` with a key changed by hand in `~/.egc/team.json` stops the same way: the pull updated the checkout, and nothing was merged into the local state, written there or pushed. Run `init` again with the key of the team, or point a new team at an empty repository. A repository made by a version before the marker has none until a machine with the right key syncs once; until then `init` asks the key to open one of the state files the repository already holds (an empty repository takes any key, it starts the team), and `sync` applies the rule of the opened files, below. A marker that does not match while the key opens the state files is a damaged marker, not a wrong key: `egc team sync` says so as a warning and writes the marker again with its push.

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

The command line talks to the memory server. Run `egc doctor`, and `npm run build` in `mcp/servers/egc-memory/` when you work from a source checkout. When the line continues with `The memory server did not answer team_sync within 60 s; the server wrote: ...` or `The memory server exited with code <n> before answering ...`, the server started and the quoted lines are the last thing it logged; the troubleshooting guide covers both, including the usual cause of the first with a server from before v1.1.24, a git remote that stopped to ask a question, and the budget `EGC_TEAM_CALL_TIMEOUT_MS` raises for a slow remote.

## Your machines in real time: the mesh (first steps)

The git sync carries the memory between sessions. The mesh carries, in seconds, what the open sessions of your machines need from each other: who is online and which sessions each machine has, the events they send each other and the paths they hold; next, the state as it changes. It is optional: without it, every machine works alone with the git sync, as before.

1. **Run the central on one of your machines** (one with the team key, for now your own computer or a device of yours that stays on): `egc mesh serve` listens on port 47470 (`--port` and `--host` change it) and lets in only the machines that answer its challenge with the key of the team; it never holds the key that opens what they say to each other. To have it back at every login, `egc mesh serve --install` (with the same flags) writes a service of your session and starts it: a systemd user unit on Linux (`loginctl enable-linger` keeps it up with nobody logged in), a launchd agent on macOS, a task at logon on Windows; on a Mac or a Windows machine, also keep the machine from sleeping while it serves the others. `egc mesh status` shows the service, and `egc mesh serve --uninstall` stops and removes it. Nothing needs root.
2. **Point each machine at it:** on the home network, `egc mesh connect` with no address finds the central of your team by itself: the central announces itself by mDNS with a tag of the team, `egc mesh find` lists what answered, and when several centrals of your team answer, `connect` lists them and you connect with the address you choose. A central started with `--no-announce`, or bound to one address with `--host` (an announcement names every address of the machine), is not announced: give its address, as you do where multicast does not travel, a VPN or a server: `egc mesh connect 192.168.1.50:47470` (or a `ws://` or `wss://` URL). From their next start, the memory servers of that machine elect one of themselves to hold the connection, and keep standing for the election every half minute, so one of them always holds it; `egc mesh status` shows the identity of the machine, the central, whether the bridge is connected and how many other machines are online.
3. **Name your machines:** `egc mesh label "desk at home"`; the label is what the other machines show next to a session, and they see a new label with the next presence, within half a minute.

### Where the central runs: five ways

The central is one process that listens on one port and holds the team key; it runs wherever Node runs, and the machines reach it by an address. Without a central everything above still works, through the git remote, only without the real time. Pick one:

1. **Your own computer.** `egc mesh serve --install` on the machine that is on the most. On a Mac or a Windows machine, keep it from sleeping while it serves the others (Energy settings, or Sleep set to Never); on Linux, `loginctl enable-linger` keeps the service up with nobody logged in. The other machines on the same network find it with `egc mesh connect` and no address.
2. **A device that stays on.** A Raspberry Pi or a NAS that runs Node: install EGC there (`npm install -g @egchq/egc`), join the team (`egc team join` from an invitation, or `egc team init --key`) and run the same `egc mesh serve --install`. A NAS that only runs containers: build the image of this repository (`docker build -t egc -f docker/Dockerfile .`), give it a volume for the home of the central and the team key once (`docker run --rm -v egc-central:/home/node/.egc egc node scripts/egc.js team init --backend git --remote <your remote> --key <team key>`), then keep the central up: `docker run -d --name egc-central --restart unless-stopped -p 47470:47470 -v egc-central:/home/node/.egc egc node scripts/egc.js mesh serve --host 0.0.0.0 --no-announce`. A container does not announce itself on your network, so the machines connect by the address of the NAS: `egc mesh connect <nas>:47470`.
3. **A server of yours (a VPS).** Any provider works, since the central is only an address: on the server, install Node and EGC, join the team with `egc team init --key` (the key typed, not pasted), and run `egc mesh serve --install --host 0.0.0.0 --no-announce` with `loginctl enable-linger`. Open TCP 47470 to your machines in the firewall of the provider (on Oracle Cloud, in the security list of the subnet and in the firewall inside the Ubuntu image, both). Each machine connects with `egc mesh connect <server>:47470`. What crosses is sealed end to end, so a plain `ws://` address leaks who talks to whom and when, not what is said; where that matters, put a reverse proxy with TLS in front and connect to its `wss://` address.
4. **The vault in GitHub, GitLab or Gitea.** The git remote is the record the machines reconcile against, with or without a central; the central only makes it real time. Keep the remote where you already keep code, private, and run the central at home (1), on a device (2) or on a server (3). A machine that is often offline keeps up through the remote alone.
5. **A VPN (Tailscale, WireGuard, or the one you have).** The central listens on the address of the VPN (`--host <vpn address>`) on any of the machines above, and a machine away from home connects to it as if it were on the same network: `egc mesh connect <vpn address>:47470`. The announcement does not cross a VPN, so the address is typed once; the exchange of the pairing (`egc team join <host:port>`) works over the VPN too.

Whatever the place, `egc mesh status` on each machine shows the central, the bridge, how many other machines are online and the service, and `egc doctor` repeats the same block with its warnings.

With two machines connected, `session_peers` on one lists the sessions of the other after its own (up to 50 per machine), each with the label of its machine; a project filter matches them by the identity of the repository, its `origin`, since the same project sits in another folder there: a project without a remote is known by the last two segments of its folder path (`work/app`), so two unrelated projects that end the same way would meet; give such a project a remote to tell them apart. A machine that leaves disappears from the others when the central says so, or after ten minutes of silence. `egc mesh disconnect` forgets the central: a bridge that is running steps down within half a minute, and the servers start alone from then on.

Events and locks cross the machines too. `session_send` to a session of your other machine is on the bus of that machine within about a second, as long as both have the same repository open, and a broadcast reaches the sessions of your other machines that have it open; a session parked in `session_wait` wakes then, and a session that is busy reads the event at its next turn, when the `[egc-mesh]` notice tells it to drain the bus. A path a session holds there is refused to `claim_path` here, with the name of the session and of its machine, and `session_peers` lists those locks after the local ones, relative to the project; the locks travel with the presence and at once when they change. What a machine queued before its bridge existed stays on that machine.

Wrote, told. Whenever a tool writes memory (`update_state`, `store_decision`, `lesson_save`, `working_memory_set`), the server tells the other sessions of the machine through the bus and your other machines through the mesh: a session parked in `session_wait` wakes at once, and a busy session reads the notice at its next turn. When the change is one of state and the sync around the session is on (on from `egc team init`; with `egc team autosync off` a write is told and nothing syncs by itself), the machine that wrote schedules a sync with the team remote within thirty seconds of the write, several writes in one, and the machine that hears the notice schedules a pull of the team state two seconds later (a lesson, a decision or a working memory entry is told, and syncs once it travels with the team state too). The tools that have no session hooks push this way too, and a sync still pending when a server stops runs before it closes. The state document itself travels through the mesh as well: sealed the way the git sync seals it, under the same path and with the same refusals (a document that holds what looks like a credential, or that sits behind a link, does not leave the machine by either path), ahead of the notice, and merged section by section into the other machine's state under that machine's own key, with the same checks on arrival. A machine without a git remote keeps up with the others this way, except for a document above 192 KiB, which only the git sync carries; a machine with a remote has the document before its next pull, and the git sync remains the record the machines reconcile against.

What travels through the central is sealed with a key derived from the team key and bound to its sender, its addressee and its moment: the central, and anyone watching the network, cannot read what the machines say, and a box moved, replayed or forged is dropped. They still see which machine talks to which, when, and how much, and a plain `ws://` address shows that to anyone on the path. On your own network that is fine; across an untrusted one, put the central behind `wss://` (a reverse proxy with a certificate) or a VPN such as Tailscale or WireGuard. The address the central listens on is yours to choose: a home network, a VPN, or a rented server; the guides for each come with the next steps of the mesh, together with the discovery of the central on the home network and the pairing of a new machine by a short code.

## Current limitations

- **Documents from before the remote identity keep their old name on the machine that wrote them.** A directory named after the folder path (`Projects--app`), written by a version before #2063, is still read there, and the sync shares its documents under the key of the repository as long as that machine still has the repository and no keyed document of the same branch exists yet, so your other machines read them for their own checkouts; the next `update_state` writes under the key, and the old directory is left as it is. A repository whose `origin` is declared only through an `include` of the git config, or that has no `origin`, is keyed by its path as before.
- **An `origin` declared only in a per-worktree config is not seen.** The identity is read from the `config` of the common git directory, as the branch is read from `.git/HEAD`, from the project's own repository wherever the checkout lives (your home, `/opt`, `/srv`, another drive), never from a system directory; a per-worktree `config` is not read.
- **Every machine must run this version before the documents of the older one meet the others.** A document a machine on an earlier version shared under the slug of its path is read by the other machines only after that machine runs this version and syncs once, since only it can name the repository behind that path.
- **Two repositories on one host of your own that differ only by a leading slash are one identity.** The scp-like forms `host:dir/repo.git` and `host:/dir/repo.git` fold together, as GitHub, GitLab and the other hosting services treat them; use the `ssh://` form for both when a host of your own holds two such repositories.
- **Deleting a whole document does not propagate.** A document removed on one machine stays on the others and comes back at the next sync. An entry removed inside a document stays out while its retired mark is kept, up to thirty days and forty marks at most, unless a machine adds it again.
- **No machine identity in the envelope.** The signature proves that the holder of the team key wrote the file, not which machine. Tracked in [#2056](https://github.com/Fmarzochi/EGC/issues/2056).
- **Autosync waits on the remote at the start of a session.** With `autosync` on, a session start takes as long as the sync, up to 15 seconds on a remote that does not answer, before the state is read. Turn it off on a machine that is often offline and run `egc team sync` by hand there.
- **The only backend is git.** `--backend` accepts `git` and nothing else.
- **Tested on Windows 10 with Node 25 and an HTTPS remote.** The outputs above come from those runs, with home directories shortened to `~`, the remote renamed and the key replaced by a placeholder. macOS and Linux runs are tracked in [#2061](https://github.com/Fmarzochi/EGC/issues/2061). An SSH remote has not been run to a successful sync for this guide.
