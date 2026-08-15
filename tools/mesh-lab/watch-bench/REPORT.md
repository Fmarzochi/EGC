# File-watch semantics for the mesh transport: measurements and recommendation

Deliverable for issue #1253 (real-time session mesh design, #1251). Every
claim below is backed by a measurement from `run-bench.js` in this
directory or by a cited platform behavior reproduced by it. No production
code: evidence only.

## How to reproduce

```bash
node tools/mesh-lab/watch-bench/run-bench.js --json my-platform.json
```

One self-contained script, Node builtins only. It measures wake latency
(200 timed appends to a `state.db-wal` file, the mesh's real workload,
each armed only after the event stream has gone quiet), event coalescing
(20 bursts of 50 synchronous appends), checkpoint-like mutation patterns
(atomic replace, unlink+recreate, truncate: what fires, and whether a
file watch is still alive afterwards), and local watcher limits.

## Platforms measured

| | Linux (inotify) | macOS (FSEvents dir watch; kqueue file watch) | Windows (ReadDirectoryChangesW) |
| --- | --- | --- | --- |
| environment | Ubuntu 25.10, kernel 6.17, Node v24.16.0, x64 | macOS 15.7 (Darwin 24.6), Node v20.18.0, x64 | **pending: run the script above and PR your numbers** |
| run date | 2026-08-15 | 2026-08-15 | |
| wake latency p50 (idle stream) | **0.16ms** | **11.5ms** | |
| wake latency p95 | 0.24ms | 12.86ms | |
| wake latency p99 / max | 0.29 / 0.49ms | 12.98 / 13ms | |
| missed wakes (of 200) | 0 | 0 | |
| notifications per 50-append burst | exactly 1 (all 20 rounds) | 1 (mean 1.0) | |
| appends per notification | 50 | 50 | |
| dir watch survives atomic replace | yes | yes | |
| FILE watch survives atomic replace | **no, silently** (no error event) | **no, silently** (no error event) | |
| FILE watch survives unlink+recreate | no, silently | no, silently | |
| truncate in place | both watches keep reporting | both watches keep reporting | |
| relevant limits | max_user_watches 65536, **max_user_instances 128**, max_queued_events 16384 | kern_maxfiles 122880, kern_maxfilesperproc 61440 | |

## Answers to the mission's questions

**1. Wake latency for `-wal` appends.** Linux inotify wakes in a fraction
of a millisecond (p95 0.24ms) with zero misses. macOS wakes in ~11-13ms
on an idle stream: and here lives a measurement trap worth recording.
With a hot stream (samples taken back to back, no quiet gap), FSEvents
aligns deliveries to its internal window and the same machine reads a
flat ~47-50ms per wake: four times slower than reality for the mesh's
actual workload, where the bus is idle until an event arrives. The
harness therefore arms each sample only after 120ms without events.
Both regimes sit far inside the mesh's 250ms p95 delivery budget;
nothing on these two platforms justifies polling.

**2. Coalescing.** Notifications are never 1:1 with writes on either
platform: 50 back-to-back appends collapse into one notification on both.
Any design that counts events, or reads "one event = one message", is
wrong by construction. The watcher can only be a wake signal; the store
(an id cursor over `bus_events`) is the source of truth for what actually
arrived.

**3. Atomic writes and renames (checkpoint-like patterns).** The sharpest
result of the bench: after an atomic replace or an unlink+recreate, a
FILE watch on the target goes deaf on both platforms and emits NO error:
the probe append after the swap is simply never reported. On Linux that
is inotify holding a dead inode; on macOS the per-file watch is kqueue
(fd-based) under Node, so the swapped inode kills it the same way, while
the FSEvents-backed DIRECTORY watch keeps reporting through every
scenario measured. SQLite checkpoints rewrite the main db and editors
atomic-save exactly this way, so a mesh transport watching a file path,
not a directory, will eventually stop delivering with no signal that
anything broke.

**4. Failure modes worth designing around.**
- *Silent file-watch death on inode swap* (measured above): watch the
  directory, never the file.
- *Coalescing* (measured above): re-read by cursor after every wake.
- *inotify instance ceiling*: libuv opens one inotify instance per event
  loop, and the default `max_user_instances` is 128. The mesh spec has no
  designed ceiling on tabs; tab number 129's watcher can fail to start on
  a default Linux box, and `fs.watch` throws SYNCHRONOUSLY in that case.
  The transport must catch at creation and degrade to interval mode,
  which is exactly what the v0 transport does.
- *Network drives*: inotify and FSEvents both report local operations
  only; changes made by another host on NFS/SMB mounts fire no events.
  The bounded repoll ceiling is the only correct backstop there.
- *Measurement trap*: sampling wake latency with a hot stream inflates
  macOS numbers ~4x (window alignment). Third parties producing the
  Windows column should keep the harness's quiet-gap arming as is.

**5. Recommendation for the mesh transport.**
- On every platform: **directory watch + short debounce + cursor re-read**,
  with a bounded repoll ceiling (seconds) as the universal backstop
  against dropped events, network mounts, and watcher death, and an
  interval fallback when `fs.watch` is unavailable or throws at creation.
- Linux: `fs.watch` (inotify) as-is; latency budget is trivially met.
- macOS: `fs.watch` (FSEvents directory watch) as-is; ~11-13ms idle wake
  is well inside budget: do not try to buy the burst-window regime back
  with polling.
- Windows: expected to behave dir-natively (ReadDirectoryChangesW watches
  directories by design; its known failure mode is buffer overflow under
  event storms, which the cursor re-read absorbs). Numbers pending: the
  harness runs unmodified; PR your JSON.
- What the mesh must never assume, on any platform: that one notification
  equals one event, that a file watch outlives an inode swap, or that a
  watcher failing means the bus stopped moving.
