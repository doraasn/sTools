/**
 * 共享主题 CSS 与工具函数
 */
const THEME_CSS = `
*,*::after,*::before{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0c0a09;--s:#1c1917;--s2:#292524;--b:#44403c;--t:#e7e5e4;--t2:#a8a29e;--a:#06b6d4;--r:8px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif}
[data-theme="light"]{--bg:#fafaf9;--s:#fff;--s2:#f5f5f4;--b:#d6d3d1;--t:#1c1917;--t2:#78716c;--a:#0891b2}
body{font-family:var(--font);background:var(--bg);color:var(--t);min-height:100vh}
.app{max-width:1050px;margin:0 auto;padding:24px 20px}
::selection{background:var(--a);color:#fff}
.btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--b);border-radius:var(--r);background:var(--s);color:var(--t);font-size:13px;cursor:pointer;transition:all .15s;font-family:var(--font);line-height:1}
.btn:hover{background:var(--s2);border-color:var(--t2)}
`;

function htmlPage(title, bodyHtml, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${THEME_CSS}${extraHead}</style>
</head>
<body>
<div class="app">
${bodyHtml}
</div>
<script>
(function(){
  try{const t=localStorage.getItem('csd-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}
  const btn=document.getElementById('themeBtn');
  if(btn) btn.onclick=function(){const e=document.documentElement;const d=e.getAttribute('data-theme')==='dark'?'light':'dark';e.setAttribute('data-theme',d);try{localStorage.setItem('csd-theme',d)}catch(e){}}
})();
</script>
</body>
</html>`;
}

module.exports = { THEME_CSS, htmlPage };
