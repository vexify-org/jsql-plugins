/**
 * JSQL Metrics Plugin — 查询性能分析
 *
 * 通过 beforeQuery / afterQuery 钩子统计每条 SQL 的耗时，按归一化模式聚合，
 * 暴露 stats() / slow() / reset() 接口（db.plugin('metrics') 取出）。
 *
 * 设计原则：
 *   1. 只读观测——钩子从不返回 false，从不修改任何入参，零引擎行为干预；
 *   2. 并发安全——进行中的计时按 (SQL, 参数) 存 Map，不用全局单变量；
 *   3. 零依赖——纯标准库，Native / WASM / Pure JS 三引擎通用。
 *
 * 配置（任选其一）：
 *   metrics.config = { slowMs: 50 };        // 静态配置，use() 之前设置
 *   const m = db.plugin('metrics'); m.setSlowMs(50);   // 运行期调整
 *
 * 已知边界：若 executeSQL 抛异常，afterQuery 不触发，该次计时残留于
 * inflight Map（有上限保护，不会无限增长；reset() 可手动清理）。
 */

'use strict';

var DEFAULT_SLOW_MS = 100;
var MAX_SLOW_ENTRIES = 100;
var MAX_INFLIGHT_PER_KEY = 32;

/** 归一化 SQL：掩码字符串字面量与数字，把同类查询聚成一个模式 */
function normalizeSql(sql) {
  if (typeof sql !== 'string') return String(sql);
  return sql
    .replace(/'[^']*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 构造进行中计时的键：SQL 文本 + 参数序列化 */
function sqlKey(sql, params) {
  var p = '';
  if (params !== undefined && params !== null) {
    try { p = JSON.stringify(params); } catch (err) { p = '[unserializable]'; }
  }
  return (typeof sql === 'string' ? sql : String(sql)) + '\u0000' + p;
}

var inflight = new Map();  // key -> [startMs, ...]（同键并发按 FIFO 配对）
var patterns = new Map();  // pattern -> { pattern, count, totalMs, maxMs, lastMs }
var slowLog = [];          // [{ sql, ms, at }]（环形，上限 MAX_SLOW_ENTRIES）
var slowMs = DEFAULT_SLOW_MS;

function aggregate(pattern, ms) {
  var p = patterns.get(pattern);
  if (!p) {
    p = { pattern: pattern, count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    patterns.set(pattern, p);
  }
  p.count += 1;
  p.totalMs += ms;
  p.lastMs = ms;
  if (ms > p.maxMs) p.maxMs = ms;
  return p;
}

module.exports = {
  name: 'metrics',
  version: '1.0.0',

  hooks: {
    beforeQuery: function (sql, params, opts) {
      var key = sqlKey(sql, params);
      var starts = inflight.get(key) || [];
      starts.push(Date.now());
      if (starts.length > MAX_INFLIGHT_PER_KEY) starts.shift();
      inflight.set(key, starts);
      // 故意不返回 false：观测插件不拦截查询
    },

    afterQuery: function (sql, params, opts, result) {
      var key = sqlKey(sql, params);
      var starts = inflight.get(key);
      if (!starts || starts.length === 0) return;
      var t0 = starts.shift();
      if (starts.length === 0) inflight.delete(key);

      var ms = Date.now() - t0;
      aggregate(normalizeSql(sql), ms);

      if (ms >= slowMs) {
        slowLog.push({ sql: sql, ms: ms, at: new Date().toISOString() });
        if (slowLog.length > MAX_SLOW_ENTRIES) slowLog.shift();
      }
    }
  },

  install: function (engine, ctx) {
    if (ctx && ctx.config && typeof ctx.config.slowMs === 'number' && ctx.config.slowMs > 0) {
      slowMs = ctx.config.slowMs;
    }
  },

  /** 插件对外 API：db.plugin('metrics') 取出 */
  api: {
    /** 全量统计（按总耗时降序）；avgMs 为派生字段 */
    stats: function () {
      return Array.from(patterns.values())
        .map(function (p) {
          return {
            pattern: p.pattern,
            count: p.count,
            totalMs: p.totalMs,
            avgMs: p.count > 0 ? Math.round((p.totalMs / p.count) * 100) / 100 : 0,
            maxMs: p.maxMs,
            lastMs: p.lastMs
          };
        })
        .sort(function (a, b) { return b.totalMs - a.totalMs; });
    },

    /** 慢查询列表（>= 当前阈值） */
    slow: function () { return slowLog.slice(); },

    /** 当前慢查询阈值（毫秒） */
    slowMs: function () { return slowMs; },

    /** 运行期调整慢查询阈值 */
    setSlowMs: function (v) {
      if (typeof v === 'number' && v > 0) slowMs = v;
      return slowMs;
    },

    /** 清空全部统计与残留计时 */
    reset: function () {
      inflight.clear();
      patterns.clear();
      slowLog.length = 0;
    }
  }
};
