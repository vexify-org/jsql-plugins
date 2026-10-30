# soft-delete

JSQL-NEO 软删除（回收站）插件。删除不再真正移除行，而是打上删除标记并默认在查询中隐藏，支持恢复与彻底清除。

## 安装

```js
const { JSQL } = require('jsql-neo');
const softDelete = require('jsql-neo/plugins/soft-delete'); // 或来自 registry

const db = new JSQL();
await db.start();
db.use(softDelete); // 默认字段 _deleted / _deleted_at
```

## 行为

- `find` / `findById` / `findByIds` / `count` 自动隐藏已删除行（`_deleted: true`）。
- 裸 `removeById` / `removeByIds` 被改为软删除，防止误删。
- 可配置删除标记字段与时间戳字段。

## API

| 方法 | 说明 |
|------|------|
| `db.softDelete(table, id, opts?)` | 软删除单行 |
| `db.softDeleteMany(table, ids, opts?)` | 批量软删除 |
| `db.restore(table, id)` | 恢复已删除行 |
| `db.purge(table, id)` | 真正删除单行（绕过保护） |
| `db.purgeMany(table, ids)` | 真正删除多行（绕过保护） |
| `db.includeDeleted(true|false)` | 切换是否包含已删除行（审计/恢复场景） |

## 示例

```js
await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });
await db.insert('users', [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Cara' }]);

await db.softDelete('users', 2);          // 软删 Bob
await db.find('users', {});               // 只剩 Alice, Cara
await db.findById('users', 2);            // null

await db.restore('users', 2);             // 恢复
await db.includeDeleted(true);            // 审计模式
await db.find('users', {});               // 含已删除
await db.includeDeleted(false);

await db.purge('users', 1);               // 真正删除 Alice
```

## 配置

```js
db.use(softDelete, { config: { field: 'deleted', timestamp: 'deleted_at' } });
```

## 安全

插件零 `require`、无 `eval` / 子进程 / 文件写入，通过 `scripts/security-check.js` 扫描。
