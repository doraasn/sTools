(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof data === 'object' ? data.error : data;
      throw new Error(message || `请求失败 (${response.status})`);
    }
    return data;
  }

  function toast(title, message = '', type = 'info', duration = 3200) {
    const stack = $('toastStack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.innerHTML = `<div><strong>${escapeHTML(title)}</strong>${message ? `<span>${escapeHTML(message)}</span>` : ''}</div>`;
    stack.appendChild(item);
    setTimeout(() => item.remove(), duration);
  }

  function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => modal.querySelector('input,select,textarea,button')?.focus(), 60);
  }

  function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function highlight(value, query) {
    const source = String(value ?? '');
    const term = String(query ?? '').trim();
    if (!term) return escapeHTML(source);
    const lower = source.toLowerCase();
    const needle = term.toLowerCase();
    let cursor = 0;
    let html = '';
    while (true) {
      const index = lower.indexOf(needle, cursor);
      if (index < 0) break;
      html += escapeHTML(source.slice(cursor, index));
      html += `<mark>${escapeHTML(source.slice(index, index + needle.length))}</mark>`;
      cursor = index + needle.length;
    }
    return html + escapeHTML(source.slice(cursor));
  }

  function formatNumber(value) {
    const number = Number(value) || 0;
    if (number >= 1e8) return `${(number / 1e8).toFixed(number >= 1e9 ? 1 : 2)}亿`;
    if (number >= 1e4) return `${(number / 1e4).toFixed(number >= 1e6 ? 1 : 2)}万`;
    return new Intl.NumberFormat('zh-CN').format(Math.round(number));
  }

  function formatDuration(seconds) {
    const value = Number(seconds) || 0;
    return value < 60 ? `${value.toFixed(1)}s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  }

  window.dTools = { $, api, escapeHTML, toast, openModal, closeModal, highlight, formatNumber, formatDuration };

  const navCollapse = $('navCollapse');
  navCollapse?.addEventListener('click', () => {
    document.documentElement.classList.toggle('nav-compact');
    try {
      localStorage.setItem('dt-nav-compact', document.documentElement.classList.contains('nav-compact') ? '1' : '0');
    } catch (_) {}
  });

  const setNavOpen = (open) => document.body.classList.toggle('nav-open', open);
  $('mobileMenu')?.addEventListener('click', () => setNavOpen(true));
  $('navScrim')?.addEventListener('click', () => setNavOpen(false));

  $('themeButton')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dt-theme', next); } catch (_) {}
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });

  const clock = $('topbarClock');
  const updateClock = () => {
    if (!clock) return;
    const now = new Date();
    clock.textContent = `${now.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })}  ${now.toLocaleTimeString('zh-CN', { hour12: false })}`;
  };
  updateClock();
  setInterval(updateClock, 1000);

  let drawerOpen = false;
  let drawerLogs = [];
  let drawerLastTimestamp = 0;
  let drawerTimer = null;

  const renderDrawer = () => {
    const query = ($('drawerSearch')?.value || '').trim().toLowerCase();
    const filtered = drawerLogs.filter((entry) => !query || `${entry.source} ${entry.msg}`.toLowerCase().includes(query));
    $('drawerCount').textContent = `${filtered.length} 条`;
    $('drawerLog').innerHTML = filtered.length ? filtered.map((entry) => `
      <div class="log-line">
        <time>${escapeHTML(entry.time)}</time>
        <span class="level-dot ${escapeHTML(entry.level)}"></span>
        <span class="source">${escapeHTML(entry.source)}</span>
        <span class="message">${highlight(entry.msg, query)}</span>
      </div>`).join('') : '<div class="empty-state compact">暂无匹配日志</div>';
    $('drawerLog').scrollTop = $('drawerLog').scrollHeight;
  };

  const loadDrawer = async (initial = false) => {
    if (!drawerOpen) return;
    try {
      const url = initial ? '/api/logs' : `/api/logs/since?ts=${drawerLastTimestamp}`;
      const data = await api(url);
      drawerLogs = initial ? data : drawerLogs.concat(data);
      if (data.length) drawerLastTimestamp = data[data.length - 1].ts;
      renderDrawer();
    } catch (_) {}
  };

  const setDrawer = (open) => {
    drawerOpen = open;
    $('logDrawer')?.classList.toggle('open', open);
    $('drawerScrim')?.classList.toggle('open', open);
    $('logDrawer')?.setAttribute('aria-hidden', String(!open));
    if (open) {
      loadDrawer(true);
      drawerTimer = drawerTimer || setInterval(() => loadDrawer(false), 2000);
    } else if (drawerTimer) {
      clearInterval(drawerTimer);
      drawerTimer = null;
    }
  };

  $('globalLogButton')?.addEventListener('click', () => setDrawer(true));
  $('drawerClose')?.addEventListener('click', () => setDrawer(false));
  $('drawerScrim')?.addEventListener('click', () => setDrawer(false));
  $('drawerSearch')?.addEventListener('input', renderDrawer);
  $('drawerClear')?.addEventListener('click', async () => {
    try {
      await api('/api/logs/clear', { method: 'POST' });
      drawerLogs = [];
      drawerLastTimestamp = 0;
      renderDrawer();
      window.dispatchEvent(new CustomEvent('dtools:logs-cleared'));
      toast('日志已清空', '内存与本地日志文件已清理', 'success');
    } catch (error) { toast('清空失败', error.message, 'error'); }
  });

  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-modal-close]');
    if (closeButton) closeModal(closeButton.dataset.modalClose);
    if (event.target.classList.contains('modal-backdrop')) closeModal(event.target.id);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (drawerOpen) setDrawer(false);
      document.querySelectorAll('.modal-backdrop.open').forEach((modal) => closeModal(modal.id));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      setDrawer(!drawerOpen);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
      event.preventDefault();
      $('themeButton')?.click();
    }
  });
})();

