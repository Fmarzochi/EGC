# mesh-lab: push delivery over the session-bus WAL store (Linux)

Standalone prototype for issue #1252, part of the real-time session mesh
design (#1251). It proves that newly appended session-bus events can be
delivered to N subscriber processes push-style on Linux: wake on inotify,
no polling loops, over the same `bus_events` shape the production bus uses.

## The contract

The watcher is strictly a **wake signal**. Every delivery comes from
re-reading `bus_events` by id cursor after a wake, so a coalesced, dropped,
or spurious inotify notification can only delay a delivery round (bounded by
the subscriber's repoll ceiling), never lose, duplicate, or reorder one.
That split is what makes WAL semantics survivable: appends land in
`state.db-wal`, checkpoints rewrite `state.db` (sometimes via atomic
renames), and the lab watches the store's **directory**, which keeps
reporting events after the inode swap that silently kills a file watch.

## Layout

- `lib/wal-watcher.js`: directory watch + debounce + parked waiters
- `lib/store.js`: WAL store with the production `bus_events` DDL
- `lib/deps.js`: resolves the sqlite driver from the repo (nothing new installed)
- `subscriber.js`: one subscriber process (own id cursor, IPC reporting)
- `property-test.js`: LCG-generated interleaved multi-writer schedules; per-sender ordering invariant
- `fd-test.js`: 40 create/park/close cycles must hold the fd baseline
- `load-test.js`: 1,000 events -> 10 subscriber processes, checkpoint mid-run, latency report

## Run

```bash
node tools/mesh-lab/watcher/run-tests.js
```

Linux-only by charter; other platforms and driver-less installs skip
cleanly. No new dependencies: the sqlite driver is resolved from the repo
root or the egc-memory server.

## Reference numbers (maintainer machine)

Ubuntu 25.10, Node v24.16.0, 1,000 events x 10 subscribers with a busy
writer (bursts of 25 every 40ms) and a `wal_checkpoint(TRUNCATE)` fired
mid-run:

| metric | value |
| --- | --- |
| p50 delivery latency | 8ms |
| p95 delivery latency | 11ms (budget: 250ms) |
| p99 delivery latency | 12ms |
| max | 14ms |
| loss / duplicates / reorders | 0 / 0 / 0 (10,000 deliveries) |
| fd growth across cycles | 0 |

## The sharpest edge case

The obvious fd-leak assertion (`count(/proc/self/fd)` returns to the
pre-watch baseline) fails even for a perfectly clean implementation: on the
first `fs.watch`, libuv opens **one inotify instance per event loop** and
keeps it for the loop's lifetime after every watcher is closed. The
per-watcher resource is the watch descriptor inside that instance, and it
IS released on `close()`. The honest teardown criterion is therefore zero
fd growth **across cycles** measured against a post-warm-up baseline, which
is what `fd-test.js` and the subscriber report assert. A close cousin:
every parked waiter timer must stay referenced (a promise owed to a caller)
while watcher and debounce handles stay unref'd, or an idle subscriber
process exits mid-await with no error at all.
