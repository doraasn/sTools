/**
 * Tool Hub v1.0
 * 多工具入口，按模块拆分，方便扩展
 * node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = 3456;

// ==================== Module Loader ====================

const modules = [];
const moduleDir = path.join(__dirname, 'modules');
try {
  for (const f of fs.readdirSync(moduleDir).filter(f => f.endsWith('.js') && f !== 'common.js')) {
    try {
      const mod = require(path.join(moduleDir, f));
      if (mod && mod.handleRequest) {
        modules.push(mod);
        console.log('  [Hub] 加载模块: ' + (mod.label || mod.name));
      }
    } catch(e) { console.log('  [Hub] 模块加载失败 ' + f + ': ' + e.message); }
  }
} catch(e) { console.log('  [Hub] 读取模块目录失败:', e.message); }

// ==================== Server ====================

function serveHome(res) {
  // Card accent colors per module
  const cardStyles = {
    token: { accent: '#06b6d4', gradient: 'linear-gradient(135deg,rgba(6,182,212,.15),rgba(14,165,233,.05))' },
    sync:  { accent: '#10b981', gradient: 'linear-gradient(135deg,rgba(16,185,129,.15),rgba(5,150,105,.05))' },
  };

  let cards = '';
  for (const mod of modules) {
    const cs = cardStyles[mod.name] || { accent: '#a855f7', gradient: 'linear-gradient(135deg,rgba(168,85,247,.12),rgba(147,51,234,.04))' };
    cards += `<a href="/${mod.name}" class="card" style="--accent:${cs.accent}">
      <div class="card-bg" style="background:${cs.gradient}"></div>
      <div class="ci">${mod.icon || '🔧'}</div>
      <div class="ct">${mod.label || mod.name}</div>
      <div class="cd">${mod.description || ''}</div>
      <div class="card-arrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </div>
    </a>`;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sTools</title>
<style>
*,*::after,*::before{box-sizing:border-box;margin:0;padding:0}
@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
@keyframes glow{0%,100%{opacity:.4}50%{opacity:.8}}
:root{--bg:#0a0a0f;--s:#13131a;--s2:#1c1c28;--b:#2a2a3a;--t:#e8e8ed;--t2:#88889a;--t3:#5c5c70;--a:#06b6d4;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif}
body{font-family:var(--font);background:var(--bg);color:var(--t);min-height:100vh;overflow-x:hidden}
/* Animated background */
.bg-effects{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0}
.bg-effects .orb{position:absolute;border-radius:50%;filter:blur(100px);opacity:.15}
.bg-effects .orb:nth-child(1){width:600px;height:600px;background:#06b6d4;top:-200px;left:-200px;animation:float 12s ease-in-out infinite}
.bg-effects .orb:nth-child(2){width:500px;height:500px;background:#10b981;bottom:-150px;right:-100px;animation:float 16s ease-in-out infinite reverse}
.bg-effects .orb:nth-child(3){width:400px;height:400px;background:#a855f7;top:50%;left:50%;transform:translate(-50%,-50%);animation:glow 8s ease-in-out infinite}
/* Header */
.header{position:relative;z-index:1;text-align:center;padding:48px 20px 0}
.header .logo{font-size:48px;margin-bottom:4px;display:block}
.header h1{font-size:36px;font-weight:800;letter-spacing:-.04em;background:linear-gradient(135deg,#e8e8ed 0%,#88889a 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}
.header .subtitle{font-size:15px;color:var(--t2);font-weight:400}
.header .subtitle span{color:var(--t3);margin:0 8px}
/* Search/Cmd hint */
.cmd-hint{position:relative;z-index:1;text-align:center;margin:28px auto 0;max-width:480px;padding:0 20px}
.cmd-hint .hint-box{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:10px 16px;font-size:13px;color:var(--t3);display:flex;align-items:center;justify-content:center;gap:8px}
.cmd-hint .hint-box kbd{background:var(--s2);border:1px solid var(--b);border-radius:4px;padding:1px 6px;font-size:11px;font-family:inherit;color:var(--t2)}
/* Grid */
.grid-wrap{position:relative;z-index:1;max-width:820px;margin:36px auto;padding:0 20px 40px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
/* Card */
.card{position:relative;display:block;background:var(--s);border:1px solid var(--b);border-radius:14px;padding:28px 24px 24px;text-decoration:none;color:var(--t);transition:all .25s cubic-bezier(.4,0,.2,1);cursor:pointer;overflow:hidden;animation:fadeUp .5s ease-out both}
.card:nth-child(1){animation-delay:.1s}
.card:nth-child(2){animation-delay:.2s}
.card:nth-child(3){animation-delay:.3s}
.card:nth-child(4){animation-delay:.4s}
.card:nth-child(5){animation-delay:.5s}
.card:nth-child(6){animation-delay:.6s}
.card::before{content:'';position:absolute;inset:0;border-radius:14px;border:1px solid transparent;transition:all .3s;pointer-events:none}
.card:hover{transform:translateY(-4px);border-color:var(--accent);box-shadow:0 8px 40px color-mix(in srgb,var(--accent) 12%,transparent)}
.card:hover::before{border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.card-bg{position:absolute;inset:0;border-radius:14px;pointer-events:none;transition:opacity .3s;opacity:0}
.card:hover .card-bg{opacity:1}
.ci{font-size:40px;margin-bottom:10px;position:relative;display:inline-block}
.card:hover .ci{animation:float 2s ease-in-out infinite}
.ct{font-size:17px;font-weight:600;position:relative;margin-bottom:6px}
.cd{font-size:13px;color:var(--t2);line-height:1.6;position:relative;max-width:90%}
.card-arrow{position:absolute;bottom:20px;right:20px;color:var(--t3);transition:all .3s;opacity:0;transform:translateX(-8px)}
.card:hover .card-arrow{opacity:1;color:var(--accent);transform:translateX(0)}
/* Footer */
.ft{position:relative;z-index:1;text-align:center;padding:0 20px 40px;font-size:13px;color:var(--t3)}
.ft a{color:var(--t2);text-decoration:none;transition:color .2s}
.ft a:hover{color:var(--accent)}
.ft .dot{margin:0 10px;color:var(--t3)}
/* Responsive */
@media(max-width:560px){.grid{grid-template-columns:1fr}.header h1{font-size:28px}.header .logo{font-size:36px}}
</style>
</head>
<body>
<div class="bg-effects">
  <div class="orb"></div>
  <div class="orb"></div>
  <div class="orb"></div>
</div>

<div class="header">
  <span class="logo">⚡</span>
  <h1>sTools</h1>
  <p class="subtitle">工具箱<span>·</span>效率工具集</p>
</div>

<div class="cmd-hint">
  <div class="hint-box">
    <kbd>1</kbd> <kbd>2</kbd> 在模块内按数字键快速导航 · <kbd>Q</kbd> 退出
  </div>
</div>

<div class="grid-wrap">
  <div class="grid">${cards}</div>
</div>

<div class="ft">
  <a href="https://github.com/doraasn/sTools" target="_blank">GitHub</a>
  <span class="dot">·</span> v1.0
  <span class="dot">·</span> 127.0.0.1:${PORT}
</div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;

  // Home page
  if (pathname === '/' || pathname === '/index.html') {
    return serveHome(res);
  }

  // Route to modules
  for (const mod of modules) {
    // Direct module page: /<module-name>
    if (pathname === '/' + mod.name) {
      if (mod.renderHTML) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(mod.renderHTML());
      }
    }
    // API routes: synchronous check first
    if (mod.matchPath && mod.matchPath(pathname)) {
      const result = mod.handleRequest(req, res, url);
      // async handlers return a Promise - wait for it in background
      if (result && typeof result.then === 'function') {
        result.catch(() => { try { res.writeHead(500); res.end('Error'); } catch(e){} });
      }
      return;
    }
    // Legacy fallback: truthy return means handled
    if (!mod.matchPath) {
      const result = mod.handleRequest(req, res, url);
      if (result === true || (result && typeof result.then !== 'function')) return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// ==================== Console Menu ====================

let server = null;
let serverRunning = false;

function showBanner() {
  const names = modules.map(m => m.label || m.name).join(', ');
  console.log('');
  console.log('  +------------------------------+');
  console.log('  |  Tool Hub  v1.0              |');
  console.log('  |  ' + names.padEnd(29) + '|');
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
  if (!serverRunning) { console.log('  Server 未运行'); return; }
  try { server.closeAllConnections(); } catch(e) {}
  server.close(() => {
    serverRunning = false;
    console.log(''); console.log('  +------------------------------+');
    console.log('  |  Server 已停止               |');
    console.log('  +------------------------------+'); server = null;
  });
}

function restartServer() {
  if (serverRunning) {
    try { server.closeAllConnections(); } catch(e) {}
    server.close(() => { serverRunning = false; server = null; startServer(); });
  } else { startServer(); }
}

// Keypress
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  if (!key) return;
  const name = (key.name || '').toLowerCase();
  if (name === 'q') { if (serverRunning) { try { server.closeAllConnections(); } catch(e) {} server.close(() => {}); } process.exit(0); }
  if (name === 's') stopServer();
  if (name === 'r') restartServer();
  if (name === 'o') openBrowser('http://localhost:' + PORT);
});

process.on('uncaughtException', (e) => { console.error('  Error: ' + e.message); });

// Auto-start
startServer();
