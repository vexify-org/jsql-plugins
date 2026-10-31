# uuid

Auto-fill a `uuid` (v4) column for every table in JSQL-neo. The column is created
automatically on install (for existing tables) and on every `createTable` call (for
future tables). On `insert`, each row gets a freshly generated UUID v4 unless one is
already provided.

## Install

```js
const { JSQL } = require('jsql-neo');
const uuid = require('jsql-plugins/uuid');

const db = new JSQL();
await db.start();
db.use(uuid);

await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });
await db.insert('users', [{ name: 'Alice' }, { name: 'Bob' }]);

const rows = await db.find('users', {});
// each row now has a `uuid` field, e.g. "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
console.log(rows.map((r) => r.uuid));
```

## API

- `db.use(uuid)` — installs the plugin; adds the `uuid` column to all tables.
- `db.genUUID()` — returns a new RFC4122 v4 UUID string.

## Notes

- The `uuid` column is a normal `string` column; it does not replace the primary key.
- If you supply your own `uuid` on insert, it is kept as-is.
- Pure JavaScript, no native dependencies, no network access.
