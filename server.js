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
  let cards = '';
  for (const mod of modules) {
    cards += `<a href="/${mod.name}" class="card">
      <div class="ci">${mod.icon || '🔧'}</div>
      <div class="ct">${mod.label || mod.name}</div>
      <div class="cd">${mod.description || ''}</div>
    </a>`;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tool Hub</title>
<style>
*,*::after,*::before{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0c0a09;--s:#1c1917;--s2:#292524;--b:#44403c;--t:#e7e5e4;--t2:#a8a29e;--a:#06b6d4;--r:8px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif}
[data-theme="light"]{--bg:#fafaf9;--s:#fff;--s2:#f5f5f4;--b:#d6d3d1;--t:#1c1917;--t2:#78716c;--a:#0891b2}
body{font-family:var(--font);background:var(--bg);color:var(--t);min-height:100vh;display:flex;align-items:center;justify-content:center}
.hub{text-align:center;padding:40px 20px;max-width:800px}
h1{font-size:28px;font-weight:700;letter-spacing:-.03em;margin-bottom:6px}
.sub{color:var(--t2);font-size:14px;margin-bottom:32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.card{display:block;background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:24px 16px;text-decoration:none;color:var(--t);transition:all .15s;cursor:pointer}
.card:hover{border-color:var(--a);transform:translateY(-2px);box-shadow:0 4px 20px rgba(6,182,212,.1)}
.ci{font-size:36px;margin-bottom:10px}
.ct{font-size:16px;font-weight:600;margin-bottom:4px}
.cd{font-size:13px;color:var(--t2);line-height:1.5}
.ft{margin-top:32px;font-size:12px;color:var(--t2)}
.ft a{color:var(--a);text-decoration:none}
</style>
</head>
<body>
<div class="hub">
  <h1>🔧 Tool Hub</h1>
  <p class="sub">选择工具</p>
  <div class="grid">${cards}</div>
  <p class="ft"><a href="https://github.com/doraasn/token-kanban" target="_blank">GitHub</a></p>
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
