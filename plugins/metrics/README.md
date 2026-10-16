# JSQL Metrics Plugin

Query performance profiler for JSQL-NEO. Aggregates latency per normalized SQL pattern, keeps a slow-query log, and exposes a stats API. **Read-only observation** — the plugin never returns `false` from a hook and never modifies query arguments, so engine behavior is unchanged. Zero dependencies; works on all engines (Native / WASM / Pure JS).

## Installation

```bash
jsql plugin install metrics
```

## Usage

```javascript
const JSQL = require("jsql-neo");
const metrics = require("jsql-metrics");

const db = new JSQL();

// Optional: slow-query threshold in ms (default 100), set before use()
metrics.config = { slowMs: 50 };

db.use(metrics);

db.query("SELECT * FROM users WHERE id = 1");
db.query("SELECT * FROM users WHERE id = 2");   // same pattern as above

const m = db.plugin("metrics");
m.stats();     // aggregated stats, sorted by total time desc
m.slow();      // queries slower than the threshold
m.setSlowMs(20);
m.reset();     // clear everything
```

## Stats fields

| Field | Description |
| --- | --- |
| `pattern` | SQL with string literals and numbers masked to `?` |
| `count` | Number of executions of this pattern |
| `totalMs` | Cumulative wall-clock time |
| `avgMs` | `totalMs / count` (rounded to 2 decimals) |
| `maxMs` | Slowest single execution |
| `lastMs` | Most recent execution |

## Slow-query log

Queries with `ms >= slowMs` are appended to a bounded ring buffer (max 100 entries). Each entry: `{ sql, ms, at }` with `at` as an ISO timestamp.

## How it works

- `beforeQuery` pushes `Date.now()` into a per-key FIFO array (key = SQL + serialized params), so concurrent executions of the same statement pair up correctly.
- `afterQuery` pops the oldest start time, computes the delta, aggregates by normalized pattern, and appends to the slow log when over threshold.
- The plugin API (`stats` / `slow` / `slowMs` / `setSlowMs` / `reset`) is exposed via `db.plugin('metrics')`.

## Known boundary

If `executeSQL` throws, `afterQuery` never fires and that timing entry stays in the in-flight map. The map is bounded per key (32 entries) and cleared by `reset()`.
