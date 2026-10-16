/**
 * JSQL Crypt Plugin — 透明列加密（AES-256-GCM）
 *
 * 对指定列做“写入加密、读取解密”的透明加解密：
 *   - beforeInsert / beforeUpdate  钩子把配置列的明文替换为密文
 *   - afterFind                    钩子把 find / findById / findByIds 的密文还原为明文
 *   - afterQuery                   钩子还原 SQL SELECT 结果（raw 行对象 + rows 值数组双表示）
 *
 * 设计约束（来自引擎钩子契约，见 lib/plugin.js）：
 *   - 钩子只能“原地修改传入的数组/对象”或“返回 false 中止”，不能替换返回值；
 *     因此本插件全部通过原地修改实现，不依赖任何返回值语义。
 *   - 钩子内不调用任何引擎方法（native 引擎有 ER_PLUGIN_REENTRY 保护），
 *     插件只在 install() 时保存引擎引用用于 schema 查询。
 *
 * 加密格式（自描述，便于版本迁移）：
 *   enc:v1:<iv-24hex>:<tag-32hex>:<ciphertext-hex>
 *   - AES-256-GCM，96 bit 随机 IV，128 bit 认证标签（防篡改）
 *   - 明文中先做 JSON 序列化再加密，因此 number / boolean / null / 对象均可保持类型
 *   - 已是 enc:v1: 前缀的值跳过（幂等，回放 WAL 不会双重加密）
 *
 * 密钥：config.key 作为口令，经 scrypt(salt) 派生 256 位密钥。
 *   口令请使用高熵值；生产环境建议通过 config.salt 使用独立盐值。
 *
 * 已知限制（v1.0.0，诚实清单）：
 *   - 加密列必须为 TEXT 类型：schema 声明为 number/integer 等非文本列时，
 *     默认跳过加密并告警（避免破坏引擎类型约束），config.strict=true 时改为抛错。
 *   - 加密列无法直接用于 WHERE / ORDER BY 等 SQL 条件（密文无序且不保留明文），
 *     需要在应用层先解密再过滤，或对该列保持明文。
 *   - 解密失败（密钥错误/数据被篡改）时不崩溃：保留原密文，stats.errors 计数，
 *     首次失败时告警一次。GCM 认证标签保证篡改不会被静默解密成错误明文。
 *   - SQL SELECT 的解密按 result.table + 列名匹配；JOIN 产生的同名列会一并处理，
 *     多表存在同名列且分属不同配置时，以结果表（首个表）的配置为准。
 *
 * 零依赖，仅使用 Node 内置 crypto。支持全部引擎（Native / WASM / Pure JS）。
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const IV_HEX_LEN = 24;   // 12 bytes
const TAG_HEX_LEN = 32;  // 16 bytes
const TEXT_TYPES = ['string', 'text', 'varchar', 'char'];

/** hex 字符串 → Buffer */
function hexToBuf(hex) {
  const buf = Buffer.alloc(hex.length / 2);
  buf.write(hex, 0, 'hex');
  return buf;
}

const plugin = {
  name: 'crypt',
  version: '1.0.0',
  description: 'Transparent column encryption (AES-256-GCM): encrypt on write, decrypt on read, type-preserving',

  /**
   * 配置。use() 之前设置，或经 api.configure() 动态修改：
   *   key     {string}  口令（必填，无密钥时插件空转并告警一次）
   *   tables  {object}  { 表名: [列名, ...] } 每张表的加密列
   *   columns {string[]} 全局加密列（对所有表生效，与 tables 合并）
   *   salt    {string}  scrypt 盐值，默认 'jsql:crypt:v1'
   *   strict  {boolean} true 时 schema 类型不匹配直接抛错而非跳过
   */
  config: {
    key: null,
    tables: {},
    columns: [],
    salt: 'jsql:crypt:v1',
    strict: false,
  },

  hooks: {
    /** 引擎启动后打印配置摘要 */
    onStart() {
      const cfg = plugin.config;
      if (!cfg.key) {
        console.warn('[jsql:crypt] 未配置 key，插件空转。请设置 config.key 或调用 api.configure({ key })');
        return;
      }
      const tableCount = Object.keys(cfg.tables || {}).length;
      const globalCount = (cfg.columns || []).length;
      console.log(`[jsql:crypt] 透明列加密已启用：${tableCount} 张表按表配置，${globalCount} 个全局列`);
    },

    /** 插入前加密：arr 为待插入行对象数组，原地修改 */
    beforeInsert(table, arr) {
      if (!Array.isArray(arr)) return;
      for (const row of arr) encryptRow(table, row);
    },

    /**
     * 更新前加密。引擎有三种调用形态，统一遍历参数对象：
     *   updateById  → beforeUpdate(table, id, data)
     *   updateByIds → beforeUpdate(table, [[id, data], ...])
     *   update      → beforeUpdate(table, query, updates)
     */
    beforeUpdate(table, ...rest) {
      for (const arg of rest) {
        if (Array.isArray(arg)) {
          for (const item of arg) {
            if (Array.isArray(item)) encryptRow(table, item[1]);
            else if (item && typeof item === 'object') encryptRow(table, item);
          }
        } else if (arg && typeof arg === 'object') {
          encryptRow(table, arg);
        }
      }
    },

    /**
     * 读取后解密。三种形态：
     *   find       → afterFind(table, { filter, opts }, rows[])   rows 为行对象数组
     *   findById   → afterFind(table, { id }, row|null)           row 为单个行对象
     *   findByIds  → afterFind(table, { ids }, rows[])            rows 为行对象数组
     */
    afterFind(table, _meta, data) {
      if (Array.isArray(data)) {
        for (const row of data) decryptRow(table, row);
      } else if (data && typeof data === 'object') {
        decryptRow(table, data);
      }
    },

    /** SQL 读取后解密：result = { type:'select', table, columns[], rows[[]], raw[{}] } */
    afterQuery(_sql, _params, _opts, result) {
      decryptResult(result);
    },
  },

  /** 对外 API：经 db.plugin('crypt') 获取 */
  api: {
    /** 统计：{ writes, reads, errors, skipped, configured } */
    stats() {
      return {
        writes: state.stats.writes,
        reads: state.stats.reads,
        errors: state.stats.errors,
        skipped: state.stats.skipped,
        configured: configuredColumnCount(),
      };
    },

    /** 某表（或全部）的加密列清单 */
    fields(table) {
      if (table) return Array.from(columnsFor(table));
      const all = new Set();
      for (const t of Object.keys(plugin.config.tables || {})) {
        for (const c of columnsFor(t)) all.add(c);
      }
      for (const c of plugin.config.columns || []) all.add(c);
      return Array.from(all);
    },

    /** 值是否已是本插件密文 */
    isEncrypted(value) {
      return typeof value === 'string' && value.indexOf(PREFIX) === 0;
    },

    /** 手工加密单个值（用于迁移/对账） */
    encrypt(value) {
      const key = currentKey();
      if (!key) throw new Error('crypt: key not configured');
      return encryptWithKey(key, JSON.stringify(value));
    },

    /** 手工解密单个值；失败时原样返回 */
    decrypt(stored) {
      const key = currentKey();
      if (!key) return stored;
      const out = decryptWithKey(key, stored);
      return out.ok ? out.value : stored;
    },

    /** 动态修改配置（use() 之后同样生效） */
    configure(opts) {
      Object.assign(plugin.config, opts || {});
      return plugin.config;
    },

    /** 当前生效配置（不含密钥本体） */
    config() {
      return {
        tables: plugin.config.tables || {},
        columns: plugin.config.columns || [],
        strict: !!plugin.config.strict,
        salt: plugin.config.salt,
      };
    },
  },

  /** 保存引擎引用（仅用于 schema 查询；钩子内不调用引擎方法） */
  install(engine, _ctx) {
    plugin._engine = engine;
  },

  /** 链式配置：crypt.configure({ key, tables }) → plugin */
  configure(opts) {
    Object.assign(plugin.config, opts || {});
    return plugin;
  },
};

// ─── 内部状态 ─────────────────────────────────────────────

const state = {
  stats: { writes: 0, reads: 0, errors: 0, skipped: 0 },
  warned: new Set(),
  keyCache: { input: null, key: null },
};

/** 派生（并缓存）256 位密钥；无 key 时返回 null */
function currentKey() {
  const cfg = plugin.config;
  if (!cfg.key) return null;
  const input = String(cfg.key) + '|' + String(cfg.salt || 'jsql:crypt:v1');
  if (state.keyCache.input !== input) {
    state.keyCache = {
      input,
      key: crypto.scryptSync(String(cfg.key), String(cfg.salt || 'jsql:crypt:v1'), 32),
    };
  }
  return state.keyCache.key;
}

/** 某表的加密列集合（tables 按表配置 + columns 全局配置） */
function columnsFor(table) {
  const set = new Set();
  const perTable = plugin.config.tables && plugin.config.tables[table];
  if (Array.isArray(perTable)) for (const c of perTable) set.add(c);
  if (Array.isArray(plugin.config.columns)) for (const c of plugin.config.columns) set.add(c);
  return set;
}

function configuredColumnCount() {
  const all = new Set();
  for (const t of Object.keys(plugin.config.tables || {})) {
    for (const c of columnsFor(t)) all.add(c);
  }
  for (const c of plugin.config.columns || []) all.add(c);
  return all.size;
}

/** 同一告警只打一次 */
function warnOnce(tag, message) {
  if (state.warned.has(tag)) return;
  state.warned.add(tag);
  console.warn(`[jsql:crypt] ${message}`);
}

// ─── schema 查询（多形态兼容） ─────────────────────────────

/** 取某列声明的类型；取不到返回 null（视为未知，不拦截） */
function schemaTypeOf(table, column) {
  const engine = plugin._engine;
  if (!engine) return null;
  let schema = null;
  if (engine._schemas && engine._schemas[table]) schema = engine._schemas[table];
  else if (typeof engine.getTableSchema === 'function') {
    try { schema = engine.getTableSchema(table); } catch { /* ignore */ }
  }
  if (!schema) return null;
  let col = null;
  if (schema.columns && !Array.isArray(schema.columns) && schema.columns[column]) {
    col = schema.columns[column];
  } else if (Array.isArray(schema.columns)) {
    col = schema.columns.find(c => c && (c.name === column || c.column === column)) || null;
  } else if (schema[column]) {
    col = schema[column];
  }
  if (!col) return null;
  return col.type || null;
}

// ─── 加解密原语 ───────────────────────────────────────────

function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return PREFIX + iv.toString('hex') + ':' + tag + ':' + body;
}

/** @returns {{ok: boolean, value: *}} ok=false 表示非本插件格式或解密失败 */
function decryptWithKey(key, stored) {
  if (typeof stored !== 'string' || stored.indexOf(PREFIX) !== 0) {
    return { ok: false, value: stored };
  }
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return { ok: false, value: stored };
  const ivHex = parts[0];
  const tagHex = parts[1];
  const bodyHex = parts[2];
  if (ivHex.length !== IV_HEX_LEN || tagHex.length !== TAG_HEX_LEN || bodyHex.length % 2 !== 0) {
    return { ok: false, value: stored };
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, hexToBuf(ivHex));
    decipher.setAuthTag(hexToBuf(tagHex));
    const plain = decipher.update(bodyHex, 'hex', 'utf8') + decipher.final('utf8');
    return { ok: true, value: JSON.parse(plain) };
  } catch {
    return { ok: false, value: stored };
  }
}

// ─── 行级加解密 ───────────────────────────────────────────

/** 加密一行的配置列（原地修改） */
function encryptRow(table, row) {
  if (!row || typeof row !== 'object') return;
  const key = currentKey();
  if (!key) return; // 无密钥：onStart 已告警，此处静默跳过
  const cols = columnsFor(table);
  if (cols.size === 0) return;
  for (const col of cols) {
    if (!(col in row)) continue;
    const value = row[col];
    if (value === null || value === undefined) continue;
    if (plugin.api.isEncrypted(value)) continue; // 幂等：已是密文（如 WAL 回放）
    const type = schemaTypeOf(table, col);
    if (type && TEXT_TYPES.indexOf(type) === -1) {
      // 非文本列加密会变成字符串，破坏引擎 schema 类型约束
      if (plugin.config.strict) {
        throw new Error(`crypt: column ${table}.${col} declared as ${type}; encrypted columns must be TEXT (set config.strict=false to skip instead)`);
      }
      warnOnce(`skip:${table}.${col}`, `列 ${table}.${col} 声明为 ${type}，加密将变为字符串，已跳过（该列保持明文）；请改为 TEXT 类型或设置 config.strict=true`);
      state.stats.skipped++;
      continue;
    }
    row[col] = encryptWithKey(key, JSON.stringify(value));
    state.stats.writes++;
  }
}

/** 解密一行的配置列（原地修改） */
function decryptRow(table, row) {
  if (!row || typeof row !== 'object') return;
  const key = currentKey();
  if (!key) return;
  const cols = columnsFor(table);
  if (cols.size === 0) return;
  for (const col of cols) {
    if (!(col in row)) continue;
    const value = row[col];
    if (!plugin.api.isEncrypted(value)) continue;
    const out = decryptWithKey(key, value);
    if (out.ok) {
      row[col] = out.value;
      state.stats.reads++;
    } else {
      state.stats.errors++;
      warnOnce(`decrypt:${table}.${col}`, `列 ${table}.${col} 解密失败（密钥错误或数据被篡改），已保留密文`);
    }
  }
}

/** 解密 SQL SELECT 结果（原地修改 raw 行对象与 rows 值数组） */
function decryptResult(result) {
  if (!result || typeof result !== 'object') return;
  if (result.type !== 'select' || !result.table) return;
  const key = currentKey();
  if (!key) return;
  const cols = columnsFor(result.table);
  if (cols.size === 0) return;

  let counted = false;

  // raw：行对象数组（键可能带 "表." 限定前缀）
  if (Array.isArray(result.raw)) {
    for (const row of result.raw) {
      if (!row || typeof row !== 'object') continue;
      for (const rowKey of Object.keys(row)) {
        const base = rowKey.indexOf('.') >= 0 ? rowKey.slice(rowKey.lastIndexOf('.') + 1) : rowKey;
        if (!cols.has(base)) continue;
        const value = row[rowKey];
        if (!plugin.api.isEncrypted(value)) continue;
        const out = decryptWithKey(key, value);
        if (out.ok) { row[rowKey] = out.value; state.stats.reads++; counted = true; }
        else { state.stats.errors++; warnOnce(`decrypt:${result.table}.${base}`, `列 ${result.table}.${base} 解密失败（密钥错误或数据被篡改），已保留密文`); }
      }
    }
  }

  // rows：值数组，与 columns 按位置对齐（raw 缺失时作为唯一表示）
  if (Array.isArray(result.rows) && Array.isArray(result.columns) && (!counted || !Array.isArray(result.raw))) {
    const positions = [];
    result.columns.forEach((col, i) => {
      const name = String(col);
      const base = name.indexOf('.') >= 0 ? name.slice(name.lastIndexOf('.') + 1) : name;
      if (cols.has(base)) positions.push(i);
    });
    if (positions.length > 0) {
      for (const row of result.rows) {
        if (!Array.isArray(row)) continue;
        for (const i of positions) {
          const value = row[i];
          if (!plugin.api.isEncrypted(value)) continue;
          const out = decryptWithKey(key, value);
          if (out.ok) { row[i] = out.value; state.stats.reads++; }
          else { state.stats.errors++; warnOnce(`decrypt:${result.table}.${result.columns[i]}`, `列 ${result.table}.${result.columns[i]} 解密失败（密钥错误或数据被篡改），已保留密文`); }
        }
      }
    }
  }
}

module.exports = plugin;
