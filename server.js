/**
 * Token 看板 v1.0
 * 多维度 Token 统计：每日趋势 + 模型/项目饼图，支持交互筛选
 * 双击 start.bat 或 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PORT = 3456;
const TOOL_CONFIGS = {
  claude: { dir: path.join(os.homedir(), '.claude', 'projects'), type: 'jsonl', label: 'Claude Code' },
  'trae-intl': { dirs: [path.join(os.homedir(), 'AppData', 'Roaming', 'Trae')], type: 'trae_log', label: 'Trae' },
  'trae-cn': { dirs: [path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN')], type: 'trae_log', label: 'Trae CN' },
};
let currentTool = 'claude';

function shortName(raw) {
  return (raw || '').replace(/^[a-zA-Z]--/, '').replace(/^Projects-/, '').replace(/--/g, '/') || raw;
}
function cleanModel(raw) {
  return (raw || '').replace(/<[^>]*>/g, '').trim();
}

let cache = { data: null, ts: 0 };
const traeCaches = {};
const traeParsing = {}; // track in-progress parses
const TTL = 30000;
const CONFIG_FILE = path.join(os.homedir(), '.token-kanban', 'config.json');
try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); } catch(e) {}
function loadServerConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; } }

// ============ 解析 ============

function parseAll(toolName) {
  const now = Date.now();
  if (cache.data && now - cache.ts < TTL && !toolName) return cache.data;
  const tool = toolName || currentTool;
  const cfg = TOOL_CONFIGS[tool];
  if (!cfg) return [];
  cache = { data: null, ts: 0 };

  const records = [];
  if (cfg.type === 'jsonl') {
    if (!fs.existsSync(cfg.dir)) { console.log('  [Claude] 目录不存在: ' + cfg.dir); return records; }
    const projs = fs.readdirSync(cfg.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    console.log('  [Claude] 扫描目录: ' + cfg.dir + ' (' + projs.length + ' 个项目)');
    let totalFiles = 0;
    for (const proj of projs) {
      const dir = path.join(cfg.dir, proj);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      totalFiles += files.length;
      for (const f of files) {
        try { const sess = parseFile(path.join(dir, f), proj); if (sess) records.push(...sess); } catch { }
      }
    }
    console.log('  [Claude] 读取 ' + totalFiles + ' 个文件, 共 ' + records.length + ' 条记录');
  } else if (cfg.type === 'trae_log') {
    const tc = traeCaches[tool];
    if (tc && tc.data && tc.ts > 0) {
      if (now - tc.ts > TTL) parseTraeLogs(tool).catch(() => {});
      return tc.data;
    }
    if (!tc) traeCaches[tool] = { data: [], ts: 0 };
    parseTraeLogs(tool).catch(() => {});
    return [];
  }
  cache = { data: records, ts: Date.now() };
  return records;
}

function parseFile(fp, proj) {
  const text = fs.readFileSync(fp, 'utf-8').trim();
  if (!text) { console.log('    [Claude] 空文件跳过: ' + path.basename(fp)); return null; }
  const records = [];
  let sid = '';
  let lastUsageKey = '';

  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.sessionId) { if (e.sessionId !== sid) lastUsageKey = ''; sid = e.sessionId; }
      if ((e.type === 'assistant' || e.type === 'message') && e.message && e.message.usage && e.timestamp) {
        const u = e.message.usage;
        const model = cleanModel(e.message.model) || 'unknown';
        const usageKey = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].join('|');
        if (usageKey === lastUsageKey) continue;
        lastUsageKey = usageKey;
        records.push({
          date: e.timestamp.substring(0, 10),
          model,
          project: shortName(proj),
          sessionId: sid,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          total: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        });
      }
      if (e.type === 'message' && e.usage && !e.message?.usage) {
        const u = e.usage;
        const model = cleanModel(e.model) || 'unknown';
        records.push({
          date: e.timestamp ? e.timestamp.substring(0, 10) : '',
          model,
          project: shortName(proj),
          sessionId: sid,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          total: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        });
      }
    } catch { }
  }
  if (records.length > 0) console.log('    [Claude] ' + path.basename(fp) + ' -> ' + records.length + ' 条');
  return records.length > 0 ? records : null;
}

// ============ Trae 日志解析 ============

function addTraeRecord(records, body, timestamp, sessionId) {
  const gf = (name) => {
    const m = body.match(new RegExp(name + ':\\s*(?:Some\\((\\d+)\\)|(\\d+))'));
    return m ? parseInt(m[1] || m[2]) : 0;
  };
  const pt = gf('prompt_tokens');
  const ct = gf('completion_tokens');
  const cr = gf('cache_read_input_tokens');
  const cc = gf('cache_creation_input_tokens');
  records.push({
    date: timestamp.substring(0, 10),
    model: 'Trae',
    project: 'Trae',
    sessionId,
    input: pt,
    output: ct,
    cacheRead: cr,
    cacheCreate: cc,
    total: pt + ct + cr + cc,
  });
}

function parseTraeLogFile(fp) {
  return new Promise((resolve, reject) => {
    const records = [];
    const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let buf = '', curTs = '', inEvent = false;
    rl.on('line', line => {
      const startMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*token usage:\s*TokenUsageEvent\s*\{/);
      if (startMatch) {
        if (inEvent) buf = '';
        inEvent = true; curTs = startMatch[1];
        buf = line.substring(line.indexOf('{') + 1);
        const endMatch = buf.match(/\}\s*trace_id="[^"]*"\s*session_id=(\w+)/);
        if (endMatch) { addTraeRecord(records, buf.substring(0, buf.indexOf('}')), curTs, endMatch[1]); inEvent = false; buf = ''; }
        return;
      }
      if (inEvent) {
        const endMatch = line.match(/\}\s*trace_id="[^"]*"\s*session_id=(\w+)/);
        if (endMatch) { buf += '\n' + line; addTraeRecord(records, buf.substring(0, buf.indexOf('}')), curTs, endMatch[1]); inEvent = false; buf = ''; }
        else buf += '\n' + line;
      }
    });
    rl.on('close', () => resolve(records));
    rl.on('error', reject);
  });
}

async function parseTraeLogs(tool) {
  const label = (TOOL_CONFIGS[tool] || {}).label || tool;
  if (traeParsing[tool]) return traeParsing[tool];
  console.log('  [' + label + '] 开始解析日志...');
  traeParsing[tool] = (async () => {
    const cfg = TOOL_CONFIGS[tool];
    const srvCfg = loadServerConfig();
    const dirs = srvCfg[tool] ? [srvCfg[tool]] : cfg.dirs;
    console.log('  [' + label + '] 日志根目录: ' + JSON.stringify(dirs));
    const allRecords = [];
    for (const baseDir of dirs) {
      const logsDir = path.basename(baseDir) === 'logs' ? baseDir : path.join(baseDir, 'logs');
      if (!fs.existsSync(logsDir)) continue;
      const sessions = fs.readdirSync(logsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
      for (const session of sessions) {
        const modularDir = path.join(logsDir, session, 'Modular');
        if (!fs.existsSync(modularDir)) continue;
        const files = fs.readdirSync(modularDir).filter(f => f.endsWith('_stdout.log') && f.startsWith('ai-agent_'));
        if (files.length > 0) console.log('  [' + label + '] 会话 ' + session + ': ' + files.length + ' 个日志文件');
        for (const file of files) {
          const fp = path.join(modularDir, file);
          try {
            const pr = await parseTraeLogFile(fp);
            if (pr.length > 0) console.log('    [' + label + '] ' + file + ' -> ' + pr.length + ' 条');
            allRecords.push(...pr);
          } catch (e) { /* skip */ }
        }
      }
    }
    traeCaches[tool] = { data: allRecords, ts: Date.now() };
    console.log('  [' + label + '] 解析完成: ' + allRecords.length + ' 条记录');
    delete traeParsing[tool];
  })();
  try {
    await traeParsing[tool];
  } catch (e) {
    delete traeParsing[tool];
  }
}

function parseTraeLogsSync(tool) {
  const cfg = TOOL_CONFIGS[tool];
  const srvCfg = loadServerConfig();
  const dirs = srvCfg[tool] ? [srvCfg[tool]] : cfg.dirs;
  const allRecords = [];
  for (const baseDir of dirs) {
    const logsDir = path.basename(baseDir) === 'logs' ? baseDir : path.join(baseDir, 'logs');
    if (!fs.existsSync(logsDir)) continue;
    const sessions = fs.readdirSync(logsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const session of sessions) {
      const modularDir = path.join(logsDir, session, 'Modular');
      if (!fs.existsSync(modularDir)) continue;
      const files = fs.readdirSync(modularDir).filter(f => f.endsWith('_stdout.log') && f.startsWith('ai-agent_'));
      for (const file of files) {
        const fp = path.join(modularDir, file);
        try {
          const stats = fs.statSync(fp);
          if (stats.size > 50 * 1024 * 1024) continue;
          const content = fs.readFileSync(fp, 'utf-8');
          const re = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})[\s\S]*?token usage:\s*TokenUsageEvent\s*\{([\s\S]*?)\}\s*trace_id="[^"]*"\s*session_id=(\w+)/g;
          let m;
          while ((m = re.exec(content)) !== null) {
            addTraeRecord(allRecords, m[2], m[1], m[3]);
          }
        } catch (e) { /* skip */ }
      }
    }
  }
  if (!traeCaches[tool]) traeCaches[tool] = { data: [], ts: 0 };
  return allRecords;
}

// Background parse at startup
const traeTools = Object.keys(TOOL_CONFIGS).filter(k => TOOL_CONFIGS[k].type === 'trae_log');
console.log('  [Trae] 启动后台预解析: ' + traeTools.join(', '));
for (const t of traeTools) setTimeout(() => parseTraeLogs(t).catch(() => {}), 0);

// ============ 数据聚合 ============

function getTokenReport(records) {
  records = records.filter(r => r.model && r.model !== 'unknown' && r.total > 0);
  const cellMap = {};
  for (const r of records) {
    if (!r.date) continue;
    const key = r.date + '|' + r.model + '|' + r.project;
    if (!cellMap[key]) cellMap[key] = { date: r.date, model: r.model, project: r.project, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, sessions: new Set() };
    const c = cellMap[key];
    c.input += r.input; c.output += r.output; c.cacheRead += r.cacheRead; c.cacheCreate += r.cacheCreate;
    c.total += r.total; c.sessions.add(r.sessionId);
  }

  const mpMap = {};
  for (const r of records) {
    const key = r.model + '|' + r.project;
    if (!mpMap[key]) mpMap[key] = { model: r.model, project: r.project, total: 0, sessions: new Set() };
    mpMap[key].total += r.total;
    mpMap[key].sessions.add(r.sessionId);
  }

  const cells = Object.values(cellMap).map(c => ({ ...c, sessions: c.sessions.size }));
  const modelProject = Object.values(mpMap).map(m => ({ ...m, sessions: m.sessions.size })).sort((a, b) => b.total - a.total);

  const modelTotals = {};
  for (const r of records) {
    if (!modelTotals[r.model]) modelTotals[r.model] = { name: r.model, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: new Set() };
    modelTotals[r.model].total += r.total;
    modelTotals[r.model].input += r.input;
    modelTotals[r.model].output += r.output;
    modelTotals[r.model].cacheRead += r.cacheRead;
    modelTotals[r.model].cacheCreate += r.cacheCreate;
    modelTotals[r.model].sessions.add(r.sessionId);
  }

  const projTotals = {};
  for (const r of records) {
    if (!projTotals[r.project]) projTotals[r.project] = { name: r.project, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: new Set() };
    projTotals[r.project].total += r.total;
    projTotals[r.project].input += r.input;
    projTotals[r.project].output += r.output;
    projTotals[r.project].cacheRead += r.cacheRead;
    projTotals[r.project].cacheCreate += r.cacheCreate;
    projTotals[r.project].sessions.add(r.sessionId);
  }

  const grandTotal = records.reduce((s, r) => s + r.total, 0);
  const allDates = [...new Set(cells.map(c => c.date))].sort();
  const allModels = Object.keys(modelTotals).sort();
  const allProjects = Object.keys(projTotals).sort();

  return {
    summary: {
      grandTotal,
      totalSessions: records.reduce((s, r) => { s.add(r.sessionId); return s; }, new Set()).size,
      totalDays: allDates.length,
      totalModels: allModels.length,
      totalProjects: allProjects.length,
      totalRecords: records.length,
    },
    models: allModels.map(m => ({
      name: m,
      total: modelTotals[m].total,
      input: modelTotals[m].input,
      output: modelTotals[m].output,
      cacheRead: modelTotals[m].cacheRead,
      cacheCreate: modelTotals[m].cacheCreate,
      sessions: modelTotals[m].sessions.size,
      share: grandTotal > 0 ? (modelTotals[m].total / grandTotal * 100).toFixed(1) : '0',
    })),
    projects: allProjects.map(p => ({
      name: p,
      total: projTotals[p].total,
      input: projTotals[p].input,
      output: projTotals[p].output,
      cacheRead: projTotals[p].cacheRead,
      cacheCreate: projTotals[p].cacheCreate,
      sessions: projTotals[p].sessions.size,
      share: grandTotal > 0 ? (projTotals[p].total / grandTotal * 100).toFixed(1) : '0',
    })),
    cells: cells.sort((a, b) => a.date.localeCompare(b.date)),
    modelProject,
    dates: allDates,
  };
}

// ============ Helper ============

const fmt = v => v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v);
function darkenColor(hex, f){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return '#'+[r,g,b].map(c=>Math.round(c*f).toString(16).padStart(2,'0')).join('')}
function lightenColor(hex, f){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return '#'+[r,g,b].map(c=>Math.min(255,Math.round(c+(255-c)*f)).toString(16).padStart(2,'0')).join('')}
const SVG = {
  bolt: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  sun: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  moon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  ref: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  bar: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
  pie: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
  filter: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  gear: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

// ============ HTML ============

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token 看板</title>
<style>
*,*::after,*::before{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0c0a09;--s:#1c1917;--s2:#292524;--b:#44403c;--t:#e7e5e4;--t2:#a8a29e;--a:#06b6d4;--r:8px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif}
[data-theme="light"]{--bg:#fafaf9;--s:#fff;--s2:#f5f5f4;--b:#d6d3d1;--t:#1c1917;--t2:#78716c;--a:#0891b2}
body{font-family:var(--font);background:var(--bg);color:var(--t);min-height:100vh}
.app{max-width:1050px;margin:0 auto;padding:24px 20px}
::selection{background:var(--a);color:#fff}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px}
.hdr h1{font-size:22px;font-weight:600;display:flex;align-items:center;gap:8px;letter-spacing:-.02em}
.hdr h1 svg{color:var(--a)}
.ac{display:flex;gap:6px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--b);border-radius:var(--r);background:var(--s);color:var(--t);font-size:13px;cursor:pointer;transition:all .15s;font-family:var(--font);line-height:1}
.btn:hover{background:var(--s2);border-color:var(--t2)}
.bi{padding:5px;min-width:28px;justify-content:center}

/* Stats */
.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:16px}
.sc{background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:14px;position:relative;overflow:hidden}
.sc .v{font-size:26px;font-weight:700;letter-spacing:-.02em}
.sc .l{font-size:12px;color:var(--t2);text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.sc .s{font-size:13px;color:var(--t2);margin-top:4px}
.sc .ac{color:var(--a)}
.sc .bar{position:absolute;bottom:0;left:0;height:2px;background:var(--a);opacity:.25;transition:width .5s}

/* Filters */
.fb{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.fb .fl{font-size:11px;color:var(--t2);text-transform:uppercase;letter-spacing:.06em}
.fg{display:flex;gap:4px;flex-wrap:wrap}
.fc{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid var(--b);border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s;background:var(--s);color:var(--t2);font-family:var(--font);user-select:none}
.fc:hover{border-color:var(--t2)}
.fc.act{background:var(--a);color:#fff;border-color:var(--a)}
.fc .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.fc .x{opacity:.5;margin-left:2px}
.fc .x:hover{opacity:1}

/* Chart cards */
.cc{background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:16px;margin-bottom:10px;overflow:hidden}
.cc h3{font-size:13px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;align-items:center;gap:6px}
.cc h3 svg{color:var(--a)}
.cw{position:relative;width:100%}
.cw canvas{display:block;width:100%;height:340px}

/* Pie row inside card */
.pr{display:grid;grid-template-columns:1fr 1fr;gap:0}
@media(max-width:700px){.pr{grid-template-columns:1fr}}
.pie-wrap{text-align:center;overflow:hidden}
.pie-wrap canvas{display:block;margin:0 auto;height:220px}
.pie-wrap .pl{font-size:13px;color:var(--t2);margin-top:6px;text-align:center}
.pie-wrap .pl strong{color:var(--t)}

.legend{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:8px;max-height:200px;overflow-y:auto}
.li{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--t2);padding:3px 8px;border-radius:4px;cursor:pointer;transition:all .12s;border:1px solid transparent;background:var(--s2);user-select:none}
.li:hover{border-color:var(--b)}
.li.act{border-color:var(--a);color:var(--t)}
.li .d{width:7px;height:7px;border-radius:2px;flex-shrink:0}
.li .pct{font-weight:600;margin-left:2px}

.ld{padding:60px;text-align:center;color:var(--t2)}
.sp{width:24px;height:24px;border:2px solid var(--b);border-top-color:var(--a);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}

/* Tooltip */
.tp{position:fixed;background:#000;color:#fff;font-size:13px;padding:8px 12px;border-radius:4px;pointer-events:none;z-index:100;opacity:0;transition:opacity .12s;border:1px solid #333;max-width:280px;line-height:1.6;font-family:var(--font)}
.tp.show{opacity:1}

@media(max-width:600px){.app{padding:16px 12px}.sg{grid-template-columns:repeat(2,1fr)}}

/* Modal */
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:200;display:none;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:var(--s);border:1px solid var(--b);border-radius:12px;padding:20px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto}
.modal h2{font-size:16px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:6px}
.modal h2 svg{color:var(--a)}
.msec{margin-bottom:16px}
.msec h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);margin-bottom:8px;font-weight:600}
.mrow{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.mrow label{font-size:12px;color:var(--t);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrow input[type=text]{flex:1;min-width:0;padding:4px 8px;border:1px solid var(--b);border-radius:4px;background:var(--bg);color:var(--t);font-size:12px;font-family:var(--font)}
.mrow input[type=text]:focus{outline:none;border-color:var(--a)}
.mrow input[type=checkbox]{accent-color:var(--a)}
.di{padding:3px 8px;border:1px solid var(--b);border-radius:4px;background:var(--bg);color:var(--t);font-size:12px;font-family:var(--font);max-width:140px}
.di:focus{outline:none;border-color:var(--a)}
.mb{display:flex;justify-content:flex-end;gap:6px;margin-top:12px}

/* Tool switcher */
.ts{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.tc{display:inline-flex;align-items:center;gap:4px;padding:4px 14px;border:1px solid var(--b);border-radius:20px;font-size:13px;cursor:pointer;transition:all .15s;background:var(--s);color:var(--t2);font-family:var(--font);user-select:none}
.tc:hover{border-color:var(--t2);color:var(--t)}
.tc.act{background:var(--a);color:#fff;border-color:var(--a)}

/* Calendar popup */
.cal-popup{position:absolute;z-index:300;background:var(--s);border:1px solid var(--b);border-radius:8px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);font-size:12px;width:240px;font-family:var(--font)}
.cal-popup .cal-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.cal-popup .cal-hdr .cal-nav{cursor:pointer;padding:2px 8px;border-radius:4px;color:var(--t2);font-size:14px;user-select:none}
.cal-popup .cal-hdr .cal-nav:hover{background:var(--s2);color:var(--t)}
.cal-popup .cal-hdr .cal-m{font-weight:600;font-size:13px}
.cal-popup table{width:100%;border-collapse:collapse;text-align:center}
.cal-popup th{font-size:11px;color:var(--t2);font-weight:400;padding:2px 0}
.cal-popup td{padding:2px 0}
.cal-popup td span{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;border-radius:4px;cursor:pointer;font-size:12px;transition:all .1s}
.cal-popup td span:hover{background:var(--s2)}
.cal-popup td span.sel{background:var(--a);color:#fff;font-weight:600}
.cal-popup td span.in-range{background:var(--a);opacity:.3;border-radius:0}
.cal-popup td span.in-range-start{border-radius:4px 0 0 4px}
.cal-popup td span.in-range-end{border-radius:0 4px 4px 0}
.cal-popup td span.other{color:var(--b);cursor:default}

/* Loading overlay */
.loading-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;display:none;align-items:center;justify-content:center}
.loading-overlay.show{display:flex}
.loading-overlay .lo-box{background:var(--s);border:1px solid var(--b);border-radius:8px;padding:20px 28px;text-align:center}
.loading-overlay .lo-box .sp{width:28px;height:28px;border:2px solid var(--b);border-top-color:var(--a);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 10px}
</style>
</head>
<body>
<div class="app">
<div class="ts" id="toolSwitcher"></div>
<div class="hdr">
  <h1>${SVG.bolt} Token 看板</h1>
  <div class="ac">
    <button class="btn bi" id="themeBtn">${SVG.sun}</button>
    <button class="btn bi" id="settingsBtn">${SVG.gear}</button>
  </div>
</div>

<div id="filters" class="fb"></div>
<div id="main"></div>

<!-- Settings Modal -->
<div class="modal-overlay" id="settingsModal">
  <div class="modal">
    <h2>${SVG.gear} 设置</h2>
    <div id="settingsBody"></div>
  </div>
</div>

<div class="tp" id="tp"></div>

<div class="loading-overlay" id="loadingOverlay"><div class="lo-box"><div class="sp"></div><div style="font-size:13px;color:var(--t2)">加载中...</div></div></div>
</div>

<script>
const $ = id => document.getElementById(id);
const api = async p => { const r=await fetch(p); if(!r.ok)throw new Error(await r.text()); return r.json(); };

const COLORS = ['#06b6d4','#f59e0b','#10b981','#f43f5e','#8b5cf6','#ec4899','#14b8a6','#e9730f','#6366f1','#84cc16','#d946ef','#22c55e'];
const fmt = v => v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v);
function darkenColor(hex, f){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return '#'+[r,g,b].map(c=>Math.round(c*f).toString(16).padStart(2,'0')).join('')}
function lightenColor(hex, f){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return '#'+[r,g,b].map(c=>Math.min(255,Math.round(c+(255-c)*f)).toString(16).padStart(2,'0')).join('')}

let data = null, rawData = null;
let chModelHidden = new Set(), chProjectHidden = new Set(), chDailyHidden = new Set(), chModelBarHidden = new Set();
let dateFilter = { type: 'all', start: '', end: '' };
let currentFilteredCells = [];
let currentTool = 'claude';
let traePaths = {};
let refreshInterval = null, switchingTool = false;
// Calendar state
let calState = { year: 0, month: 0, start: null, end: null };

function fmtDate(d){const n=new Date(d);return n.toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}

function renderToolSwitcher() {
  const el = $('toolSwitcher');
  if (!el) return;
  el.innerHTML = '<span class="tc'+(currentTool==='claude'?' act':'')+'" data-tool="claude">Claude Code</span>'
    +'<span class="tc'+(currentTool==='trae-intl'?' act':'')+'" data-tool="trae-intl">Trae</span>'
    +'<span class="tc'+(currentTool==='trae-cn'?' act':'')+'" data-tool="trae-cn">Trae CN</span>';
}

// ===== Calendar date range picker =====
function fmtISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function parseISO(s){const p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2])}

function toggleCal(anchor) {
  let el = $('calPopup');
  if (el) { el.remove(); return; }
  const now = new Date();
  calState.year = now.getFullYear();
  calState.month = now.getMonth();
  calState.start = dateFilter.start ? parseISO(dateFilter.start) : null;
  calState.end = dateFilter.end ? parseISO(dateFilter.end) : null;
  renderCal(anchor);
}

function renderCal(anchor) {
  let el = $('calPopup');
  if (!el) { el = document.createElement('div'); el.id = 'calPopup'; el.className = 'cal-popup'; document.body.appendChild(el); }
  const { year: y, month: m, start, end } = calState;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDow = new Date(y, m, 1).getDay();
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  let html = '<div class="cal-hdr"><span class="cal-nav" data-cal-nav="prev">&lt;</span><span class="cal-m">'+y+'年'+monthNames[m]+'</span><span class="cal-nav" data-cal-nav="next">&gt;</span></div>';
  html += '<table><tr><th>日</th><th>一</th><th>二</th><th>三</th><th>四</th><th>五</th><th>六</th></tr><tr>';
  for (let i = 0; i < firstDow; i++) html += '<td></td>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const sStr = start ? fmtISO(start) : '';
    const eStr = end ? fmtISO(end) : '';
    const isStart = sStr === dateStr;
    const isEnd = eStr === dateStr;
    const inRange = sStr && eStr && dateStr >= sStr && dateStr <= eStr;
    let cls = '';
    if (isStart) cls += ' sel in-range-start';
    if (isEnd) cls += ' sel in-range-end';
    if (inRange && !isStart && !isEnd) cls += ' in-range';
    html += '<td><span class="'+cls+'" data-cal-date="'+dateStr+'">'+d+'</span></td>';
    if ((firstDow + d) % 7 === 0) html += '</tr><tr>';
  }
  html += '</tr></table>';
  el.innerHTML = html;
  const rect = anchor.getBoundingClientRect();
  el.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  el.style.top = (rect.bottom + 4) + 'px';
  el.style.display = 'block';
}

function handleCalClick(target) {
  if (target.hasAttribute('data-cal-nav')) {
    const dir = target.getAttribute('data-cal-nav');
    if (dir === 'prev') { calState.month--; if (calState.month < 0) { calState.month = 11; calState.year--; } }
    else { calState.month++; if (calState.month > 11) { calState.month = 0; calState.year++; } }
    renderCal(document.querySelector('.cal-trigger'));
    return;
  }
  const dateStr = target.getAttribute('data-cal-date');
  if (!dateStr) return;
  if (!calState.start || (calState.start && calState.end)) {
    calState.start = parseISO(dateStr);
    calState.end = null;
  } else {
    calState.end = parseISO(dateStr);
    if (calState.end < calState.start) { const t = calState.start; calState.start = calState.end; calState.end = t; }
  }
  dateFilter.type = 'range';
  dateFilter.start = calState.start ? fmtISO(calState.start) : '';
  dateFilter.end = calState.end ? fmtISO(calState.end) : '';
  const trig = document.querySelector('.cal-trigger');
  if (trig) {
    const s = dateFilter.start, e = dateFilter.end;
    trig.textContent = (s && e) ? s + ' ~ ' + e : s || '选择日期';
  }
  if (calState.start && calState.end) {
    $('calPopup').remove();
    renderAll();
    renderFilters();
    return;
  }
  renderCal(document.querySelector('.cal-trigger'));
}

async function init(){
  try{
    renderToolSwitcher();
    try { const c = await api('/api/config'); if (c) traePaths = c; } catch(e) {}
    rawData = await api('/api/tokens?tool='+currentTool);
      data = applySettings(rawData);
    renderFilters();
    renderAll();
    updateRefreshTime();
    refreshInterval = setInterval(refreshData, 5000);
  }catch(e){
    $('main').innerHTML='<div class="ld"><h2 style="font-size:16px;margin-bottom:8px">加载失败</h2><p>'+e.message+'</p></div>';
  }
}

function updateRefreshTime() {
  const el = $('updateTime');
  if (el) el.textContent = new Date().toLocaleTimeString('zh-CN');
}

async function refreshData() {
  if (switchingTool) return;
  try {
    const newRaw = await api('/api/tokens?tool='+currentTool);
    rawData = newRaw;
    data = applySettings(rawData);
    renderFilters();
    renderAll();
    updateRefreshTime();
  } catch(e) {
    console.error('Refresh failed:', e);
  }
}

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function getFilteredCells() {
  let cells = data.cells;
  const today = new Date();
  const todayStr = today.toISOString().substring(0,10);
  if (dateFilter.type === 'today') {
    cells = cells.filter(c => c.date === todayStr);
  } else if (dateFilter.type === 'yesterday') {
    const d = new Date(); d.setDate(d.getDate() - 1);
    cells = cells.filter(c => c.date === d.toISOString().substring(0,10));
  } else if (dateFilter.type === 'daybefore') {
    const d = new Date(); d.setDate(d.getDate() - 2);
    cells = cells.filter(c => c.date === d.toISOString().substring(0,10));
  } else if (dateFilter.type === 'month') {
    const now = new Date();
    const firstStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().substring(0,10);
    const lastStr = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().substring(0,10);
    cells = cells.filter(c => c.date >= firstStr && c.date <= lastStr);
  } else if (dateFilter.type === 'range') {
    if (dateFilter.start) cells = cells.filter(c => c.date >= dateFilter.start);
    if (dateFilter.end) cells = cells.filter(c => c.date <= dateFilter.end);
  }
  return cells;
}

// ===== 筛选状态显示 =====
function renderFilters(){
  const presets = [
    { key:'all', label:'全部' },
    { key:'today', label:'今天' },
    { key:'yesterday', label:'昨天' },
    { key:'daybefore', label:'前天' },
    { key:'month', label:'当月' },
  ];

  let html = '';
  for (const p of presets) {
    html += '<span class="fc'+(dateFilter.type===p.key?' act':'')+'" data-date="'+p.key+'">'+p.label+'</span>';
  }
  const rangeLabel = (dateFilter.start && dateFilter.end) ? dateFilter.start+' ~ '+dateFilter.end : '选择日期';
  html += '<span class="fc cal-trigger'+(dateFilter.type==='range'?' act':'')+'" id="calTrigger">'+rangeLabel+'</span>';
  html += '<span style="font-size:12px;color:var(--t2);margin-left:auto;display:flex;align-items:center;gap:6px">'
    +'<span id="updateTime">--:--:--</span>'
    +'<span class="fc" id="refreshBtn" style="font-size:12px;cursor:pointer">⟳ 刷新</span></span>';

  $('filters').innerHTML = html;

  $('calTrigger').onclick = function(e) {
    e.stopPropagation();
    toggleCal(this);
  };
  const rb = $('refreshBtn');
  if (rb) rb.onclick = refreshData;
}

// ===== 数据聚合（总数据） =====
function getModelTotals(cells){
  const m = {};
  for(const c of cells){
    if(!m[c.model]) m[c.model]={name:c.model,total:0,input:0,output:0,cacheRead:0,cacheCreate:0};
    m[c.model].total+=c.total; m[c.model].input+=c.input; m[c.model].output+=c.output;
    m[c.model].cacheRead+=c.cacheRead; m[c.model].cacheCreate+=c.cacheCreate;
  }
  return Object.values(m).sort((a,b)=>b.total-a.total);
}
function getProjectTotals(cells){
  const m = {};
  for(const c of cells){
    if(!m[c.project]) m[c.project]={name:c.project,total:0,input:0,output:0,cacheRead:0,cacheCreate:0};
    m[c.project].total+=c.total; m[c.project].input+=c.input; m[c.project].output+=c.output;
    m[c.project].cacheRead+=c.cacheRead; m[c.project].cacheCreate+=c.cacheCreate;
  }
  return Object.values(m).sort((a,b)=>b.total-a.total);
}

// ===== 渲染 =====
function renderAll(){
  currentFilteredCells = getFilteredCells();
  const allCells = currentFilteredCells;
  const grandTotal = allCells.reduce((s,c)=>s+c.total,0);
  const days = new Set(allCells.map(c=>c.date)).size;
  const models = new Set(allCells.map(c=>c.model)).size;
  const projects = new Set(allCells.map(c=>c.project)).size;
  const sessions = new Set(allCells.map(c=>c.date+'|'+c.sessionId)).size;
  const totalInput = allCells.reduce((s,c)=>s+c.input,0);
  const totalCacheRead = allCells.reduce((s,c)=>s+c.cacheRead,0);
  const totalCacheCreate = allCells.reduce((s,c)=>s+c.cacheCreate,0);
  const cacheRate = totalInput+totalCacheRead > 0 ? (totalCacheRead/(totalInput+totalCacheRead)*100).toFixed(1) : '0.0';

  let html = '<div class="sg">'
    +'<div class="sc"><div class="v ac">'+fmt(grandTotal)+'</div><div class="l">Token</div>'
      +'<div class="s">'+sessions+' 会话 · '+days+' 天</div><div class="bar" style="width:100%"></div></div>'
    +'<div class="sc"><div class="v">'+days+'</div><div class="l">活跃天数</div>'
      +'<div class="s">'+models+' 模型 · '+projects+' 项目</div></div>'
    +'<div class="sc"><div class="v">'+models+'</div><div class="l">模型数</div>'
      +'<div class="s">隐藏 '+(chModelHidden.size||'0')+'</div></div>'
    +'<div class="sc"><div class="v">'+projects+'</div><div class="l">项目数</div>'
      +'<div class="s">隐藏 '+(chProjectHidden.size||'0')+'</div></div>'
    +'<div class="sc"><div class="v" style="color:'+(cacheRate>0?'#10b981':'var(--t2)')+'">'+cacheRate+'%</div><div class="l">缓存命中率</div>'
      +'<div class="s">命中 '+fmt(totalCacheRead)+' · 创建 '+fmt(totalCacheCreate)+'</div></div></div>';

  // Daily bar chart
  const hasCache = allCells.some(c => c.cacheRead > 0 || c.cacheCreate > 0);
  html += '<div class="cc" style="height:480px"><h3>${SVG.bar} 每日 Token 趋势</h3><div class="legend" id="legDaily" style="margin-bottom:8px;max-height:40px"></div><canvas id="chDaily" style="display:block;width:100%;height:340px"></canvas>';
  html += '<div style="display:flex;gap:14px;justify-content:center;margin-top:10px;flex-wrap:wrap;font-size:12px;color:var(--t2)">';
  if (hasCache) {
    html += '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#06b6d4;display:inline-block"></span> 输入（未命中缓存）</span>'
      +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#76d7e7;display:inline-block"></span> 输入（命中缓存）</span>'
      +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#38c5dd;display:inline-block"></span> 输出</span>';
  } else {
    html += '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#06b6d4;display:inline-block"></span> 输入</span>'
      +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#38c5dd;display:inline-block"></span> 输出</span>';
  }
  html += '</div></div>';

  const byModel = getModelTotals(allCells);

  if (currentTool === 'claude') {
    const byProject = getProjectTotals(allCells);

    html += '<div class="cc"><h3>${SVG.pie} 模型 & 项目分布</h3><div class="pr">'
      +'<div class="pie-wrap"><canvas id="chModel"></canvas>'
      +'<div class="pl">'+fmt(byModel.reduce((s,m)=>s+m.total,0))+' Token · '+(byModel.length-(chModelHidden.size||0))+'/'+byModel.length+' 显示</div>'
      +'<div class="legend" id="legModel"></div></div>'
      +'<div class="pie-wrap"><canvas id="chProject"></canvas>'
      +'<div class="pl">'+fmt(byProject.reduce((s,m)=>s+m.total,0))+' Token · '+(byProject.length-(chProjectHidden.size||0))+'/'+byProject.length+' 显示</div>'
      +'<div class="legend" id="legProject"></div></div>'
      +'</div></div>';
  }

  // Model total bar chart (all tools)
  html += '<div class="cc"><h3>${SVG.bar} 模型 Token 总量</h3><div class="legend" id="legModelBar" style="margin-bottom:8px;max-height:40px"></div><div class="cw" style="min-height:'+Math.max(60,byModel.length*44+40)+'px"><canvas id="chModelBar"></canvas></div>'
    +'<div style="display:flex;gap:14px;justify-content:center;margin-top:8px;flex-wrap:wrap;font-size:12px;color:var(--t2)">'
    +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:var(--a);display:inline-block"></span> 输入</span>'
    +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:'+(hasCache?'#76d7e7':'var(--a)')+';display:inline-block"></span> '+(hasCache?'输入(缓存命中)':'')+'</span>'
    +'<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:2px;background:#38c5dd;display:inline-block"></span> 输出</span>'
    +'</div></div>';

  $('main').innerHTML = html;
  drawDaily(allCells);
  if (currentTool === 'claude') {
    const bm = getModelTotals(allCells);
    const bp = getProjectTotals(allCells);
    ctxPie('chModel', bm, m=>m.name, m=>m.total, chModelHidden);
    ctxPie('chProject', bp, m=>m.name, m=>m.total, chProjectHidden);
  }
  drawModelBars(byModel);
}

// ===== Canvas 堆叠条形图 =====
function drawDaily(dateFilteredCells){
  const canvas = $('chDaily');
  if(!canvas) return;
  const dateCells = dateFilteredCells;
  let cells = dateFilteredCells.filter(c => !chDailyHidden.has(c.model));
  const dates = [...new Set(cells.map(c=>c.date))].sort();
  const grouped = {};
  for(const c of cells){
    if(!grouped[c.date]) grouped[c.date]={};
    if(!grouped[c.date][c.model]) grouped[c.date][c.model]={input:0,output:0,cache:0,cacheRead:0};
    grouped[c.date][c.model].input+=c.input;
    grouped[c.date][c.model].output+=c.output;
    grouped[c.date][c.model].cacheRead+=c.cacheRead;
    grouped[c.date][c.model].cache+=c.cacheRead+c.cacheCreate;
  }

  const hasCache = dateFilteredCells.some(c => c.cacheRead > 0 || c.cacheCreate > 0);
  const parent = canvas.parentElement;
  parent.style.setProperty('height', '480px', 'important');
  const rect = parent.getBoundingClientRect();
  const W = Math.max(rect.width,400), H = 340;
  const dpr = window.devicePixelRatio||1;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr,dpr);

  const isDark = document.documentElement.getAttribute('data-theme')==='dark';
  const tc = isDark?'#a8a29e':'#78716c', gc = isDark?'#292524':'#e7e5e4';
  const pad={top:16,bottom:65,left:48,right:14};
  const cw=W-pad.left-pad.right, ch=H-pad.top-pad.bottom;

  ctx.clearRect(0,0,W,H);
  if(!dates.length){ctx.fillStyle=tc;ctx.font='14px sans-serif';ctx.textAlign='center';ctx.fillText('暂无数据',W/2,H/2);return;}

  const maxVal = Math.max(...dates.map(d=>{
    const dd = grouped[d]||{}; return Object.values(dd).reduce((s,x)=>s+x.input+x.output+x.cache,0);
  }),1);
  const allModelNames = dateCells ? [...new Set(dateCells.map(c=>c.model))] : [...new Set(cells.map(c=>c.model))];

  // Grid
  ctx.strokeStyle=gc; ctx.lineWidth=0.5;
  for(let i=0;i<=4;i++){const y=pad.top+ch*i/4; ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(W-pad.right,y);ctx.stroke();
    ctx.fillStyle=tc;ctx.font='13px sans-serif';ctx.textAlign='right';ctx.fillText(fmt(maxVal*(4-i)/4),pad.left-6,y+4);}

  const n = dates.length, bw = Math.min(cw / n * 0.7, 48), gap = cw / n;
  const hoverGroupKey = canvas._hoverGroupKey || '';
  const groupMap = {};

  for(let i=0;i<n;i++){
    const d = dates[i];
    const dd = grouped[d]||{};
    const models = Object.entries(dd);
    let yOff = 0;
    const x = pad.left+i*gap+(gap-bw)/2;

    for(const [model,vals] of models){
      const hi = vals.input/maxVal*ch;
      const ho = vals.output/maxVal*ch;
      const hc = vals.cache/maxVal*ch;
      const yBase = pad.top+ch-yOff;

      // Model colour + shades for input/output/cache
      const mi = allModelNames.indexOf(model);
      const baseColor = COLORS[mi % COLORS.length];
      const segs = hasCache ? [
        { type:'cache',  h:hc, v:vals.cache,  color:lightenColor(baseColor,0.45),y:yBase-hc,            label:'输入（命中缓存）',cacheRead:vals.cacheRead },
        { type:'input',  h:hi, v:vals.input,  color:baseColor,                   y:yBase-hc-hi,         label:'输入（未命中缓存）' },
        { type:'output', h:ho, v:vals.output, color:lightenColor(baseColor,0.2), y:yBase-hc-hi-ho,      label:'输出' },
      ] : [
        { type:'input',  h:hi+hc, v:vals.input+vals.cache, color:baseColor,                   y:yBase-hi-hc,         label:'输入' },
        { type:'output', h:ho,    v:vals.output,            color:lightenColor(baseColor,0.2), y:yBase-hi-hc-ho,     label:'输出' },
      ];
      const gk = d+'|'+model;
      const visibleSegs = segs.filter(s => s.h > 0.5);
      const isGroupHov = gk === hoverGroupKey;

      // Store group for hover
      if (visibleSegs.length) {
        groupMap[gk] = { date:d, model, x, w:bw, segs: visibleSegs };
      }

      // Draw segments
      for(const seg of segs){
        if(seg.h > 0.5){
          if(isGroupHov){
            ctx.shadowColor = 'rgba(255,255,255,0.25)';
            ctx.shadowBlur = 8;
            ctx.fillStyle = seg.color;
            roundRect(ctx, x-1, seg.y-1, bw+2, seg.h+2, 3);
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            ctx.fillStyle = seg.color;
            roundRect(ctx, x, seg.y, bw, seg.h, 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
      yOff += hi+ho+hc;
    }

    // Value
    const dayTotal = models.reduce((s,[,v])=>s+v.input+v.output+v.cache,0);
    ctx.fillStyle=tc; ctx.font='12px sans-serif'; ctx.textAlign='center';
    ctx.fillText(fmt(dayTotal),x+bw/2,pad.top+ch+20);

    // Date
    ctx.save();
    const manyDates = n > 6;
    if (manyDates) {
      ctx.translate(x+bw/2, pad.top+ch+42);
      ctx.rotate(-0.55);
      ctx.font='12px sans-serif'; ctx.textAlign='right';
    } else {
      ctx.translate(x+bw/2, pad.top+ch+42);
      ctx.font='12px sans-serif'; ctx.textAlign='center';
    }
    ctx.fillStyle=tc;
    ctx.fillText(fmtDate(d),0,0);
    ctx.restore();
  }

  canvas._groupMap = groupMap;
  canvas._pad = pad;
  canvas._ch = ch;
  canvas._maxVal = maxVal;

  if (!canvas._hoverInit) {
    canvas._hoverInit = true;
    canvas.addEventListener('mousemove', function(e) {
      const rect = this.getBoundingClientRect();
      const sx = this.width / rect.width, sy = this.height / rect.height;
      const mx = (e.clientX - rect.left) * sx / dpr;
      const my = (e.clientY - rect.top) * sy / dpr;
      const gm = this._groupMap || {};
      const tp = $('tp');
      const keys = Object.keys(gm);
      if (!keys.length) {
        if (this._hoverGroupKey) { this._hoverGroupKey = ''; tp.classList.remove('show'); if(this._chartData)drawDaily(this._chartData); }
        return;
      }
      let hitKey = '';
      for (const k of keys) {
        const g = gm[k];
        for (const s of g.segs) {
          if (mx >= g.x && mx <= g.x + g.w && my >= s.y && my <= s.y + s.h) { hitKey = k; break; }
        }
        if (hitKey) break;
      }
      if (hitKey !== this._hoverGroupKey) {
        this._hoverGroupKey = hitKey;
        if (hitKey) {
          const g = gm[hitKey];
          const totalTokens = g.segs.reduce((s, seg) => s + seg.v, 0);
          let html = '<strong>'+esc(g.date)+'</strong> '+esc(g.model)+'<br>总计: '+fmt(totalTokens)+' Token<br>';
          let cacheRead = 0, inputV = 0;
          for (const s of g.segs) { if (s.cacheRead) cacheRead += s.cacheRead; if (s.type === 'input') inputV = s.v; }
          for (const s of g.segs) {
            html += esc(s.label)+': '+fmt(s.v)+' Token<br>';
          }
          if (cacheRead > 0 && cacheRead+inputV > 0) {
            html += '缓存命中率: '+(cacheRead/(cacheRead+inputV)*100).toFixed(1)+'%';
          }
          tp.innerHTML = html;
          tp.classList.add('show');
        } else {
          tp.classList.remove('show');
        }
        drawDaily(this._chartData);
      }
      if (hitKey) {
        tp.style.left = (e.clientX + 14) + 'px';
        tp.style.top = (e.clientY - 12) + 'px';
      }
    });
    canvas.addEventListener('mouseleave', function() {
      if (this._hoverGroupKey) { this._hoverGroupKey = ''; $('tp').classList.remove('show'); drawDaily(this._chartData || dateFilteredCells); }
    });
  }
  canvas._chartData = dateFilteredCells;

  // Update daily legend
  const dl = $('legDaily');
  if (dl) {
    const allModels = dateCells ? [...new Set(dateCells.map(c=>c.model))] : [];
    let lh = '';
    for (let i = 0; i < allModels.length; i++) {
      const n = allModels[i];
      const hidden = chDailyHidden.has(n);
      lh += '<span class="li'+(hidden?'':' act')+'" data-filter="daily:'+esc(n)+'">'
        +'<span class="d" style="background:'+COLORS[i%COLORS.length]+';'+(hidden?'opacity:0.3':'')+'"></span>'
        +'<span style="'+(hidden?'opacity:0.4;text-decoration:line-through':'')+'">'+esc(n)+'</span>'
        +'</span>';
    }
    dl.innerHTML = lh;
  }
}

function roundRect(ctx,x,y,w,h,r){
  if(h<1) return;
  r=Math.min(r,w/2,h/2,3);
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.fill();
}

// ===== 水平堆叠条形图（模型总量） =====
function drawModelBars(models){
  const canvas = $('chModelBar'); if(!canvas) return;
  const visibleModels = models.filter(m => !chModelBarHidden.has(m.name));
  const hasCache = models.some(m => m.cacheRead > 0);
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = Math.max(rect.width, 400);
  const rowH = 44, padL = 140, padR = 80, padTop = 20, padBottom = 16;
  const H = Math.max(60, visibleModels.length * rowH + padTop + padBottom);
  const dpr = window.devicePixelRatio||1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  // Fix container height to match filtered content
  canvas.parentElement.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const isDark = document.documentElement.getAttribute('data-theme')==='dark';
  const tc = isDark?'#a8a29e':'#78716c', gc = isDark?'#292524':'#e7e5e4';
  const bw = W - padL - padR;
  ctx.clearRect(0,0,W,H);
  if(!visibleModels.length){ctx.fillStyle=tc;ctx.font='14px sans-serif';ctx.textAlign='center';ctx.fillText('暂无数据',W/2,H/2);return;}
  const maxTotal = Math.max(...visibleModels.map(m=>m.total),1);

  // Model name legend (toggle filter)
  const leg = $('legModelBar');
  if (leg) {
    let lh = '';
    for(let i=0;i<models.length;i++){
      const m = models[i];
      const color = COLORS[i % COLORS.length];
      const hidden = chModelBarHidden.has(m.name);
      lh += '<span class="li'+(hidden?'':' act')+'" data-filter="modelbar:'+esc(m.name)+'">'
        +'<span class="d" style="background:'+color+';'+(hidden?'opacity:0.3':'')+'"></span>'
        +'<span style="'+(hidden?'opacity:0.4;text-decoration:line-through':'')+'">'+esc(m.name)+'</span>'
        +'</span>';
    }
    leg.innerHTML = lh;
  }

  // Hover state
  const hoverKey = canvas._hoverKey || '';
  const groupMap = {};

  for(let i=0;i<visibleModels.length;i++){
    const m = visibleModels[i];
    const y = padTop + i * rowH;
    const barH = Math.min(rowH-10, 30);
    const baseColor = COLORS[i % COLORS.length];
    const pctOfTotal = (m.total / maxTotal * 100).toFixed(1);

    // Row hover background
    if(hoverKey === m.name){
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)';
      roundRect(ctx, padL, y-2, bw, rowH-2, 4);
    }

    // Model name
    ctx.fillStyle = hoverKey === m.name ? (isDark?'#fff':'#000') : tc;
    ctx.font = (hoverKey === m.name ? 'bold ':'') + '13px sans-serif';
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(m.name, padL-8, y+barH/2);

    // Segments
    const iw = m.input / maxTotal * bw;
    const cw2 = m.cacheRead / maxTotal * bw;
    const ow = m.output / maxTotal * bw;
    const x0 = padL;

    const inputColor = baseColor;
    const cacheColor = lightenColor(baseColor, 0.45);
    const outputColor = lightenColor(baseColor, 0.2);

    const segs = [];
    if(iw > 2) segs.push({type:'input', x:x0, w:iw, color:inputColor, label:'输入', val:m.input});
    if(cw2 > 2) segs.push({type:'cache', x:x0+iw, w:cw2, color:cacheColor, label:'输入(缓存命中)', val:m.cacheRead});
    if(ow > 2) segs.push({type:'output', x:x0+iw+cw2, w:ow, color:outputColor, label:'输出', val:m.output});

    // Bar background track
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    roundRect(ctx, x0, y, bw, barH, 3);

    // Draw segments
    for(const seg of segs){
      if(hoverKey === m.name){
        ctx.save();
        ctx.shadowColor = 'rgba(255,255,255,0.25)';
        ctx.shadowBlur = 8;
        ctx.fillStyle = seg.color;
        roundRect(ctx, seg.x, y-1, seg.w, barH+2, 3);
        ctx.shadowBlur = 0;
        ctx.restore();
      } else {
        ctx.fillStyle = seg.color;
        roundRect(ctx, seg.x, y, seg.w, barH, 2);
      }
    }

    // Store geometry for hover
    // Store all data for tooltip (regardless of width thresholds)
    groupMap[m.name] = { model: m.name, y, barH, segs, total: m.total, inputTotal: m.input + m.cacheRead, cacheReadTotal: m.cacheRead,
      allSegs: [
        { type:'input',  label:'输入',              val:m.input },
        { type:'cache',  label:'输入(缓存命中)',      val:m.cacheRead },
        { type:'output', label:'输出',              val:m.output },
      ].filter(s => s.val > 0) };

    // Total value label on right
    ctx.fillStyle=tc; ctx.font='13px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(fmt(m.total), x0+bw+8, y+barH/2);

    // Percentage of total
    ctx.fillStyle = isDark?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.25)';
    ctx.font='11px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(pctOfTotal+'%', x0+bw+8, y+barH/2+15);
  }

  canvas._groupMap = groupMap;
  canvas._chartData = models; // store original for redraw

  // Hover events
  if (!canvas._hoverInit) {
    canvas._hoverInit = true;
    canvas.addEventListener('mousemove', function(e) {
      const rect = this.getBoundingClientRect();
      const sx = this.width / rect.width, sy = this.height / rect.height;
      const mx = (e.clientX - rect.left) * sx / dpr;
      const my = (e.clientY - rect.top) * sy / dpr;
      const gm = this._groupMap || {};
      const tp = $('tp');
      const keys = Object.keys(gm);
      if (!keys.length) {
        if (this._hoverKey) { this._hoverKey = ''; tp.classList.remove('show'); drawModelBars(this._chartData||models); }
        return;
      }
      let hitKey = '';
      for (const k of keys) {
        const g = gm[k];
        for (const s of g.segs) {
          if (mx >= s.x && mx <= s.x + s.w && my >= g.y && my <= g.y + g.barH) { hitKey = k; break; }
        }
        if (hitKey) break;
      }
      if (hitKey !== this._hoverKey) {
        this._hoverKey = hitKey;
        if (hitKey) {
          const g = gm[hitKey];
          let cacheRead = g.cacheReadTotal || 0, totalInput = g.inputTotal || 0;
          const cacheRate = totalInput > 0 ? (cacheRead/totalInput*100).toFixed(1) : '0.0';
          let html = '<strong>'+esc(g.model)+'</strong><br>总计: '+fmt(g.total)+' Token';
          const displaySegs = g.allSegs || g.segs;
          for (const s of displaySegs) {
            html += '<br>'+esc(s.label)+': '+fmt(s.val)+' Token';
          }
          if (cacheRead > 0 && totalInput > 0) {
            html += '<br>缓存命中率: '+cacheRate+'%';
          }
          tp.innerHTML = html;
          tp.classList.add('show');
        } else {
          tp.classList.remove('show');
        }
        drawModelBars(this._chartData||models);
      }
      if (hitKey) {
        tp.style.left = (e.clientX + 14) + 'px';
        tp.style.top = (e.clientY - 12) + 'px';
      }
    });
    canvas.addEventListener('mouseleave', function() {
      if (this._hoverKey) { this._hoverKey = ''; $('tp').classList.remove('show'); drawModelBars(this._chartData||models); }
    });
  }
}

// ===== Canvas 饼图（通用，支持独立隐藏 + 悬浮弹出） =====
function ctxPie(canvasId, items, nameFn, valFn, hiddenSet){
  const canvas = $(canvasId); if(!canvas) return;
  const dimKey = canvasId + '_dim';
  let W, H;
  if (canvas[dimKey]) {
    W = canvas[dimKey].W; H = canvas[dimKey].H;
  } else {
    const rect = canvas.parentElement.getBoundingClientRect();
    W = Math.max(rect.width, 220); H = 220;
    canvas[dimKey] = { W, H };
  }
  const dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const tc=isDark?'#a8a29e':'#78716c';
  const cx=W/2, cy=H/2-6, rad=Math.min(W/2-16,H/2-16,120), ir=rad*0.38;

  ctx.clearRect(0,0,W,H);

  const visible = items.filter(i => valFn(i)>0 && !hiddenSet.has(nameFn(i)));
  const total = visible.reduce((s,i)=>s+valFn(i),0);
  const hoverIdx = typeof canvas._hoverIdx === 'number' ? canvas._hoverIdx : -1;
  const slices = [];

  if(!visible.length){
    ctx.fillStyle=tc;ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('全部隐藏',cx,cy);
  } else {
    let sa = -Math.PI/2;
    for(let idx=0; idx<visible.length; idx++){
      const item = visible[idx];
      const v = valFn(item), ang = v/total*Math.PI*2;
      const color = COLORS[idx % COLORS.length];
      const isHov = idx === hoverIdx;
      const off = isHov ? 10 : 0;
      const mid = sa + ang/2;
      const ox = Math.cos(mid) * off;
      const oy = Math.sin(mid) * off;

      slices.push({ name: nameFn(item), value: v, total, ang, start: sa, end: sa+ang, color });

      ctx.beginPath();
      ctx.moveTo(cx+ox+Math.cos(sa)*ir, cy+oy+Math.sin(sa)*ir);
      ctx.arc(cx+ox, cy+oy, rad, sa, sa+ang);
      ctx.arc(cx+ox, cy+oy, ir, sa+ang, sa, true);
      ctx.closePath();
      const g = ctx.createRadialGradient(cx+ox, cy+oy, ir, cx+ox, cy+oy, rad);
      g.addColorStop(0, color+(isHov?'ff':'cc'));
      g.addColorStop(1, color);
      ctx.fillStyle = g;
      ctx.fill();

      if(isHov){
        ctx.shadowColor = 'rgba(255,255,255,0.25)';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      sa += ang;
    }

    ctx.fillStyle=isDark?'#e7e5e4':'#1c1917';
    ctx.font='bold 17px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(fmt(total),cx,cy-5);
    ctx.fillStyle=tc; ctx.font='12px sans-serif'; ctx.fillText('Token',cx,cy+10);
  }

  canvas._slices = slices;
  canvas._cx = cx; canvas._cy = cy; canvas._ir = ir; canvas._rad = rad;
  canvas._chartData = { items, nameFn, valFn, hiddenSet };

  if (!canvas._hoverInit) {
    canvas._hoverInit = true;
    canvas.addEventListener('mousemove', function(e) {
      const rect = this.getBoundingClientRect();
      const sx = this.width / rect.width, sy = this.height / rect.height;
      const mx = (e.clientX - rect.left) * sx / dpr;
      const my = (e.clientY - rect.top) * sy / dpr;
      const slices = this._slices;
      const tp = $('tp');
      if (!slices || !slices.length) {
        if (this._hoverIdx >= 0) { this._hoverIdx = -1; tp.classList.remove('show'); if(this._chartData)ctxPie(this.id,this._chartData.items,this._chartData.nameFn,this._chartData.valFn,this._chartData.hiddenSet); }
        return;
      }
      const dx = mx - this._cx, dy = my - this._cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      let hit = -1;
      if (dist >= this._ir && dist <= this._rad) {
        let a = Math.atan2(dy, dx);
        if (a < -Math.PI/2) a += Math.PI * 2;
        for (let i = 0; i < slices.length; i++) {
          if (a >= slices[i].start && a <= slices[i].end) { hit = i; break; }
        }
      }
      if (hit !== this._hoverIdx) {
        this._hoverIdx = hit;
        if (hit >= 0) {
          const s = slices[hit];
          tp.innerHTML = '<strong>'+esc(s.name)+'</strong><br>'+fmt(s.value)+' Token<br>占比 '+(s.value/s.total*100).toFixed(1)+'%';
        } else {
          tp.classList.remove('show');
        }
        if (this._chartData) ctxPie(this.id, this._chartData.items, this._chartData.nameFn, this._chartData.valFn, this._chartData.hiddenSet);
      }
      if (hit >= 0) {
        tp.style.left = (e.clientX + 14) + 'px';
        tp.style.top = (e.clientY - 12) + 'px';
        tp.classList.add('show');
      }
    });
    canvas.addEventListener('mouseleave', function() {
      if (this._hoverIdx >= 0) { this._hoverIdx = -1; $('tp').classList.remove('show'); if(this._chartData)ctxPie(this.id,this._chartData.items,this._chartData.nameFn,this._chartData.valFn,this._chartData.hiddenSet); }
    });
  }

  	  // Legend (no hide toggle)
	  const legEl=$('leg'+(canvasId==='chModel'?'Model':canvasId==='chProject'?'Project':''));
	  if(!legEl) return;
	  let lh='';
	  for(let i=0;i<items.length;i++){
	    const n=nameFn(items[i]), v=valFn(items[i]);
	    if(v<=0) continue;
	    const pct = total>0 ? (v/total*100).toFixed(1) : '0';
	    lh += '<span class="li act">'
	      +'<span class="d" style="background:'+COLORS[i%COLORS.length]+'"></span>'
	      +'<span>'+esc(n)+'</span>'
	      +'<span class="pct">'+pct+'%</span></span>';
	  }
	  legEl.innerHTML=lh;
}

function short(s,n){return(s||'').length>(n||10)?s.substring(0,n||10)+'...':s||''}

// Theme
$('themeBtn').onclick=function(){
  const h=document.documentElement;
  const t=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',t);
  this.innerHTML=t==='dark'?'${SVG.sun}':'${SVG.moon}';
  try{localStorage.setItem('csd-theme',t)}catch(e){}
  renderAll();
};

// ===== Settings =====
let displayNames = {};
let hiddenProjects = [];

function loadSettings() {
  try {
    const n = localStorage.getItem('csd-names');
    if (n) displayNames = JSON.parse(n);
    const h = localStorage.getItem('csd-hidden');
    if (h) hiddenProjects = JSON.parse(h);
  } catch(e) {}
}
function saveSettings() {
  try {
    localStorage.setItem('csd-names', JSON.stringify(displayNames));
    localStorage.setItem('csd-hidden', JSON.stringify(hiddenProjects));
  } catch(e) {}
}

function applySettings(raw) {
  const d = JSON.parse(JSON.stringify(raw));
  const rename = n => displayNames[n] || n;
  const hide = n => hiddenProjects.includes(n);

  if (hiddenProjects.length) {
    d.cells = d.cells.filter(c => !hide(c.project));
    d.modelProject = d.modelProject.filter(m => !hide(m.project));
  }

  for (const c of d.cells) c.project = rename(c.project);
  for (const m of d.modelProject) m.project = rename(m.project);

  const cm = {};
  for (const c of d.cells) {
    const k = c.date + '|' + c.model + '|' + c.project;
    if (!cm[k]) cm[k] = { date: c.date, model: c.model, project: c.project, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, sessions: 0 };
    const x = cm[k];
    x.input += c.input; x.output += c.output; x.cacheRead += c.cacheRead; x.cacheCreate += c.cacheCreate; x.total += c.total;
  }
  d.cells = Object.values(cm);

  const pm = {};
  for (const c of d.cells) {
    if (!pm[c.project]) pm[c.project] = { name: c.project, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const p = pm[c.project];
    p.total += c.total; p.input += c.input; p.output += c.output; p.cacheRead += c.cacheRead; p.cacheCreate += c.cacheCreate;
  }
  const gt = d.cells.reduce((s, c) => s + c.total, 0);
  d.projects = Object.values(pm).sort((a, b) => b.total - a.total).map(p => ({ ...p, sessions: 0, share: gt > 0 ? (p.total / gt * 100).toFixed(1) : '0' }));

  const mpm = {};
  for (const c of d.cells) {
    const k = c.model + '|' + c.project;
    if (!mpm[k]) mpm[k] = { model: c.model, project: c.project, total: 0, sessions: 0 };
    mpm[k].total += c.total;
  }
  d.modelProject = Object.values(mpm).sort((a, b) => b.total - a.total);

  d.dates = [...new Set(d.cells.map(c => c.date))].sort();
  d.summary.grandTotal = gt;
  d.summary.totalDays = d.dates.length;
  d.summary.totalProjects = d.projects.length;
  d.summary.totalRecords = d.cells.length;
  return d;
}

function renderSettings() {
  let h = '';
  if (currentTool === 'claude') {
    h += '<div class="msec"><h4>项目设置</h4><div style="font-size:11px;color:var(--t2);margin-bottom:8px">勾选=显示，取消勾选=隐藏 | 输入框可修改显示名称</div>';
    for (const p of rawData.projects) {
      const cur = displayNames[p.name] || '';
      const checked = !hiddenProjects.includes(p.name);
      h += '<div class="mrow"><input type="checkbox" class="sshow" data-orig="'+esc(p.name)+'" '+(checked?'checked':'')+'>'
        +'<label title="'+esc(p.name)+'">'+esc(p.name)+'</label>'
        +'<input type="text" class="sname" data-orig="'+esc(p.name)+'" value="'+esc(cur)+'" placeholder="'+esc(p.name)+'"></div>';
    }
    h += '</div>';
  } else if (currentTool === 'trae-intl') {
    h += '<div class="msec"><h4>Trae 日志路径</h4><div style="font-size:11px;color:var(--t2);margin-bottom:8px">留空则使用默认路径</div>';
    h += '<div class="mrow"><label>Trae 路径</label><input type="text" id="traeIntlPath" value="'+esc(traePaths['trae-intl']||'')+'" placeholder="默认: %APPDATA%\\Trae"></div>';
    h += '</div>';
  } else if (currentTool === 'trae-cn') {
    h += '<div class="msec"><h4>Trae CN 日志路径</h4><div style="font-size:11px;color:var(--t2);margin-bottom:8px">留空则使用默认路径</div>';
    h += '<div class="mrow"><label>Trae CN 路径</label><input type="text" id="traeCnPath" value="'+esc(traePaths['trae-cn']||'')+'" placeholder="默认: %APPDATA%\\Trae CN"></div>';
    h += '</div>';
  }
  h += '<div class="mb"><button class="btn" id="settingsCancel">取消</button><button class="btn" id="settingsSave" style="background:var(--a);color:#fff;border-color:var(--a)">保存</button></div>';
  $('settingsBody').innerHTML = h;

  $('settingsCancel').onclick = () => { $('settingsModal').classList.remove('show'); };
  $('settingsSave').onclick = () => {
    displayNames = {};
    hiddenProjects = [];
    document.querySelectorAll('.sshow').forEach(el => {
      if (!el.checked) hiddenProjects.push(el.getAttribute('data-orig'));
    });
    document.querySelectorAll('.sname').forEach(el => {
      const v = el.value.trim();
      if (v && v !== el.getAttribute('data-orig')) displayNames[el.getAttribute('data-orig')] = v;
    });
    if (currentTool !== 'claude') {
      const newPaths = {};
      if (currentTool === 'trae-intl') {
        const p = $('traeIntlPath').value.trim();
        if (p) newPaths['trae-intl'] = p;
      } else if (currentTool === 'trae-cn') {
        const p = $('traeCnPath').value.trim();
        if (p) newPaths['trae-cn'] = p;
      }
      fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(newPaths) });
      traePaths = newPaths;
    }
    saveSettings();
    data = applySettings(rawData);
    $('settingsModal').classList.remove('show');
    chModelHidden = new Set(); chProjectHidden = new Set();
    renderAll();
  };
}

$('settingsBtn').onclick = function() {
  renderSettings();
  $('settingsModal').classList.add('show');
};
$('settingsModal').onclick = function(e) { if (e.target === this) this.classList.remove('show'); };

// ===== Delegated click handler =====
document.addEventListener('click', function(e) {
  const tc = e.target.closest('.tc[data-tool]');
  if (tc) {
    const tool = tc.getAttribute('data-tool');
    if (tool === currentTool) return;
    currentTool = tool;
    renderToolSwitcher();
    chModelHidden=new Set(); chProjectHidden=new Set(); chDailyHidden=new Set(); chModelBarHidden=new Set();
    dateFilter={type:'all',start:'',end:''};
    switchingTool = true;
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    $('loadingOverlay').classList.add('show');
    (async () => {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 20000);
        rawData = await fetch('/api/tokens?tool='+currentTool, { signal: controller.signal }).then(r => { clearTimeout(tid); if (!r.ok) throw new Error(r.statusText); return r.json(); });
        data = applySettings(rawData);
        renderFilters();
        renderAll();
      } catch(e) { $('main').innerHTML='<div class="ld"><h2>加载失败</h2><p>'+(e.name==='AbortError'?'请求超时':e.message)+'</p></div>'; }
      $('loadingOverlay').classList.remove('show');
      switchingTool = false;
      refreshInterval = setInterval(refreshData, 5000);
    })();
    return;
  }
  const fc = e.target.closest('.fc[data-date]');
  if (fc) {
    dateFilter.type = fc.getAttribute('data-date');
    dateFilter.start = '';
    dateFilter.end = '';
    const cp = $('calPopup'); if (cp) cp.remove();
    renderFilters();
    renderAll();
    return;
  }
  const calPopup = $('calPopup');
  if (calPopup && !calPopup.contains(e.target) && !e.target.closest('.cal-trigger')) {
    calPopup.remove();
  }
  if (calPopup && calPopup.contains(e.target)) {
    handleCalClick(e.target);
    return;
  }
  const li = e.target.closest('.li[data-filter]');
  if (!li) return;
  const attr = li.getAttribute('data-filter');
  const sep = attr.indexOf(':');
  const type = attr.substring(0, sep);
  const name = attr.substring(sep + 1);
  if (type === 'daily') {
    if (chDailyHidden.has(name)) chDailyHidden.delete(name);
    else chDailyHidden.add(name);
    drawDaily(currentFilteredCells);
    } else if (type === 'modelbar') {
    if (chModelBarHidden.has(name)) chModelBarHidden.delete(name);
    else chModelBarHidden.add(name);
    drawModelBars(getModelTotals(currentFilteredCells));
    }
});

try{const t=localStorage.getItem('csd-theme');if(t){document.documentElement.setAttribute('data-theme',t);$('themeBtn').innerHTML=t==='dark'?'${SVG.sun}':'${SVG.moon}';}}catch(e){}

loadSettings();
init();
</script>
</body>
</html>`;
}

// ============ HTTP ============

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const ts = new Date().toLocaleTimeString('zh-CN');

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      console.log('  [' + ts + '] 加载页面');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderHTML());
    }
    if (url.pathname === '/api/tokens') {
      const tool = url.searchParams.get('tool') || 'claude';
      console.log('  [' + ts + '] API: Token (' + tool + ')');
      const cfg = TOOL_CONFIGS[tool];
      // Trae needs async parsing
      if (cfg && cfg.type === 'trae_log') {
        return handleTraeApi(tool, res);
      }
      const records = parseAll(tool);
      const report = getTokenReport(records);
      const json = JSON.stringify(report);
      console.log('  -> ' + report.cells.length + ' 条, ' + (json.length/1024).toFixed(1) + 'KB');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(json);
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(loadServerConfig()));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
            delete traeCaches['trae-intl'];
            delete traeCaches['trae-cn'];
            delete traeParsing['trae-intl'];
            delete traeParsing['trae-cn'];
            const ts = new Date().toLocaleTimeString('zh-CN');
            console.log('  [' + ts + '] 设置已保存: ' + JSON.stringify(data));
            res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
        });
        return;
      }
    }
    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleTraeApi(tool, res) {
  const label = (TOOL_CONFIGS[tool] || {}).label || tool;
  const tc = traeCaches[tool];
  if (!tc || !tc.data || tc.ts === 0) {
    console.log('  [' + label + '] 缓存未命中, 触发解析...');
    try {
      if (!traeParsing[tool]) {
        if (!traeCaches[tool]) traeCaches[tool] = { data: [], ts: 0 };
        await parseTraeLogs(tool);
      } else {
        await traeParsing[tool];
      }
      console.log('  [' + label + '] 解析完成, 返回数据');
    } catch (e) {
      console.log('  [' + label + '] 解析失败: ' + e.message);
    }
  } else {
    const age = ((Date.now() - tc.ts) / 1000).toFixed(1);
    console.log('  [' + label + '] 使用缓存 (已缓存 ' + age + 's, ' + tc.data.length + ' 条)');
  }
  // Refresh if TTL expired
  const now = Date.now();
  const cache = traeCaches[tool];
  if (cache && cache.data && cache.ts > 0 && now - cache.ts > TTL) {
    parseTraeLogs(tool).catch(() => {});
  }
  const records = cache ? cache.data : [];
  const report = getTokenReport(records);
  const json = JSON.stringify(report);
  console.log('  -> ' + report.cells.length + ' 条, ' + (json.length/1024).toFixed(1) + 'KB');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(json);
}// ============ 控制台菜单 ============

let server = null;
let serverRunning = false;

function showBanner() {
  console.log('');
  console.log('  +------------------------------+');
  console.log('  |  Token 看板  v1.0           |');
  console.log('  |                              |');
  console.log('  |  -> http://localhost:' + PORT + '      |');
  console.log('  |                              |');
  console.log('  |  [S]停止 [R]重启 [O]浏览器   |');
  console.log('  |  [Q]退出                     |');
  console.log('  +------------------------------+');
  console.log('');
}

function openBrowser(url) {
  const { exec } = require('child_process');
  exec('start "" "' + url + '"', () => {});
}

function startServer() {
  if (serverRunning) return;
  server = http.createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    serverRunning = true;
    showBanner();
    openBrowser('http://localhost:' + PORT);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('  X 端口 ' + PORT + ' 已被占用');
    } else {
      console.log('  X 启动失败: ' + e.message);
    }
    server = null;
  });
}

function stopServer() {
  if (!serverRunning) {
    console.log('  Server 未运行');
    return;
  }
  try { server.closeAllConnections(); } catch(e) {}
  server.close(() => {
    serverRunning = false;
    console.log('');
    console.log('  +------------------------------+');
    console.log('  |  Server 已停止               |');
    console.log('  +------------------------------+');
    server = null;
  });
}

function restartServer() {
  if (serverRunning) {
    try { server.closeAllConnections(); } catch(e) {}
    server.close(() => {
      serverRunning = false;
      server = null;
      startServer();
    });
  } else {
    startServer();
  }
}

// Keypress handling
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  if (!key) return;
  const name = (key.name || '').toLowerCase();
  if (name === 'q') {
    if (serverRunning) { try { server.closeAllConnections(); } catch(e) {} server.close(() => {}); }
    process.exit(0);
  }
  if (name === 's') stopServer();
  if (name === 'r') restartServer();
  if (name === 'o') openBrowser('http://localhost:' + PORT);
  if (name === 'return') {} // ignore Enter
});

process.on('uncaughtException', (e) => {
  console.error('  Error: ' + e.message);
});

// Auto-start
startServer();