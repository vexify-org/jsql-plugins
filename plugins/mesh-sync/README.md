# mesh-sync

Mesh data sync plugin for **JSQL-NEO** — replicate a source table to one or more target
databases with CDC (change data capture), snapshot + incremental transfer, multi-replica
acks/retries, and an append-only WAL with checkpoints.

Born from [mesh-neo](https://github.com/vexify-org/mesh-neo)'s `mod/sync.js`; fully
self-contained (only `fs` / `os` / `path`), no external dependencies.

## Install

```bash
jsql plugin install mesh-sync
```

## Quick start

```js
const Database = require('jsql-neo');
const sync = require('mesh-sync');

const db = new Database(':memory:');
db.createTable('users', {
  id: { type: 'integer primary key' },
  name: { type: 'string' },
});

// Configure before db.use(): one source table, N replica targets
sync.opts = {
  srcTable: 'users',
  targets: [
    // target.db omitted => mirror table in the same database
    { table: 'users__mirror', name: 'mirror' },
    // remote/replica database instance
    { db: replicaDb, table: 'users', name: 'replica-a' },
  ],
};

db.use(sync);

db.insert('users', [{ id: 1, name: 'ada' }]); // captured + dispatched automatically
await db.sync.syncNow();                        // drain outboxes now
console.log(db.sync.stats());
```

`db.use(sync)` exposes `db.sync`:

| Method | Description |
| --- | --- |
| `db.sync.syncNow()` | Flush all pending ops to every target; retries failed replicas. |
| `db.sync.snapshot()` | Full copy of source schema + rows (idempotent, runs once). |
| `db.sync.stats()` | `{ seq, snapshotted, outbox, ack, conflicts }` per target. |
| `db.sync.config` | Resolved configuration object. |

## Options (`sync.opts`)

| Option | Default | Meaning |
| --- | --- | --- |
| `srcTable` | `'users'` (or `JSYNC_SRC_TABLE`) | Source table to replicate. |
| `key` | auto from primary key | Sync key column; required if the table has no PK. |
| `targets` | `[{ table: '<src>__mirror', name: 'mirror' }]` | Replica list: `{ db?, table, name, conflict? }`. |
| `conflict` | `'source-wins'` | `'source-wins'` overwrites target rows, `'ignore'` counts conflicts instead. |
| `snapshot` | `true` | Do a full snapshot on start (`onStart`). |
| `flushMode` | `'event'` | `'event'` apply on every change, `'flush'` with `db.flush()`, `'manual'` only via `syncNow()`. |
| `wal` | `true` | Persist captured ops + checkpoints to disk. |
| `walPath` | `os.tmpdir()/jsql-sync.jsonl` | WAL file; checkpoint is `<walPath>.ckpt`. |
| `retryMs` | `1000` | Retry interval for replicas that fail to apply. |

## How it works

1. **CDC capture** — hooks `afterInsert` / `afterUpdate` / `afterDelete` on the source table
   turn every change into an op `{ seq, ts, op, table, key|entries }` and append it to the WAL.
2. **Snapshot + incremental** — on `onStart` the source schema and all rows are copied to each
   target, then only incremental ops are streamed.
3. **Multi-node replicas** — each target has its own outbox and ack watermark; a failing target
   keeps its queue and retries, without blocking the others.
4. **WAL / checkpoint** — checkpoints record `{ seq, ack }` per target; on restart ops with
   `seq > ack` are replayed. Applying is idempotent by primary key, so replays are safe.
5. **onStop** flushes pending work and writes the final checkpoint.

## Notes

- Target tables are created automatically from the source schema when missing.
- Target DBs default to the same `db` instance (in-instance mirror mode), handy for tests.
- JSQL-NEO 6.x DB methods are async; the plugin `await`s `find` / `findById` / `insert` /
  `updateById` / `removeById` / `createTable` internally.
- If the source table does not exist yet when the plugin loads (e.g. registry auto-load at
  startup), the sync key is resolved lazily and the start-up snapshot is skipped; create the
  table and call `await db.sync.snapshot()` yourself.
- `mesh-neo` users: same module API (`createSyncEngine` is re-exported as `require('mesh-sync').create`).

## License

MIT
