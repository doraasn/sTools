(() => {
  'use strict';
  const { $, api, escapeHTML, toast, openModal, closeModal, formatNumber } = window.dTools;
  const COLORS = ['#3b82f6', '#22c55e', '#06b6d4', '#f59e0b', '#f43f5e', '#14b8a6', '#84cc16', '#eab308', '#64748b', '#fb7185'];
  let currentTool = '';
  let availableTools = [];
  let rawData = null;
  let data = null;
  let settings = {};
  let aliases = {};
  let hiddenProjects = [];
  let period = 'all';
  let hiddenModels = new Set();
  let charts = { daily: null, model: null, project: null };
  let loading = false;

  const themeColors = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue('--text').trim(),
      text2: style.getPropertyValue('--text-2').trim(),
      text3: style.getPropertyValue('--text-3').trim(),
      line: style.getPropertyValue('--line').trim(),
      surface: style.getPropertyValue('--surface').trim(),
    };
  };

  const loadLocalSettings = () => {
    try {
      aliases = JSON.parse(localStorage.getItem('dt-token-aliases') || '{}');
      hiddenProjects = JSON.parse(localStorage.getItem('dt-token-hidden') || '[]');
    } catch (_) { aliases = {}; hiddenProjects = []; }
  };

  const saveLocalSettings = () => {
    try {
      localStorage.setItem('dt-token-aliases', JSON.stringify(aliases));
      localStorage.setItem('dt-token-hidden', JSON.stringify(hiddenProjects));
    } catch (_) {}
  };

  function renderToolSwitch() {
    $('toolSwitch').innerHTML = availableTools.map((tool) => `
      <button class="segment${tool.name === currentTool ? ' active' : ''}" type="button" data-tool="${escapeHTML(tool.name)}">
        ${escapeHTML(tool.label)}
      </button>`).join('');
    const hasData = availableTools.length > 0;
    ['tokenToolbar', 'tokenMetrics', 'tokenTrend', 'distributionGrid'].forEach((id) => { $(id).hidden = !hasData; });
    $('tokenSourceEmpty').hidden = hasData;
    $('tokenSettings').disabled = !hasData;
    $('tokenRefresh').disabled = !hasData;
  }

  async function loadTools() {
    availableTools = await api('/api/token-tools');
    if (!Array.isArray(availableTools)) availableTools = [];
    if (!availableTools.some((tool) => tool.name === currentTool)) {
      currentTool = availableTools[0]?.name || '';
    }
    renderToolSwitch();
  }

  function applyProjectSettings(source) {
    if (!source || currentTool !== 'claude') return source;
    const copy = JSON.parse(JSON.stringify(source));
    const visibleCells = copy.cells
      .filter((cell) => !hiddenProjects.includes(cell.project))
      .map((cell) => ({ ...cell, project: aliases[cell.project] || cell.project }));
    const projectMap = new Map();
    visibleCells.forEach((cell) => {
      const project = projectMap.get(cell.project) || { name: cell.project, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      ['total', 'input', 'output', 'cacheRead', 'cacheCreate', 'sessions'].forEach((key) => { project[key] += cell[key] || 0; });
      projectMap.set(cell.project, project);
    });
    copy.cells = visibleCells;
    copy.projects = [...projectMap.values()].sort((a, b) => b.total - a.total);
    copy.summary.grandTotal = visibleCells.reduce((sum, cell) => sum + cell.total, 0);
    copy.summary.totalProjects = copy.projects.length;
    copy.summary.totalDays = new Set(visibleCells.map((cell) => cell.date)).size;
    return copy;
  }

  function dateBounds() {
    const today = new Date();
    const toISO = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    if (period === 'today') return [toISO(today), toISO(today)];
    if (period === '7d' || period === '30d') {
      const start = new Date(today);
      start.setDate(today.getDate() - (period === '7d' ? 6 : 29));
      return [toISO(start), toISO(today)];
    }
    if (period === 'custom') return [$('dateStart').value, $('dateEnd').value];
    return ['', ''];
  }

  function filteredData() {
    if (!data) return { cells: [], models: [], projects: [], summary: {} };
    const [start, end] = dateBounds();
    const cells = data.cells.filter((cell) => (!start || cell.date >= start) && (!end || cell.date <= end));
    const modelMap = new Map();
    const projectMap = new Map();
    cells.forEach((cell) => {
      for (const [map, name] of [[modelMap, cell.model], [projectMap, cell.project]]) {
        const bucket = map.get(name) || { name, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
        ['total', 'input', 'output', 'cacheRead', 'cacheCreate', 'sessions'].forEach((key) => { bucket[key] += cell[key] || 0; });
        map.set(name, bucket);
      }
    });
    const total = cells.reduce((sum, cell) => sum + cell.total, 0);
    const models = [...modelMap.values()].sort((a, b) => b.total - a.total);
    const projects = [...projectMap.values()].sort((a, b) => b.total - a.total);
    [...models, ...projects].forEach((item) => { item.share = total ? (item.total / total * 100).toFixed(1) : '0.0'; });
    return {
      cells, models, projects,
      summary: {
        grandTotal: total,
        totalDays: new Set(cells.map((cell) => cell.date)).size,
        totalModels: models.length,
        totalProjects: projects.length,
        totalSessions: data.summary.totalSessions,
      },
    };
  }

  function renderMetrics(view) {
    const totals = view.cells.reduce((result, cell) => {
      result.input += cell.input + cell.cacheCreate;
      result.cache += cell.cacheRead;
      result.output += cell.output;
      return result;
    }, { input: 0, cache: 0, output: 0 });
    const cacheRate = totals.input + totals.cache ? totals.cache / (totals.input + totals.cache) * 100 : 0;
    const values = {
      metricTotal: formatNumber(view.summary.grandTotal),
      metricCache: `${cacheRate.toFixed(1)}%`,
      metricSessions: formatNumber(view.summary.totalSessions),
      metricDays: formatNumber(view.summary.totalDays),
      metricProjects: formatNumber(view.summary.totalProjects),
    };
    Object.entries(values).forEach(([id, value]) => { $(id).textContent = value; $(id).classList.remove('skeleton'); });
    $('metricTotalMeta').textContent = `输入 ${formatNumber(totals.input)} · 输出 ${formatNumber(totals.output)}`;
    $('metricCacheMeta').textContent = `命中 ${formatNumber(totals.cache)}`;
    $('metricSessionMeta').textContent = `${view.summary.totalModels} 个模型`;
    $('metricDaysMeta').textContent = period === 'all' ? '全部本地记录' : '当前筛选范围';
    $('metricProjectsMeta').textContent = currentTool === 'claude' ? '可在设置中隐藏' : '识别到的本地项目';
  }

  function renderDaily(view) {
    charts.daily?.destroy();
    charts.daily = null;
    const visibleModels = view.models.filter((model) => !hiddenModels.has(model.name));
    const dates = [...new Set(view.cells.map((cell) => cell.date))].sort();
    $('dailyEmpty').classList.toggle('show', !dates.length || !visibleModels.length || typeof Chart === 'undefined');
    renderDailyLegend(view.models);
    if (!dates.length || !visibleModels.length || typeof Chart === 'undefined') return;

    const map = new Map();
    view.cells.forEach((cell) => {
      const key = `${cell.date}\0${cell.model}`;
      const bucket = map.get(key) || { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
      ['input', 'cacheRead', 'cacheCreate', 'output'].forEach((name) => { bucket[name] += cell[name] || 0; });
      map.set(key, bucket);
    });
    const datasets = [];
    visibleModels.forEach((model) => {
      const color = COLORS[view.models.indexOf(model) % COLORS.length];
      const values = dates.map((date) => map.get(`${date}\0${model.name}`) || {});
      datasets.push(
        { label: `${model.name} · 输入`, data: values.map((v) => (v.input || 0) + (v.cacheCreate || 0)), backgroundColor: color, stack: 'tokens' },
        { label: `${model.name} · 缓存`, data: values.map((v) => v.cacheRead || 0), backgroundColor: color + '72', stack: 'tokens' },
        { label: `${model.name} · 输出`, data: values.map((v) => v.output || 0), backgroundColor: color + 'b5', stack: 'tokens' },
      );
    });
    const colors = themeColors();
    charts.daily = new Chart($('dailyChart'), {
      type: 'bar',
      data: { labels: dates, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 320 },
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.surface, titleColor: colors.text, bodyColor: colors.text2,
            borderColor: colors.line, borderWidth: 1, padding: 12,
            callbacks: {
              label: () => '',
              afterBody: (items) => {
                const index = items[0]?.dataIndex;
                if (index === undefined) return [];
                const lines = [];
                visibleModels.forEach((model, modelIndex) => {
                  const item = map.get(`${dates[index]}\0${model.name}`) || {};
                  const input = (item.input || 0) + (item.cacheCreate || 0);
                  const cache = item.cacheRead || 0;
                  const output = item.output || 0;
                  if (modelIndex) lines.push('');
                  lines.push(model.name, `  输入 ${formatNumber(input)}  ·  缓存 ${formatNumber(cache)}  ·  输出 ${formatNumber(output)}`, `  合计 ${formatNumber(input + cache + output)}`);
                });
                return lines;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: colors.text3, maxRotation: 0, font: { size: 11 } }, border: { display: false } },
          y: { stacked: true, beginAtZero: true, grace: '12%', grid: { color: colors.line + '80' }, ticks: { color: colors.text3, callback: formatNumber, font: { size: 11 } }, border: { display: false } },
        },
      },
      plugins: [{
        id: 'totalLabels',
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          ctx.save(); ctx.fillStyle = colors.text3; ctx.font = '11px ui-monospace'; ctx.textAlign = 'center';
          dates.forEach((_, index) => {
            const total = chart.data.datasets.reduce((sum, dataset) => sum + (dataset.data[index] || 0), 0);
            const elements = chart.getDatasetMeta(chart.data.datasets.length - 1).data;
            const element = elements[index];
            if (element && total) ctx.fillText(formatNumber(total), element.x, Math.max(element.y - 7, chart.chartArea.top + 9));
          });
          ctx.restore();
        },
      }],
    });
  }

  function renderDailyLegend(models) {
    $('dailyLegend').innerHTML = models.map((model, index) => `
      <button class="legend-item${hiddenModels.has(model.name) ? ' off' : ''}" type="button" data-model-index="${index}">
        <span class="legend-color" style="background:${COLORS[index % COLORS.length]}"></span>${escapeHTML(model.name)}
      </button>`).join('');
  }

  function renderDonut(kind, items) {
    charts[kind]?.destroy();
    charts[kind] = null;
    const canvas = $(`${kind}Chart`);
    const list = $(`${kind}List`);
    const count = items.length;
    $(`${kind}Count`).textContent = `${count} 个${kind === 'model' ? '模型' : '项目'}`;
    $(`${kind}Center`).textContent = count;
    list.innerHTML = items.length ? items.slice(0, 8).map((item, index) => `
      <div class="rank-row">
        <span class="rank-color" style="background:${COLORS[index % COLORS.length]}"></span>
        <span class="rank-copy"><strong title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</strong><small>${item.sessions || 0} 会话</small></span>
        <span class="rank-value"><strong>${formatNumber(item.total)}</strong><small>${item.share}%</small></span>
      </div>`).join('') : '<div class="empty-state compact">暂无数据</div>';
    if (!items.length || typeof Chart === 'undefined') return;
    const colors = themeColors();
    charts[kind] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: items.map((item) => item.name), datasets: [{ data: items.map((item) => item.total), backgroundColor: items.map((_, i) => COLORS[i % COLORS.length]), borderWidth: 0, hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '72%',
        plugins: { legend: { display: false }, tooltip: { backgroundColor: colors.surface, titleColor: colors.text, bodyColor: colors.text2, borderColor: colors.line, borderWidth: 1, callbacks: { label: (item) => ` ${formatNumber(item.raw)} · ${items[item.dataIndex].share}%` } } },
      },
    });
  }

  function renderAll() {
    const view = filteredData();
    renderMetrics(view);
    renderDaily(view);
    renderDonut('model', view.models);
    renderDonut('project', view.projects);
    $('distributionGrid').style.display = 'grid';
    $('distributionGrid').style.gridTemplateColumns = '';
    $('projectList').closest('.distribution-panel').style.display = '';
  }

  async function loadData(showLoading = true) {
    if (loading || !currentTool) return;
    loading = true;
    if (showLoading) $('tokenLoading').classList.add('show');
    $('tokenRefresh').disabled = true;
    try {
      rawData = await api(`/api/tokens?tool=${encodeURIComponent(currentTool)}`);
      data = applyProjectSettings(rawData);
      renderAll();
      $('tokenUpdated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      if (typeof Chart === 'undefined') toast('图表组件未加载', '请检查本机网络后刷新页面', 'warning', 5000);
    } catch (error) {
      toast('Token 数据加载失败', error.message, 'error', 5000);
    } finally {
      loading = false;
      $('tokenLoading').classList.remove('show');
      $('tokenRefresh').disabled = false;
    }
  }

  function renderSettings() {
    const body = $('tokenSettingsBody');
    if (currentTool === 'claude') {
      const projects = rawData?.projects || [];
      body.innerHTML = `<section class="settings-section"><h3>项目显示</h3><p>隐藏不关心的项目，或设置更易读的显示名称。</p>${projects.map((project, index) => `
        <div class="project-setting">
          <label class="switch"><input type="checkbox" data-project-visible="${index}" ${hiddenProjects.includes(project.name) ? '' : 'checked'}><span></span></label>
          <span class="project-original" title="${escapeHTML(project.name)}">${escapeHTML(project.name)}</span>
          <input class="input" data-project-alias="${index}" value="${escapeHTML(aliases[project.name] || '')}" placeholder="显示名称">
        </div>`).join('') || '<div class="empty-state compact">暂无项目</div>'}</section>`;
    } else if (currentTool === 'trae-intl' || currentTool === 'trae-cn') {
      const label = currentTool === 'trae-cn' ? 'Trae CN' : 'Trae';
      body.innerHTML = `<section class="settings-section"><h3>${label} 日志目录</h3><p>留空时使用系统默认目录，修改后会自动重建增量缓存。</p><div class="field"><label>本地路径</label><input class="input" id="traePath" value="${escapeHTML(settings[currentTool] || '')}" placeholder="例如 D:\\Apps\\Trae"></div></section>`;
    } else {
      const tool = availableTools.find((item) => item.name === currentTool);
      body.innerHTML = `<section class="settings-section"><h3>${escapeHTML(tool?.label || currentTool)}</h3><p>数据会从该工具的本地会话目录自动读取，无需额外配置。</p><div class="source-path-note">刷新页面时会自动发现新记录，并按文件或数据库状态增量更新。</div></section>`;
    }
  }

  $('toolSwitch').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-tool]');
    if (!button || button.dataset.tool === currentTool) return;
    currentTool = button.dataset.tool;
    hiddenModels = new Set();
    $('toolSwitch').querySelectorAll('.segment').forEach((item) => item.classList.toggle('active', item === button));
    await loadData();
  });
  $('periodGroup').addEventListener('click', (event) => {
    const button = event.target.closest('[data-period]');
    if (!button) return;
    period = button.dataset.period;
    $('periodGroup').querySelectorAll('.period').forEach((item) => item.classList.toggle('active', item === button));
    renderAll();
  });
  ['dateStart', 'dateEnd'].forEach((id) => $(id).addEventListener('change', () => {
    period = 'custom';
    $('periodGroup').querySelectorAll('.period').forEach((item) => item.classList.remove('active'));
    renderAll();
  }));
  $('dailyLegend').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model-index]');
    if (!button) return;
    const view = filteredData();
    const model = view.models[Number(button.dataset.modelIndex)];
    if (!model) return;
    hiddenModels.has(model.name) ? hiddenModels.delete(model.name) : hiddenModels.add(model.name);
    renderDaily(view);
  });
  $('tokenRefresh').addEventListener('click', () => loadData(false));
  $('tokenSettings').addEventListener('click', () => { renderSettings(); openModal('tokenSettingsModal'); });
  $('tokenSettingsSave').addEventListener('click', async () => {
    if (currentTool === 'claude') {
      const projects = rawData?.projects || [];
      projects.forEach((project, index) => {
        const visible = document.querySelector(`[data-project-visible="${index}"]`)?.checked;
        const alias = document.querySelector(`[data-project-alias="${index}"]`)?.value.trim();
        hiddenProjects = visible ? hiddenProjects.filter((name) => name !== project.name) : [...new Set([...hiddenProjects, project.name])];
        if (alias) aliases[project.name] = alias; else delete aliases[project.name];
      });
      saveLocalSettings();
    } else if (currentTool === 'trae-intl' || currentTool === 'trae-cn') {
      settings[currentTool] = $('traePath')?.value.trim() || '';
      try { await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }); }
      catch (error) { toast('设置保存失败', error.message, 'error'); return; }
    }
    data = applyProjectSettings(rawData);
    renderAll();
    closeModal('tokenSettingsModal');
    toast('设置已保存', '', 'success');
  });
  window.addEventListener('themechange', renderAll);

  (async () => {
    loadLocalSettings();
    try {
      [settings] = await Promise.all([api('/api/config'), loadTools()]);
    } catch (error) {
      settings = {};
      toast('本地工具识别失败', error.message, 'error', 5000);
      availableTools = [];
      currentTool = '';
      renderToolSwitch();
    }
    if (currentTool) await loadData();
    else $('tokenLoading').classList.remove('show');
    setInterval(() => { if (!document.hidden) loadData(false); }, 20000);
  })();
})();
