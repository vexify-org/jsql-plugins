# crypt — 透明列加密插件

对指定列做**写入加密、读取解密**的透明加解密：应用层照常读写明文，落库全程密文。AES-256-GCM，零依赖，仅用 Node 内置 `crypto`。

## 快速开始

```js
const { Database } = require('jsql-neo');
const crypt = require('./plugins/crypt');

const db = new Database('./mydata');
db.use(crypt.configure({
  key: 'your-high-entropy-passphrase',   // 必填：口令（scrypt 派生 256 位密钥）
  tables: {
    users: ['ssn', 'id_card'],           // 按表配置加密列
  },
  columns: ['secret'],                   // 全局加密列（对所有表生效，与 tables 合并）
}));

await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, ssn TEXT, id_card TEXT)');
await db.insert('users', { name: 'alice', ssn: '123-45-6789', id_card: 'ABC123' });

// 读出来是明文，应用层无感
const rows = await db.find('users');
// → [{ id: 1, name: 'alice', ssn: '123-45-6789', id_card: 'ABC123' }]

// 落库的是密文
const cryptApi = db.plugin('crypt');
console.log(cryptApi.isEncrypted(rows[0].ssn)); // false（读取路径已解密）
cryptApi.stats(); // { writes: 2, reads: 0, errors: 0, skipped: 0, configured: 3 }
```

SQL 路径同样透明：

```js
await db.query("INSERT INTO users (name, ssn) VALUES ('bob', '999-88-7777')");
const r = await db.query('SELECT name, ssn FROM users');
// r.raw → [{ name: 'bob', ssn: '999-88-7777' }]（已解密）
// r.rows → [['bob', '999-88-7777']]
```

## 配置项

| 项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `key` | string | `null` | **必填**。口令，经 scrypt(salt) 派生 256 位密钥。无密钥时插件空转并告警 |
| `tables` | object | `{}` | `{ 表名: [列名, ...] }`，每张表的加密列 |
| `columns` | string[] | `[]` | 全局加密列，与 `tables` 合并生效 |
| `salt` | string | `'jsql:crypt:v1'` | scrypt 盐值。生产环境建议改为独立盐值 |
| `strict` | boolean | `false` | `true` 时 schema 声明为非文本的加密列直接抛错；`false` 跳过并告警（该列保持明文） |

配置可在 `use()` 前设置，也可运行时经 `db.plugin('crypt').configure({ ... })` 动态修改。

## API（`db.plugin('crypt')`）

| 方法 | 说明 |
|---|---|
| `stats()` | `{ writes, reads, errors, skipped, configured }` 计数器 |
| `fields(table?)` | 某表（或全部表）的加密列清单 |
| `isEncrypted(value)` | 值是否已是本插件密文 |
| `encrypt(value)` / `decrypt(stored)` | 单值手工加解密（迁移、对账场景） |
| `configure(opts)` | 动态修改配置 |
| `config()` | 当前生效配置（不含密钥本体） |

## 加密格式

```
enc:v1:<iv-24hex>:<tag-32hex>:<ciphertext-hex>
```

- AES-256-GCM，96 bit 随机 IV，128 bit 认证标签——**篡改会被 GCM 检测到**，不会静默解密出错误明文
- 明文先 JSON 序列化再加密，因此 `number` / `boolean` / `null` / 对象均可**保持类型**
- 自描述前缀便于版本迁移；已是 `enc:v1:` 的值自动跳过（幂等，WAL 回放不会双重加密）

## 覆盖范围

| 路径 | 钩子 | 状态 |
|---|---|---|
| `insert` | `beforeInsert` | ✅ |
| `updateById` / `updateByIds` / `update` | `beforeUpdate` | ✅ |
| `find` / `findById` / `findByIds` | `afterFind` | ✅ |
| SQL `SELECT` | `afterQuery`（raw 行对象 + rows 值数组双表示） | ✅ |

## 已知限制（v1.0.0）

1. **加密列必须是 TEXT**：schema 声明为 `number` / `integer` 等非文本列时，默认跳过加密并告警（加密值会是字符串，会破坏引擎类型约束），`strict: true` 时改为抛错。
2. **加密列不能直接用于 `WHERE` / `ORDER BY` / `JOIN ... ON`**：密文无序且不保留明文特征。需要按加密列查询时，请在应用层解密后过滤，或对该列保持明文。
3. **解密失败不崩溃**：密钥错误或数据被篡改时保留原密文、`stats.errors` 计数、首次失败告警一次。
4. **SQL 解密按 `result.table` + 列名匹配**：多表 JOIN 出现同名列时，以结果表（首个表）的配置为准。
5. **密钥即数据**：丢失 `key` = 永久丢失数据。请像对待数据库密码一样管理它，并考虑备份策略。

## 安全说明

- 本插件保护的是**静态数据**（at-rest）：数据文件泄露时，没有密钥无法读出明文。
- 口令请使用高熵值（≥ 16 位随机字符或由 KMS 派生）；低熵口令可被暴力破解。
- 插件不改变引擎的任何行为，只做值的原地替换；不引入新的引擎调用，无重入风险。
- 授权协议：MIT。
