// uuid plugin for JSQL-neo
// Adds an auto-filled `uuid` (v4) column to every table and fills it on insert.
// Pure JS, no native deps, passes jsql-plugins security-check (no require/eval/child_process).

function uuidv4() {
  // RFC4122 v4, pure JS (no crypto import needed)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const COL = 'uuid';
const ensured = new Set();

async function ensureColumn(engine, table) {
  if (ensured.has(table)) return;
  try {
    await engine.addColumn(table, COL, 'string');
  } catch (e) {
    // column already exists or table does not support it — degrade gracefully
  }
  ensured.add(table);
}

module.exports = {
  name: 'uuid',
  install(engine) {
    const origCreate = engine.createTable ? engine.createTable.bind(engine) : null;
    if (origCreate) {
      engine.createTable = async function (table, schema, ...rest) {
        const r = await origCreate(table, schema, ...rest);
        await ensureColumn(engine, table);
        return r;
      };
    }

    const origInsert = engine.insert ? engine.insert.bind(engine) : null;
    if (origInsert) {
      engine.insert = async function (table, rows, ...rest) {
        await ensureColumn(engine, table);
        let payload = rows;
        if (Array.isArray(rows)) {
          payload = rows.map((r) =>
            r && typeof r === 'object' && r[COL] == null ? { ...r, [COL]: uuidv4() } : r
          );
        } else if (rows && typeof rows === 'object' && rows[COL] == null) {
          payload = { ...rows, [COL]: uuidv4() };
        }
        return origInsert(table, payload, ...rest);
      };
    }

    // public helper: generate a uuid on demand
    engine.genUUID = uuidv4;
  }
};
