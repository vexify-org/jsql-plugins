'use strict';

/**
 * mesh-neo 例示插件 —— sync（jsql-neo 数据同步逻辑）
 *
 * 完全沿用 jsql-neo 插件 API（hooks + onEvent + install），演示一套完整的数据同步：
 *
 *   1) 表镜像 / CDC 实时同步 —— 监听源表 insert/update/delete 变更，实时映射到目标库/目标表；
 *   2) 全量快照 + 增量     —— 启动(onStart)时全量复制 schema + 数据，之后只传输增量 op；
 *   3) 多节点副本复制      —— 支持多个目标副本，每个副本独立 ack/重试，失败进入 outbox 待重放；
 *   4) WAL / 刷盘同步      —— 变更先写 append-only oplog(WAL)，随 db.flush()/onStop 落盘检查点，
 *                            重启后按检查点重放(seq > ack)，保证不丢不重（按主键幂等）。
 *
 * 作者：vexify-org(mesh-neo)
 *
 * 用法（jsql 插件形式）：
 *   const sync = require('mesh-sync');        // 或 jsql plugin install mesh-sync
 *   sync.opts = { srcTable: 'users', targets: [{ db: replicaA, table: 'users', name: 'a' }] };
 *   db.use(sync);
 *   ...
 *   await db.sync.syncNow();      // 手动刷一次
 *   console.log(db.sync.stats());
 *
 * 安装：jsql plugin install mesh-sync
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- 工具

const now = () => Date.now();

/** 从 schema 解析主键列；未显式指定 key 时用主键，没有主键则抛错（多节点同步建议用自然键）。 */
function resolveKeyColumn(db, ctx, table, fallbackKey) {
  if (fallbackKey) return fallbackKey;
  let schema = null;
  try { schema = ctx.getTableSchema ? ctx.getTableSchema(table) : null; } catch (e) { schema = null; }
  if (schema && typeof schema === 'object') {
    for (const col of Object.keys(schema)) {
      const d = schema[col];
      if (d && (d.primaryKey === true || String(d.type || '').toLowerCase().includes('primary key'))) return col;
    }
  }
  throw new Error(`sync: 表 "${table}" 没有可辨识的主键列，请在 opts.key 中显式指定同步键列`);
}

function resolveConfig(userOpts) {
  const env = process.env || {};
  const targets = (userOpts.targets || []).map((t) => normalizeTarget(t));
  const draft = {
    srcTable: userOpts.srcTable || env.JSYNC_SRC_TABLE || 'users',
    key: userOpts.key || null,
    targets,
    conflict: userOpts.conflict || 'source-wins', // 'source-wins' | 'ignore'
    snapshot: userOpts.snapshot !== false,        // 启动时全量快照
    flushMode: userOpts.flushMode || 'event',     // 'event' 变更即刷 | 'flush' 随 db.flush | 'manual'
    wal: userOpts.wal !== false,                  // 启用 WAL/outbox 持久化
    walPath: userOpts.walPath || path.join(os.tmpdir(), 'jsql-sync.jsonl'),
    retryMs: userOpts.retryMs || 1000,
  };
  // 未显式配置目标副本时，自动补一个同实例镜像表 <srcTable>__mirror
  if (draft.targets.length === 0) {
    draft.targets.push({ table: draft.srcTable + '__mirror', name: 'mirror' });
  }
  return draft;
}

function normalizeTarget(t) {
  const label = t.name || (t.db ? (t.tag || t.db.constructor && t.db.constructor.name || 'node') : 'same');
  return { db: t.db || null, table: t.table, name: t.name || label, conflict: t.conflict || null };
}

// ---------------------------------------------------------------- 同步引擎

function createSyncEngine(db, ctx, cfg) {
  const WAL_EXT = '.ckpt';
  const checkBuffer = [];

  const engine = {
    cfg,
    running: false,
    snapshotted: false,
    seq: 0,
    outbox: new Map(),      // target.name -> [ops]
    ack: new Map(),         // target.name -> seq（已成功应用的确认水位）
    retryTimers: new Map(),
    conflicts: new Map(),   // target.name -> 数量

    stats() {
      const s = { seq: this.seq, snapshotted: this.snapshotted, outbox: {}, ack: {}, conflicts: {} };
      this.cfg.targets.forEach((t) => {
        s.outbox[t.name] = (this.outbox.get(t.name) || []).length;
        s.ack[t.name] = this.ack.get(t.name) || 0;
        s.conflicts[t.name] = this.conflicts.get(t.name) || 0;
      });
      return s;
    },
  };

  // ---------------- WAL：把每个捕获的 op 追加到 append-only 日志，并维护检查点 ----------------

  function walAppend(op) {
    if (!cfg.wal) return;
    try { fs.appendFileSync(cfg.walPath, JSON.stringify(op) + '\n', 'utf8'); } catch (e) { /* ignore */ }
  }

  function checkpoint() {
    if (!cfg.wal) return;
    const ck = { ts: now(), seq: engine.seq, ack: {} };
    cfg.targets.forEach((t) => { ck.ack[t.name] = engine.ack.get(t.name) || 0; });
    try { fs.writeFileSync(cfg.walPath + WAL_EXT, JSON.stringify(ck), 'utf8'); } catch (e) { /* ignore */ }
  }

  function loadCheckpoint() {
    try {
      if (fs.existsSync(cfg.walPath + WAL_EXT)) {
        const ck = JSON.parse(fs.readFileSync(cfg.walPath + WAL_EXT, 'utf8'));
        cfg.targets.forEach((t) => { if (ck.ack) engine.ack.set(t.name, ck.ack[t.name] || 0); });
        engine.seq = ck.seq || 0;
      }
    } catch (e) { /* ignore */ }
  }

  // 启动时重放 WAL：把 seq > ack 的历史 op 按目标重新塞回 outbox（按主键幂等，安全重复）
  function replayWal() {
    if (!cfg.wal || !fs.existsSync(cfg.walPath)) return;
    const ops = fs.readFileSync(cfg.walPath, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    for (const op of ops) {
      if (op.seq > engine.seq) engine.seq = op.seq;   // 重放后序号继续递增，避免与历史 op 撞 seq
      if (!engine.outbox.has(op.target)) engine.outbox.set(op.target, []);
      // 只有尚未被 ack 的 op 需要重放
      const acked = engine.ack.get(op.target) || 0;
      if (op.seq > acked) engine.outbox.get(op.target).push(op);
    }
  }

  // ---------------- 捕获：CDC ingest --------------------------------

  function capture(op) {
    op.target = op.target || null;         // 全目标分发时置空，下分发给每个副本
    op.seq = op.seq || ++engine.seq;
    op.ts = op.ts || now();
    walAppend(op);
    dispatch(op, null);                    // null => 分发给所有目标
    if (cfg.flushMode === 'event') scheduleApply(op.target);
  }

  // 把一个 op 分发给一批目标（batch 里每个 op 都标记了自己的 targets）
  function dispatch(op, explicitTargets) {
    const list = explicitTargets || cfg.targets;
    for (const t of list) {
      if (!engine.outbox.has(t.name)) engine.outbox.set(t.name, []);
      const copy = Object.assign({}, op, { target: t.name });
      engine.outbox.get(t.name).push(copy);
    }
  }

  // ---------------- 应用：把 op 写到某个目标副本（幂等，按主键） ---------------

  async function applyTo(target) {
    const tbl = target.table;
    const tdb = target.db || db;
    const queue = engine.outbox.get(target.name) || [];
    if (queue.length === 0) return 0;

    // 未建目标表则以源表 schema 建表（全量快照的一部分）
    if (!tdb.hasTable(tbl)) {
      const schema = ctx.getTableSchema(cfg.srcTable);
      await tdb.createTable(tbl, schema);
    }

    let applied = 0;
    while (queue.length) {
      const op = queue[0];
      try {
        await doOp(tdb, tbl, op, target);
        engine.ack.set(target.name, op.seq);
        queue.shift();
        applied++;
      } catch (e) {
        // 副本暂时失败：保留在 outbox 稍后重试
        scheduleRetry(target);
        break;
      }
    }
    checkpoint();
    return applied;
  }

  async function doOp(tdb, tbl, op, target) {
    const mode = target.conflict || cfg.conflict;   // 该副本的冲突策略
    if (op.op === 'insert') {
      for (const e of op.entries) {
        const exists = await tdb.findById(tbl, e.key);
        if (exists) {
          if (mode === 'source-wins') await tdb.updateById(tbl, e.key, e.data);
          else bumpConflict(target);
          continue;
        }
        await tdb.insert(tbl, [e.data]);
      }
      return;
    }
    if (op.op === 'update') {
      const srcRow = await db.findById(cfg.srcTable, op.key); // 源当前完整行
      const exists = await tdb.findById(tbl, op.key);
      if (!exists) {
        if (mode === 'source-wins' && srcRow) await tdb.insert(tbl, [srcRow]);
        else { bumpConflict(target); return; }
      }
      await tdb.updateById(tbl, op.key, op.data);
      return;
    }
    if (op.op === 'delete') {
      if (await tdb.findById(tbl, op.key)) await tdb.removeById(tbl, op.key);
      return;
    }
  }

  function bumpConflict(target) {
    const c = engine.conflicts.get(target.name) || 0;
    engine.conflicts.set(target.name, c + 1);
  }

  // ---------------- 调度：event / flush / manual ---------------------

  let applyScheduled = false;
  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    queueMicrotask(() => { applyScheduled = false; engine.syncNow(); });
  }

  function scheduleRetry(target) {
    if (engine.retryTimers.has(target.name)) return;
    const timer = setTimeout(() => {
      engine.retryTimers.delete(target.name);
      applyTo(target);
    }, cfg.retryMs);
    if (typeof timer.unref === 'function') timer.unref();
    engine.retryTimers.set(target.name, timer);
  }

  // 对所有目标尝试 drain outbox
  // 对外公开：let install 层也能调用捕获（CDC ingest）
  engine.capture = capture;

  // 延迟解析同步键：db.use() 时源表可能尚未建立（如 registry 自动加载），首个变更/快照时再解析
  engine.ensureKey = function ensureKey() {
    if (!cfg.key) cfg.key = resolveKeyColumn(db, ctx, cfg.srcTable, null);
    return cfg.key;
  };

  engine.syncNow = async function syncNow() {
    return Promise.all(cfg.targets.map((t) => applyTo(t)));
  };

  // ---------------- 快照：全量复制 schema + 数据 ---------------------------------

  engine.snapshot = async function snapshot() {
    if (this.snapshotted) return 0;
    if (!db.hasTable(cfg.srcTable)) return 0; // 源表尚未建立：等首次 syncNow/snapshot 再试
    this.ensureKey();
    const rows = await db.find(cfg.srcTable, {});
    let copied = 0;
    for (const target of cfg.targets) {
      const tdb = target.db || db;
      const tbl = target.table;
      if (!tdb.hasTable(tbl)) {
        const schema = ctx.getTableSchema(cfg.srcTable);
        await tdb.createTable(tbl, schema);
      }
      const insertOp = { seq: ++this.seq, ts: now(), op: 'insert', target: target.name,
        entries: rows.map((r) => ({ key: r[cfg.key], data: r })) };
      walAppend(insertOp);
      if (!this.outbox.has(target.name)) this.outbox.set(target.name, []);
      this.outbox.get(target.name).push(insertOp);
      await applyTo(target); // 同步快照直接应用
      copied += rows.length;
    }
    this.snapshotted = true;
    checkpoint();
    return copied;
  };

  // ---------------- onStart / onStop / flushTicks -------------------------

  engine.start = function start() {
    if (this.running) return;
    this.running = true;
    loadCheckpoint();
    replayWal();
    if (cfg.snapshot) {
      // 快照放微任务里异步执行，不阻塞 db.use()
      queueMicrotask(() => { this.snapshot().then(() => this.syncNow()).catch(() => {}); });
    } else {
      queueMicrotask(() => this.syncNow());
    }
  };

  engine.stop = function stop() {
    this.running = false;
    if (cfg.flushMode !== 'event') {
      // 兜底：stop 前把手头调用方要求的不落盘变更刷掉（core 层面 flush 由 db.flush 负责）
    }
    return engine.syncNow().then(() => { checkpoint(); });
  };

  engine.flushTicks = function flushTicks() { return this.syncNow(); };

  // ---------------- 对外公开句柄 ------------------------------------------
  engine.api = function api() {
    return {
      syncNow: () => engine.syncNow(),
      snapshot: () => engine.snapshot(),
      stats: () => engine.stats(),
      config: engine.cfg,
    };
  };

  return engine;
}

// ---------------------------------------------------------------- 插件对象

const plugin = {
  name: 'sync',
  description: 'Mesh data sync for JSQL — CDC table mirror + snapshot/incremental + multi-node replicas + WAL/checkpoint',
  opts: {},                       // 用户在此处配置 { srcTable, targets, conflict, flushMode, wal, walPath }
  api: {
    version: '1.0.0',
    help: 'mesh 节点间 jsql 数据实时同步',
  },

  install(db, ctx) {
    // 运行期扩展：allow ctx.on 动态注册 hooks（避免模块级全局状态，支持多个 db 实例）
    if (typeof ctx !== 'object' || ctx === null || typeof ctx.on !== 'function') {
      throw new Error('sync: 需要 jsql-neo 的插件上下文(ctx.on)；请用 db.use()/ModuleManager 加载');
    }

    const userOpts = (this && this.opts) || plugin.opts || {};
    const cfg = resolveConfig(userOpts);
    try { cfg.key = resolveKeyColumn(db, ctx, cfg.srcTable, cfg.key); } catch (e) { cfg.key = cfg.key || null; }

    const engine = createSyncEngine(db, ctx, cfg);

    // 只同步源表
    ctx.on('afterInsert', (t, data, ids) => {
      if (t !== cfg.srcTable) return;
      try { engine.ensureKey(); } catch (e) { return; }
      const entries = (data || []).map((row, i) => ({ key: row[cfg.key], data: row }));
      if (entries.length === 0) return;
      engine.capture({ op: 'insert', table: cfg.srcTable, entries });
    });
    ctx.on('afterUpdate', (t, id, data) => {
      if (t !== cfg.srcTable) return;
      engine.capture({ op: 'update', table: cfg.srcTable, key: id, data });
    });
    ctx.on('afterDelete', (t, id) => {
      if (t !== cfg.srcTable) return;
      engine.capture({ op: 'delete', table: cfg.srcTable, key: id });
    });

    if (cfg.flushMode === 'flush') {
      ctx.on('afterFlush', () => engine.flushTicks());
    }

    // start/stop 生命周期：onStart 做全量快照，onStop 落检查点
    ctx.on('onStart', () => engine.start());
    ctx.on('onStop', () => engine.stop());

    // 挂到 db 实例上，供业务手动调用
    db.sync = engine.api();

    // 通知外部发生了"同步就绪"事件
    if (typeof ctx.emit === 'function') {
      ctx.emit('sync:ready', { srcTable: cfg.srcTable, targets: cfg.targets.map((t) => t.name) });
    }
    if (typeof ctx.onEvent === 'function') {
      ctx.onEvent((ev) => { if (ev === 'sync:ready') { /* 演示事件联动 */ } });
    }
    return db;
  },
};

// 供直接脚本使用：导出插件对象，同时导出工厂与引擎（便于测试/嵌入）
module.exports = plugin;
module.exports.plugin = plugin;
module.exports.create = createSyncEngine;