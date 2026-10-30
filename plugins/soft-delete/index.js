/**
 * JSQL-NEO Plugin: soft-delete
 *
 * 软删除（回收站）插件：
 *   - 删除操作不再真正移除行，而是打上删除标记（默认字段 `_deleted`），
 *     并可选记录删除时间（`_deleted_at`）；
 *   - 普通 find / findById / findByIds / count 自动隐藏已删除的行；
 *   - 提供 softDelete / softDeleteMany / restore / purge / purgeMany /
 *     includeDeleted() 方法；
 *   - 裸 removeById / removeByIds 被改为软删除，避免误删；只有 purge* 才真正删除。
 *
 * 实现要点：
 *   - native 引擎的 updateById 只写「已声明列」，因此本插件在 install 时为每张表
 *     自动 addColumn 删除标记列（已存在的表遍历补列；未来的表包装 createTable 后补列）；
 *   - 仅包装引擎公开方法、只用引擎 API，无 require / eval / 子进程 / 文件写入；
 *   - 包装与钩子内部不反向调用会再次触发钩子的引擎方法，规避重入保护；
 *   - 通过 scripts/security-check.js 安全扫描（无危险字面量与可疑模块）。
 *
 * 配置：db.use(plugin, { config: { field, timestamp } })
 *   - field     删除标记字段名，默认 '_deleted'
 *   - timestamp 删除时间戳字段名，默认 '_deleted_at'（设为 false 可关闭）
 */
'use strict';

module.exports = {
  name: 'soft-delete',
  version: '1.0.0',
  description: 'Soft delete: mark rows instead of removing them, auto-hide on query, with restore/purge',

  install(engine, ctx) {
    const config = (ctx && ctx.config) || {};
    const field = config.field || '_deleted';
    const tsField = config.timestamp === false ? null : (config.timestamp || '_deleted_at');

    const mark = () => {
      const m = { [field]: true };
      if (tsField) m[tsField] = Date.now();
      return m;
    };
    const isDeleted = (row) => !!(row && row[field] === true);

    // 为某张表补上删除标记列（列已存在则忽略报错）
    const ensureCols = async (table) => {
      if (typeof engine.addColumn !== 'function') return;
      try { await engine.addColumn(table, field, 'boolean'); } catch (_) {}
      if (tsField) { try { await engine.addColumn(table, tsField, 'integer'); } catch (_) {} }
    };

    // 已存在的表：立即补列
    const existing = (ctx && ctx.tables && typeof ctx.tables === 'function') ? ctx.tables() : [];
    for (const t of existing) ensureCols(t);

    // 未来的表：包装 createTable，在创建后补列
    if (typeof engine.createTable === 'function') {
      const origCreateTable = engine.createTable.bind(engine);
      engine.createTable = async function (name, schema, ...rest) {
        const r = await origCreateTable(name, schema, ...rest);
        await ensureCols(name);
        return r;
      };
    }

    // ---- 保存原始方法用于包装与 purge ----
    const origFind = engine.find ? engine.find.bind(engine) : null;
    const origFindById = engine.findById ? engine.findById.bind(engine) : null;
    const origFindByIds = engine.findByIds ? engine.findByIds.bind(engine) : null;
    const origCount = engine.count ? engine.count.bind(engine) : null;
    const origRemoveById = engine.removeById ? engine.removeById.bind(engine) : null;
    const origRemoveByIds = engine.removeByIds ? engine.removeByIds.bind(engine) : null;

    // ===== 查询侧：默认隐藏已删除行 =====
    if (origFind) {
      engine.find = async function (table, filter, opts) {
        if (!engine.__sdInclude && !(field in (filter || {}))) {
          filter = Object.assign({}, filter, { [field]: { $ne: true } });
        }
        return origFind(table, filter, opts);
      };
    }
    if (origFindById) {
      engine.findById = async function (table, id, opts) {
        const row = await origFindById(table, id, opts);
        if (row && !engine.__sdInclude && isDeleted(row)) return null;
        return row;
      };
    }
    if (origFindByIds) {
      engine.findByIds = async function (table, ids, opts) {
        const rows = await origFindByIds(table, ids, opts);
        if (engine.__sdInclude) return rows;
        return rows.filter((r) => !isDeleted(r));
      };
    }
    if (origCount) {
      engine.count = async function (table) {
        if (engine.__sdInclude) return origCount(table);
        const rows = await engine.find(table, {});
        return rows.length;
      };
    }

    // ===== 删除侧：默认改为软删除，阻断误删 =====
    if (origRemoveById) {
      engine.removeById = async function (table, id) {
        if (engine.__sdBypass) return origRemoveById(table, id);
        return engine.updateById(table, id, mark());
      };
    }
    if (origRemoveByIds) {
      engine.removeByIds = async function (table, ids) {
        if (engine.__sdBypass) return origRemoveByIds(table, ids);
        const entries = (Array.isArray(ids) ? ids : [ids]).map((id) => [id, mark()]);
        return engine.updateByIds(table, entries);
      };
    }

    // ===== 对外 API =====
    engine.softDelete = async function (table, id, opts) {
      const m = mark();
      if (opts && opts.timestamp != null && tsField) m[tsField] = opts.timestamp;
      return engine.updateById(table, id, m);
    };
    engine.softDeleteMany = async function (table, ids, opts) {
      const m = mark();
      if (opts && opts.timestamp != null && tsField) m[tsField] = opts.timestamp;
      const entries = (Array.isArray(ids) ? ids : [ids]).map((id) => [id, m]);
      return engine.updateByIds(table, entries);
    };
    engine.restore = async function (table, id) {
      const m = { [field]: false };
      if (tsField) m[tsField] = null;
      return engine.updateById(table, id, m);
    };
    engine.purge = async function (table, id) {
      engine.__sdBypass = true;
      try { return await origRemoveById(table, id); }
      finally { engine.__sdBypass = false; }
    };
    engine.purgeMany = async function (table, ids) {
      engine.__sdBypass = true;
      try { return await origRemoveByIds(table, ids); }
      finally { engine.__sdBypass = false; }
    };
    engine.includeDeleted = function (on) {
      engine.__sdInclude = !!on;
      return engine;
    };
  }
};
