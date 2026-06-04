/**
 * 数据同步模块 - 基于 Node.js (Port from Python/Flask)
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const BASE_DIR = path.dirname(__dirname);
const CONFIG_PATH = path.join(BASE_DIR, 'sync_config.json');
const HTML_PATH = path.join(__dirname, 'sync.html');

// Load the HTML template and patch API paths once
let cachedHtml = '';
try {
  cachedHtml = fs.readFileSync(HTML_PATH, 'utf-8')
    .replace(/\/api\/config\b/g, '/api/sync/config')
    .replace(/\/api\/configs\b/g, '/api/sync/configs')
    .replace(/\/api\/table-configs\b/g, '/api/sync/table-configs')
    .replace(/\/api\/table-config\//g, '/api/sync/table-config/')
    .replace(/\/api\/test-connection\b/g, '/api/sync/test-connection')
    .replace(/\/api\/tables-all\b/g, '/api/sync/tables-all')
    .replace(/\/api\/table-columns\b/g, '/api/sync/table-columns')
    .replace(/\/api\/sync\b(?![-/])/g, '/api/sync/execute');
} catch(e) { console.log('  [Sync] 模板加载失败:', e.message); }

// ==================== Config Management ====================

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch(e) { return { configs: {}, activeConfig: '', activeTableConfig: {} }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

function getActive() {
  const cfg = loadConfig();
  const name = cfg.activeConfig || '';
  const c = cfg.configs?.[name] || {};
  const tcName = cfg.activeTableConfig?.[name] || '';
  const tc = c.tableConfigs?.[tcName] || {};
  return {
    config: { name, source: c.source || {}, target: c.target || {} },
    tableConfig: { name: tcName, tables: tc.tables || {} },
    tableConfigNames: Object.keys(c.tableConfigs || {}),
  };
}

function listConfigs() {
  return Object.keys(loadConfig().configs || {});
}

function listTableConfigs(configName) {
  const cfg = loadConfig();
  const name = configName || cfg.activeConfig;
  return Object.keys(cfg.configs?.[name]?.tableConfigs || {});
}

function switchConfig(name) {
  const cfg = loadConfig();
  if (!cfg.configs?.[name]) return null;
  cfg.activeConfig = name;
  if (!cfg.activeTableConfig) cfg.activeTableConfig = {};
  if (!cfg.activeTableConfig[name]) cfg.activeTableConfig[name] = Object.keys(cfg.configs[name].tableConfigs || {})[0] || '';
  saveConfig(cfg);
  return getActive();
}

function createConfig(name) {
  const cfg = loadConfig();
  if (!cfg.configs) cfg.configs = {};
  if (cfg.configs[name]) return false;
  cfg.configs[name] = { source: {}, target: {}, tableConfigs: { '默认': { tables: {} } } };
  cfg.activeConfig = name;
  if (!cfg.activeTableConfig) cfg.activeTableConfig = {};
  cfg.activeTableConfig[name] = '默认';
  saveConfig(cfg);
  return true;
}

function renameConfig(newName) {
  const cfg = loadConfig();
  const current = cfg.activeConfig;
  if (!current || !cfg.configs?.[current]) return null;
  if (newName !== current && cfg.configs[newName]) return null;
  cfg.configs[newName] = cfg.configs[current];
  if (newName !== current) delete cfg.configs[current];
  cfg.activeConfig = newName;
  if (cfg.activeTableConfig?.[current]) {
    cfg.activeTableConfig[newName] = cfg.activeTableConfig[current];
    if (newName !== current) delete cfg.activeTableConfig[current];
  }
  saveConfig(cfg);
  return { ok: true, name: newName };
}

function switchTableConfig(name) {
  const cfg = loadConfig();
  const cname = cfg.activeConfig;
  const c = cfg.configs?.[cname];
  if (!c?.tableConfigs?.[name]) return null;
  if (!cfg.activeTableConfig) cfg.activeTableConfig = {};
  cfg.activeTableConfig[cname] = name;
  saveConfig(cfg);
  return { name, tables: c.tableConfigs[name].tables || {} };
}

function createTableConfig(name, copyFrom) {
  const cfg = loadConfig();
  const cname = cfg.activeConfig;
  const c = cfg.configs?.[cname];
  if (!c) return null;
  if (!c.tableConfigs) c.tableConfigs = {};
  if (c.tableConfigs[name]) return null;
  if (copyFrom && c.tableConfigs[copyFrom]) {
    c.tableConfigs[name] = JSON.parse(JSON.stringify(c.tableConfigs[copyFrom]));
  } else {
    c.tableConfigs[name] = { tables: {} };
  }
  if (!cfg.activeTableConfig) cfg.activeTableConfig = {};
  cfg.activeTableConfig[cname] = name;
  saveConfig(cfg);
  return { name, tables: c.tableConfigs[name].tables || {} };
}

function renameTableConfig(newName) {
  const cfg = loadConfig();
  const cname = cfg.activeConfig;
  const c = cfg.configs?.[cname];
  if (!c?.tableConfigs) return null;
  const current = cfg.activeTableConfig?.[cname] || '';
  if (!c.tableConfigs[current]) return null;
  if (newName !== current && c.tableConfigs[newName]) return null;
  c.tableConfigs[newName] = c.tableConfigs[current];
  if (newName !== current) delete c.tableConfigs[current];
  if (!cfg.activeTableConfig) cfg.activeTableConfig = {};
  cfg.activeTableConfig[cname] = newName;
  saveConfig(cfg);
  return { name: newName };
}

function saveActiveConfig(config, tableConfig) {
  const cfg = loadConfig();
  const name = cfg.activeConfig || 'default';
  if (!cfg.configs) cfg.configs = {};
  if (!cfg.configs[name]) cfg.configs[name] = { source: {}, target: {}, tableConfigs: { '默认': { tables: {} } } };
  const c = cfg.configs[name];
  if (config.source) c.source = config.source;
  if (config.target) c.target = config.target;
  const tcName = cfg.activeTableConfig?.[name] || '默认';
  if (!c.tableConfigs) c.tableConfigs = {};
  if (!c.tableConfigs[tcName]) c.tableConfigs[tcName] = { tables: {} };
  if (tableConfig?.tables) c.tableConfigs[tcName].tables = tableConfig.tables;
  saveConfig(cfg);
  return { ok: true };
}

// ==================== Database ====================

async function connectDb(cfg) {
  return mysql.createConnection({
    host: cfg.host,
    port: parseInt(cfg.port) || 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'gas_balance',
    charset: 'utf8mb4',
  });
}

async function getConnectionInfo(side) {
  const cfg = loadConfig();
  const name = cfg.activeConfig;
  const c = cfg.configs?.[name] || {};
  return side === 'source' ? (c.source || {}) : (c.target || {});
}

// ==================== Handlers ====================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

async function handleSyncRequest(req, res, url) {
  const method = req.method;
  const path = url.pathname;

  // Page
  if (path === '/sync' && method === 'GET') {
    if (!cachedHtml) { res.writeHead(500); return res.end('Template not loaded'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(cachedHtml);
  }

  // API endpoints
  try {
    // Config CRUD
    if (path === '/api/sync/config' && method === 'GET') {
      return json(res, getActive());
    }
    if (path === '/api/sync/config' && method === 'POST') {
      const d = await parseBody(req);
      return json(res, saveActiveConfig(d.config, d.tableConfig));
    }
    if (path === '/api/sync/config/exists' && method === 'POST') {
      const cfg = loadConfig();
      const hasHost = Object.values(cfg.configs || {}).some(c => c.source?.host || c.target?.host);
      return json(res, { exists: hasHost });
    }
    if (path === '/api/sync/configs' && method === 'GET') {
      return json(res, listConfigs());
    }
    if (path === '/api/sync/config/switch' && method === 'POST') {
      const d = await parseBody(req);
      const r = switchConfig(d.name);
      if (!r) return error(res, '配置不存在', 404);
      return json(res, r);
    }
    if (path === '/api/sync/config/create' && method === 'POST') {
      const d = await parseBody(req);
      const name = (d.name || '').trim();
      if (!name) return error(res, '配置名不能为空', 400);
      if (!createConfig(name)) return error(res, '名称已存在', 409);
      return json(res, { ok: true });
    }
    if (path === '/api/sync/config/rename' && method === 'POST') {
      const d = await parseBody(req);
      const name = (d.name || '').trim();
      if (!name) return error(res, '名称不能为空', 400);
      const r = renameConfig(name);
      if (!r) return error(res, '重命名失败', 400);
      return json(res, r);
    }

    // Table config
    if (path === '/api/sync/table-configs' && method === 'GET') {
      return json(res, listTableConfigs(url.searchParams.get('config')));
    }
    if (path === '/api/sync/table-config/switch' && method === 'POST') {
      const d = await parseBody(req);
      const r = switchTableConfig(d.name);
      if (!r) return error(res, '表配置不存在', 404);
      return json(res, r);
    }
    if (path === '/api/sync/table-config/create' && method === 'POST') {
      const d = await parseBody(req);
      const name = (d.name || '').trim();
      if (!name) return error(res, '名称不能为空', 400);
      const r = createTableConfig(name, d.copyFrom);
      if (!r) return error(res, '名称已存在', 409);
      return json(res, r);
    }
    if (path === '/api/sync/table-config/rename' && method === 'POST') {
      const d = await parseBody(req);
      const name = (d.name || '').trim();
      if (!name) return error(res, '名称不能为空', 400);
      const r = renameTableConfig(name);
      if (!r) return error(res, '重命名失败', 400);
      return json(res, r);
    }

    // Database
    if (path === '/api/sync/test-connection' && method === 'POST') {
      const d = await parseBody(req);
      const result = {};
      for (const side of ['source', 'target']) {
        try {
          const conn = await connectDb(d[side]);
          const [rows] = await conn.execute('SELECT VERSION() as v');
          const [tables] = await conn.execute("SELECT COUNT(*) as cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=?", [d[side].database]);
          await conn.end();
          result[side] = { ok: true, version: rows[0].v, tables: tables[0].cnt };
        } catch(e) {
          result[side] = { ok: false, error: e.message };
        }
      }
      return json(res, result);
    }

    if (path === '/api/sync/tables-all' && method === 'POST') {
      const d = await parseBody(req);
      let conn;
      try {
        conn = await connectDb(d);
        const db = d.database;
        const [tables] = await conn.execute("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", [db]);
        const [cols] = await conn.execute("SELECT TABLE_NAME as t, COLUMN_NAME as c, DATA_TYPE as dt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND EXTRA NOT LIKE '%VIRTUAL%' ORDER BY TABLE_NAME, ORDINAL_POSITION", [db]);
        const columns = {};
        for (const row of cols) {
          if (!columns[row.t]) columns[row.t] = [];
          columns[row.t].push({ name: row.c, type: row.dt });
        }
        return json(res, { tables: tables.map(r => r.name), columns });
      } catch(e) {
        return error(res, e.message);
      } finally {
        if (conn) try { await conn.end(); } catch(e) {}
      }
    }

    if (path === '/api/sync/table-columns' && method === 'POST') {
      const d = await parseBody(req);
      let conn;
      try {
        conn = await connectDb(d.connection);
        const [rows] = await conn.execute(
          "SELECT COLUMN_NAME as c, DATA_TYPE as dt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
          [d.connection.database, d.table]);
        return json(res, rows.map(r => ({ name: r.c, type: r.dt })));
      } catch(e) {
        return error(res, e.message);
      } finally {
        if (conn) try { await conn.end(); } catch(e) {}
      }
    }

    if (path === '/api/sync/execute' && method === 'POST') {
      return handleSyncExecute(req, res);
    }
  } catch(e) {
    return error(res, e.message);
  }

  return false;
}

// ==================== Sync Execution ====================

function getColumns(rows) {
  // Return column names from information_schema.COLUMNS result
  return rows.map(r => r.COLUMN_NAME || r.c);
}

async function handleSyncExecute(req, res) {
  const data = await parseBody(req);
  const srcCfg = data.source;
  const dstCfg = data.target;
  const enabled = Object.entries(data.tables || {}).filter(([, t]) => t.enable);
  const dbName = srcCfg.database || 'gas_balance';

  const BATCH_SIZE = 5000;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = (msg) => {
    res.write(`data: ${JSON.stringify({ msg }, null, 0)}\n\n`);
  };

  const totalStart = Date.now();
  let totalNew = 0, totalUpd = 0;

  for (const [tbl, tcfg] of enabled) {
    const tblStart = Date.now();
    const mode = tcfg.mode || 'time';
    const tf = tcfg.timeField || '';

    emit(`▶ [${tbl}] 开始同步...`);

    let srcConn, dstConn;
    try {
      srcConn = await connectDb(srcCfg);
      dstConn = await connectDb(dstCfg);
      const [src] = await srcConn.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND EXTRA NOT LIKE '%VIRTUAL%' ORDER BY ORDINAL_POSITION",
        [dbName, tbl]);
      if (!src.length) { emit('  ⚠ 表不存在，已跳过'); continue; }
      const cols = src.map(r => r.COLUMN_NAME);

      let query;
      if (mode === 'all') {
        query = `SELECT * FROM \`${tbl}\``;
      } else {
        const tr = (tcfg.timeRange || '').trim();
        let s, e;
        if (tr && tr.includes('~')) {
          const parts = tr.split('~');
          s = parts[0].trim();
          e = parts[1].trim();
        } else {
          const d = new Date();
          e = d.toISOString().substring(0, 10);
          d.setDate(d.getDate() - 7);
          s = d.toISOString().substring(0, 10);
        }
        if (tf) {
          query = `SELECT * FROM \`${tbl}\` WHERE \`${tf}\` >= '${s}' AND \`${tf}\` < '${e}' + INTERVAL 1 DAY`;
        } else {
          query = `SELECT * FROM \`${tbl}\``;
        }
      }

      const [rows] = await srcConn.execute(query);
      const srcCnt = rows.length;
      if (!srcCnt) { emit(`  ✓ 源库 0 条`); continue; }

      if (!dstCfg.database) { emit('  ⚠ 目标库未配置'); continue; }

      // Build INSERT SQL
      const colNames = cols.map(c => `\`${c}\``).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const updates = cols.filter(c => c.toLowerCase() !== 'id').map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');
      const sql = `INSERT INTO \`${tbl}\` (${colNames}) VALUES (${placeholders})${updates ? ' ON DUPLICATE KEY UPDATE ' + updates : ''}`;

      let batch = [];
      let nAdd = 0, nUpd = 0;

      for (const row of rows) {
        const vals = cols.map(c => row[c] ?? null);
        batch.push(vals);
        if (batch.length >= BATCH_SIZE) {
          const [result] = await dstConn.execute(sql, batch);
          const affected = result.affectedRows;
          nUpd += Math.max(affected - batch.length, 0);
          nAdd += Math.max(batch.length * 2 - affected, 0);
          batch = [];
        }
      }
      if (batch.length) {
        const [result] = await dstConn.execute(sql, batch);
        const affected = result.affectedRows;
        nUpd += Math.max(affected - batch.length, 0);
        nAdd += Math.max(batch.length * 2 - affected, 0);
      }

      emit(`  ✓ 源库 ${srcCnt} 条 → 新增 ${nAdd} 更新 ${nUpd} [${((Date.now()-tblStart)/1000).toFixed(1)}s]`);
      totalNew += nAdd; totalUpd += nUpd;
    } catch(e) {
      emit(`  ✗ 异常: ${e.message}`);
    } finally {
      if (srcConn) try { await srcConn.end(); } catch(e) {}
      if (dstConn) try { await dstConn.end(); } catch(e) {}
    }
  }

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  emit('');
  emit('━━━━━━━━━━━━━━━━━━━━━━━');
  emit(`✅ 完成！新增 ${totalNew} 条，更新 ${totalUpd} 条，耗时 ${totalTime}s`);
  emit('__DONE__');
  res.end();
}

// ==================== Module exports ====================

module.exports = {
  name: 'sync',
  label: '数据同步',
  icon: '🔄',
  description: 'MySQL 数据库间表级数据同步，支持源/目标配置、按时间或全量同步',
  matchPath: (p) => p === '/sync' || p.startsWith('/api/sync'),
  handleRequest: handleSyncRequest,
};
