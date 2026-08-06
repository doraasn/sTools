(() => {
  'use strict';
  const { $, api, escapeHTML, highlight, toast } = window.dTools;
  let logs = [];
  let lastTimestamp = 0;
  const activeLevels = new Set(['info', 'ok', 'warn', 'err']);

  function filteredLogs() {
    const query = $('logSearch').value.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const source = $('sourceFilter').value;
    return logs.filter((entry) => {
      if (!activeLevels.has(entry.level) || (source && entry.source !== source)) return false;
      const text = `${entry.source} ${entry.msg}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }

  function render() {
    const filtered = filteredLogs();
    const query = $('logSearch').value.trim();
    $('logTotal').textContent = logs.length;
    $('logMatched').textContent = filtered.length;
    $('logIssues').textContent = logs.filter((entry) => entry.level === 'warn' || entry.level === 'err').length;
    const sources = [...new Set(logs.map((entry) => entry.source))].sort();
    const selected = $('sourceFilter').value;
    $('sourceFilter').innerHTML = '<option value="">全部来源</option>' + sources.map((source) => `<option value="${escapeHTML(source)}">${escapeHTML(source)}</option>`).join('');
    $('sourceFilter').value = selected;
    $('logStream').innerHTML = filtered.length ? filtered.map((entry) => `
      <div class="stream-row">
        <time class="stream-time">${escapeHTML(entry.time)}</time>
        <span class="stream-level ${escapeHTML(entry.level)}">${escapeHTML(entry.level)}</span>
        <span class="stream-source">${escapeHTML(entry.source)}</span>
        <span class="stream-message">${highlight(entry.msg, query)}</span>
      </div>`).join('') : '<div class="empty-state">暂无匹配日志</div>';
    if ($('autoScroll').checked) $('logStream').scrollTop = $('logStream').scrollHeight;
  }

  async function loadInitial() {
    try {
      logs = await api('/api/logs');
      if (logs.length) lastTimestamp = logs[logs.length - 1].ts;
      render();
    } catch (error) { toast('日志加载失败', error.message, 'error'); }
  }

  async function poll() {
    try {
      const fresh = await api(`/api/logs/since?ts=${lastTimestamp}`);
      if (fresh.length) {
        logs.push(...fresh);
        lastTimestamp = fresh[fresh.length - 1].ts;
        render();
      }
    } catch (_) {}
  }

  $('logSearch').addEventListener('input', render);
  $('sourceFilter').addEventListener('change', render);
  $('autoScroll').addEventListener('change', render);
  $('levelFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-level]');
    if (!button) return;
    const level = button.dataset.level;
    activeLevels.has(level) ? activeLevels.delete(level) : activeLevels.add(level);
    button.classList.toggle('active', activeLevels.has(level));
    render();
  });
  $('clearLogs').addEventListener('click', async () => {
    try {
      await api('/api/logs/clear', { method: 'POST' });
      logs = []; lastTimestamp = 0; render();
      window.dispatchEvent(new CustomEvent('dtools:logs-cleared'));
      toast('日志已清空', '内存与本地日志文件均已清理', 'success');
    } catch (error) { toast('清空失败', error.message, 'error'); }
  });
  $('copyLogs').addEventListener('click', async () => {
    const text = filteredLogs().map((entry) => `${entry.time} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.msg}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('已复制', `${filteredLogs().length} 条日志`, 'success'); }
    catch (error) { toast('复制失败', error.message, 'error'); }
  });
  window.addEventListener('dtools:logs-cleared', () => { logs = []; lastTimestamp = 0; render(); });

  loadInitial();
  setInterval(() => { if (!document.hidden) poll(); }, 2000);
})();
