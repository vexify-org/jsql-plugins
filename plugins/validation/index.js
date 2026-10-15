/**
 * JSQL Validation Plugin
 *
 * 声明式输入校验插件——补齐 schema 约束之外的常用规则：
 *   - 字符串/数组长度（minLength / maxLength）
 *   - 正则匹配（pattern，支持 RegExp 或字符串）
 *   - 枚举白名单（enum）
 *   - 数字区间（min / max，引擎 schema 已含，此处便于插件侧统一配置）
 *   - 跨字段自定义规则（custom(value, row) => true | '错误信息'）
 *
 * 引擎已内置：required / primaryKey / unique / check / 数字 min-max。
 * 本插件不重复造轮子，只覆盖引擎表达不了的部分，且零依赖。
 *
 * 支持全部引擎（Native / WASM / Pure JS）。
 *
 * ⚠️ 关于拦截机制的双保险设计：
 *   插件同时使用两条拦截路径——
 *   1) beforeInsert / beforeUpdate 钩子（规范机制）；
 *   2) install() 时对引擎写入方法（insert / insertMany / updateById /
 *      updateByIds / update）的同步预校验包装。
 *   原因：当前引擎的钩子“中止”语义失效——plugin.js 的 runHooks 为 async，
 *   而各引擎的 insert/update 均未 await 其返回值，导致钩子 return false
 *   与 throw 都被吞掉（错误仅以 unhandledRejection 形式逃逸，写入照常发生）。
 *   引擎修复该缺陷后，包装变为冗余但无害（钩子会以相同规则二次校验）。
 */

/** 内置类型检查器 */
const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  url: (v) => typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v),
  uuid: (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
};

/** 构造带上下文的校验错误 */
function fail(table, field, rule, detail) {
  const err = new Error(`[validation] ${table}.${field}: ${detail}`);
  err.code = 'ER_VALIDATION_FAILED';
  err.table = table;
  err.field = field;
  err.rule = rule;
  throw err;
}

/**
 * 校验单个字段值
 * @param {string} table 表名（错误信息用）
 * @param {string} field 字段名（错误信息用）
 * @param {object} rule  规则对象
 * @param {*} value      字段值（undefined 表示未提供）
 * @param {object} row   所在行（跨字段 custom 规则用）
 * @param {boolean} isUpdate 是否处于更新路径（更新为部分字段，语义不同）
 */
function checkValue(table, field, rule, value, row, isUpdate) {
  // 未提供的值：插入路径按 required 处理；更新路径跳过（局部更新本就允许缺字段）
  if (value === undefined || value === null) {
    if (!isUpdate && rule.required) {
      fail(table, field, 'required', rule.message || 'is required');
    }
    return;
  }

  // 类型
  if (rule.type) {
    const check = TYPE_CHECKS[rule.type];
    if (check && !check(value)) {
      fail(table, field, 'type', rule.message || `expected ${rule.type}, got ${typeof value}`);
    }
  }

  // 字符串 / 数组长度
  if (typeof value === 'string' || Array.isArray(value)) {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      fail(table, field, 'minLength', rule.message || `length ${value.length} < minLength ${rule.minLength}`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      fail(table, field, 'maxLength', rule.message || `length ${value.length} > maxLength ${rule.maxLength}`);
    }
  }

  // 数字区间
  if (typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      fail(table, field, 'min', rule.message || `${value} < min ${rule.min}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      fail(table, field, 'max', rule.message || `${value} > max ${rule.max}`);
    }
  }

  // 枚举白名单
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    fail(table, field, 'enum', rule.message || `must be one of [${rule.enum.join(', ')}], got ${JSON.stringify(value)}`);
  }

  // 正则（RegExp 或字符串）
  if (rule.pattern) {
    const re = rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern);
    if (!re.test(String(value))) {
      fail(table, field, 'pattern', rule.message || `does not match ${re}`);
    }
  }

  // 跨字段自定义规则：返回 true 通过；返回字符串视为错误信息
  if (typeof rule.custom === 'function') {
    const result = rule.custom(value, row);
    if (result !== true) {
      fail(table, field, 'custom', result || rule.message || 'failed custom rule');
    }
  }
}

/** 校验整行 */
function validateRow(table, row, rules, isUpdate) {
  if (!row || typeof row !== 'object') return;
  for (const [field, rule] of Object.entries(rules)) {
    checkValue(table, field, rule, row[field], row, isUpdate);
  }
}

/** 校验一批行（插入路径） */
function validateBatch(table, data, rules) {
  const list = Array.isArray(data) ? data : [data];
  for (const row of list) validateRow(table, row, rules, false);
}

/** 取某表的规则；无规则返回 null */
function rulesOf(table) {
  return plugin.rules[table] || null;
}

const plugin = {
  name: 'validation',
  version: '1.0.0',
  description: 'Declarative input validation: length / pattern / enum / range / cross-field rules',

  /** 规则表：{ 表名: { 字段名: 规则 } }，use() 之前或经 api 动态修改 */
  rules: {},

  install(engine, ctx) {
    // 保留引擎引用，便于后续扩展（如按 schema 自动生成规则）
    plugin._engine = engine;

    // —— 同步预校验包装（详见文件头“双保险设计”说明）——
    // 逐个包装引擎写入方法；链式友好：若其它插件已包装过，此处包装其外层。
    const wrap = (name, validator) => {
      const orig = engine[name];
      if (typeof orig !== 'function') return;
      engine[name] = function wrapped(...args) {
        validator(...args);
        return orig.apply(engine, args);
      };
    };

    wrap('insert', (table, data) => {
      const rules = rulesOf(table);
      if (rules) validateBatch(table, data, rules);
    });
    wrap('insertMany', (table, items) => {
      const rules = rulesOf(table);
      if (rules) validateBatch(table, items, rules);
    });
    wrap('updateById', (table, _id, data) => {
      const rules = rulesOf(table);
      if (rules) validateRow(table, data, rules, true);
    });
    wrap('updateByIds', (table, entries) => {
      const rules = rulesOf(table);
      if (!rules || !Array.isArray(entries)) return;
      for (const [, data] of entries) validateRow(table, data, rules, true);
    });
    wrap('update', (table, _query, updates) => {
      const rules = rulesOf(table);
      if (rules) validateRow(table, updates, rules, true);
    });
  },

  /** 对外暴露的可编程接口：db.plugin('validation').setRules(...) */
  api: {
    setRules(table, rules) {
      plugin.rules[table] = rules;
      return plugin.rules;
    },
    addRule(table, field, rule) {
      if (!plugin.rules[table]) plugin.rules[table] = {};
      plugin.rules[table][field] = rule;
      return plugin.rules[table];
    },
    getRules() {
      return plugin.rules;
    },
    /** 手动校验一行（不经过钩子），通过返回 true，失败抛 Error */
    validate(table, row) {
      validateRow(table, row, plugin.rules[table] || {}, false);
      return true;
    },
  },

  hooks: {
    /**
     * 插入前校验。engine 调用形态恒为行数组：
     *   insert / insertMany → beforeInsert(tableName, rows[])
     */
    beforeInsert(table, rows) {
      const rules = rulesOf(table);
      if (!rules) return;
      validateBatch(table, rows, rules);
    },

    /**
     * 更新前校验。engine 有三种调用形态：
     *   updateById  → beforeUpdate(tableName, id, data)
     *   updateByIds → beforeUpdate(tableName, [[id, data], ...])
     *   update      → beforeUpdate(tableName, query, updates)
     * 更新是部分字段，故忽略 required；缺失字段直接跳过。
     */
    beforeUpdate(table, a, b) {
      const rules = rulesOf(table);
      if (!rules) return;
      if (Array.isArray(a)) {
        for (const [, data] of a) validateRow(table, data, rules, true);
      } else {
        validateRow(table, b, rules, true);
      }
    },
  },
};

module.exports = plugin;
