# JSQL Validation Plugin

Declarative input validation beyond schema constraints: string length, regex pattern, enum whitelist, number range and cross-field custom rules. Zero dependencies, works on all engines (Native / WASM / Pure JS).

Engine built-ins (`required`, `primaryKey`, `unique`, `check`, numeric min/max) are not duplicated here — this plugin only covers what the schema cannot express.

## Installation

```bash
jsql plugin install validation
```

## Usage

```javascript
const JSQL = require("jsql-neo");
const validation = require("jsql-validation");

// 1. Configure rules (table -> field -> rule)
validation.rules = {
  users: {
    email: { type: "email", required: true },
    age:   { type: "integer", min: 0, max: 150 },
    role:  { enum: ["admin", "user"], message: "role must be admin or user" },
    username: { type: "string", minLength: 3, maxLength: 20, pattern: /^[a-z0-9_]+$/ },
  },
};

// 2. Register
const db = new JSQL();
db.use(validation);

// 3. Invalid writes throw before touching storage
db.insert("users", { email: "not-an-email", age: 200, role: "root" });
// Error: [validation] users.email: expected email, got string

// Valid writes pass through
db.insert("users", { email: "alice@example.com", age: 25, role: "user" });
```

## Rule reference

| Rule | Applies to | Description |
| --- | --- | --- |
| `required` | insert | Reject missing / null values (ignored on partial updates) |
| `type` | all | `string` \| `number` \| `integer` \| `boolean` \| `array` \| `object` \| `email` \| `url` \| `uuid` |
| `minLength` / `maxLength` | string, array | Length bounds |
| `min` / `max` | number | Numeric range |
| `enum` | all | Whitelist of allowed values |
| `pattern` | all | `RegExp` or string, tested against `String(value)` |
| `custom` | all | `(value, row) => true \| "error message"` for cross-field rules |
| `message` | all | Override the default error message |

## Cross-field example

```javascript
validation.rules = {
  orders: {
    endDate: {
      custom: (value, row) => value > row.startDate || "endDate must be after startDate",
    },
  },
};
```

Note: on updates, `custom` receives the update payload, not the merged row — read the existing row first if the rule needs it.

## Programmatic API

```javascript
// via the engine plugin API
db.plugin("validation").setRules("users", { age: { min: 0 } });
db.plugin("validation").addRule("users", "email", { type: "email" });
db.plugin("validation").validate("users", { email: "bad" }); // throws

// or directly on the plugin object
validation.rules.users.age = { min: 0, max: 150 };
```

## Errors

Validation failures throw an `Error` with:

- `code = "ER_VALIDATION_FAILED"`
- `table`, `field`, `rule` — the failing location
- message: `[validation] <table>.<field>: <detail>`

Because validation runs before the write, a failed insert or update aborts entirely — no partial or corrupt rows.

## How interception works (and why there are two mechanisms)

The plugin validates through **both** of the following:

1. `beforeInsert` / `beforeUpdate` hooks — the canonical plugin mechanism.
2. A synchronous pre-validation wrapper installed around the engine's write methods (`insert` / `insertMany` / `updateById` / `updateByIds` / `update`) in `install()`.

Reason: on the current engine (6.3.x) the hook *abort* semantics are broken — `runHooks()` in `lib/plugin.js` is `async`, but the engines' insert/update methods never `await` it, so both `return false` and `throw` from a hook are swallowed (the write proceeds regardless; a thrown error only escapes as an unhandled rejection). The wrapper guarantees the abort actually takes effect on every engine today. Once the engine awaits hook results, the wrapper becomes redundant but harmless — the hook re-validates with the same rules.

Verified against the real engine: 48 assertions across the pure-JS `Database` and `NativeJSQL` engines (valid/invalid rows, batch atomicity, single/batch updates, partial-update semantics, dynamic rules, data consistency).
