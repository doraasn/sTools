(() => {
  'use strict';
  const { $, api, escapeHTML, toast, openModal, closeModal, formatNumber } = window.dTools;
  const COLORS = ['#3b82f6', '#22c55e', '#06b6d4', '#f59e0b', '#f43f5e', '#14b8a6', '#84cc16', '#eab308', '#64748b', '#fb7185'];
  let currentTool = '';
  let availableTools = [];
  let catalogTools = [];
  let settingsClaudeProjects = [];
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
    $('tokenSettings').disabled = false;
    $('tokenRefresh').disabled = !hasData;
  }

  async function loadTools() {
    catalogTools = await api('/api/token-tool-catalog');
    if (!Array.isArray(catalogTools)) catalogTools = [];
    const visibleTools = catalogTools
      .filter((tool) => tool.hasData && tool.visible)
      .map((tool) => ({ name: tool.name, label: tool.label }));
    availableTools = visibleTools.length ? [{ name: 'all', label: '全部' }, ...visibleTools] : [];
    if (!availableTools.some((tool) => tool.name === currentTool)) {
      currentTool = availableTools[0]?.name || '';
    }
    renderToolSwitch();
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
    $('metricProjectsMeta').textContent = currentTool === 'all' ? '跨工具合并统计' : (currentTool === 'claude' ? '可在设置中隐藏' : '识别到的本地项目');
  }

  function renderDaily(view) {
    charts.daily?.destroy();
    charts.daily = null;
    $('dailyTooltip').hidden = true;
    const visibleModels = view.models.filter((model) => !hiddenModels.has(model.name));
    const dates = [...new Set(view.cells.map((cell) => cell.date))].sort();
    $('dailyEmpty').classList.toggle('show', !dates.length || !visibleModels.length || typeof Chart === 'undefined');
    renderDailyLegend(view.models);
    if (!dates.length || !visibleModels.length || typeof Chart === 'undefined') return;

    const map = new Map();
    view.cells.forEach((cell) => {
      const key = `${cell.date}\0${cell.model}`;
      const bucket = map.get(key) || { total: 0 };
      bucket.total += cell.total || 0;
      map.set(key, bucket);
    });
    const colorByModel = new Map(view.models.map((model, index) => [model.name, COLORS[index % COLORS.length]]));
    const rankedByDate = dates.map((date) => visibleModels
      .map((model) => ({
        name: model.name,
        total: map.get(`${date}\0${model.name}`)?.total || 0,
        color: colorByModel.get(model.name),
      }))
      .filter((item) => item.total > 0)
      .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name)));
    const slotCount = Math.max(0, ...rankedByDate.map((items) => items.length));

    // 数据集代表“当天排名槽位”而不是固定模型：排名第一的模型始终作为柱体最底层。
    const datasets = Array.from({ length: slotCount }, (_, rank) => ({
      label: `第 ${rank + 1} 名`,
      data: rankedByDate.map((items) => items[rank]?.total || 0),
      backgroundColor: rankedByDate.map((items) => items[rank]?.color || 'transparent'),
      borderWidth: 0,
      stack: 'tokens',
    }));
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
            enabled: false,
            external: ({ chart, tooltip }) => {
              const tooltipElement = $('dailyTooltip');
              const dataIndex = tooltip.dataPoints?.[0]?.dataIndex;
              if (tooltip.opacity === 0 || dataIndex === undefined) {
                tooltipElement.hidden = true;
                return;
              }

              // 按当日用量从小到大排列，最高用量始终位于提示框最底部。
              const entries = rankedByDate[dataIndex].map((item) => ({ ...item }))
                .sort((left, right) => left.total - right.total || left.name.localeCompare(right.name));
              const dayTotal = entries.reduce((sum, item) => sum + item.total, 0);
              tooltipElement.innerHTML = `
                <div class="daily-tooltip-head"><span>${escapeHTML(dates[dataIndex])}</span><strong>${formatNumber(dayTotal)}</strong></div>
                <div class="daily-tooltip-list">${entries.map((item) => `
                  <div class="daily-tooltip-row">
                    <span class="daily-tooltip-model"><span class="daily-tooltip-dot" style="background:${item.color}"></span><span>${escapeHTML(item.name)}</span></span>
                    <span class="daily-tooltip-value">${formatNumber(item.total)}</span>
                  </div>`).join('')}</div>`;
              tooltipElement.hidden = false;

              const activeBars = tooltip.dataPoints.map((item) => item.element).filter(Boolean);
              if (!activeBars.length) return;
              const canvasLeft = chart.canvas.offsetLeft;
              const canvasTop = chart.canvas.offsetTop;
              const barCenter = canvasLeft + activeBars[0].x;
              const barHalfWidth = Math.max(...activeBars.map((bar) => bar.width || 0)) / 2;
              const stackTop = Math.min(...activeBars.map((bar) => Math.min(bar.y, bar.base)));
              const stackBottom = Math.max(...activeBars.map((bar) => Math.max(bar.y, bar.base)));
              const gap = 14;
              const edge = 8;
              const width = tooltipElement.offsetWidth;
              const height = tooltipElement.offsetHeight;
              const wrapWidth = tooltipElement.parentElement.clientWidth;
              const wrapHeight = tooltipElement.parentElement.clientHeight;
              const leftOfBar = barCenter - barHalfWidth - gap - width;
              const rightOfBar = barCenter + barHalfWidth + gap;
              const fitsLeft = leftOfBar >= edge;
              const fitsRight = rightOfBar + width <= wrapWidth - edge;
              let left;
              let top = canvasTop + (stackTop + stackBottom - height) / 2;

              // 优先放在数据柱两侧；空间不足时改放到上方或下方，避免覆盖悬浮对象。
              if (fitsLeft || fitsRight) {
                left = fitsLeft && (!fitsRight || barCenter > wrapWidth / 2) ? leftOfBar : rightOfBar;
              } else {
                left = Math.min(Math.max(barCenter - width / 2, edge), Math.max(edge, wrapWidth - width - edge));
                const above = canvasTop + stackTop - height - gap;
                const below = canvasTop + stackBottom + gap;
                top = above >= edge ? above : below;
              }
              tooltipElement.style.left = `${Math.round(left)}px`;
              tooltipElement.style.top = `${Math.round(Math.min(Math.max(top, edge), Math.max(edge, wrapHeight - height - edge)))}px`;
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: colors.text2, maxRotation: 0, font: { size: 13, weight: 500 } }, border: { display: false } },
          y: { stacked: true, beginAtZero: true, grace: '12%', grid: { color: colors.line }, ticks: { color: colors.text2, callback: formatNumber, font: { size: 13, weight: 500 } }, border: { display: false } },
        },
      },
      plugins: [{
        id: 'totalLabels',
        afterDatasetsDraw(chart) {
          if (dates.length > 16) return;
          const { ctx } = chart;
          ctx.save(); ctx.fillStyle = colors.text2; ctx.font = '12px ui-monospace'; ctx.textAlign = 'center';
          dates.forEach((_, index) => {
            const total = chart.data.datasets.reduce((sum, dataset) => sum + (dataset.data[index] || 0), 0);
            const topDatasetIndex = chart.data.datasets.reduce((result, dataset, datasetIndex) => (
              dataset.data[index] > 0 ? datasetIndex : result
            ), -1);
            const element = topDatasetIndex >= 0 ? chart.getDatasetMeta(topDatasetIndex).data[index] : null;
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

  async function loadData(showLoading = true, forceRefresh = false) {
    if (loading || !currentTool) return;
    loading = true;
    if (showLoading) $('tokenLoading').classList.add('show');
    $('tokenRefresh').disabled = true;
    try {
      const refreshQuery = forceRefresh ? '&refresh=1' : '';
      rawData = await api(`/api/tokens?tool=${encodeURIComponent(currentTool)}${refreshQuery}`);
      data = rawData;
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

  async function renderSettings() {
    const body = $('tokenSettingsBody');
    body.innerHTML = '<div class="settings-loading"><span class="spinner"></span><span>正在读取工具设置…</span></div>';
    settingsClaudeProjects = [];
    if (catalogTools.some((tool) => tool.name === 'claude' && tool.hasData)) {
      try {
        const report = await api('/api/tokens?tool=claude&raw=1');
        settingsClaudeProjects = report.projects || [];
      } catch (_) {}
    }

    body.innerHTML = `<div class="tool-settings-list">${catalogTools.map((tool) => {
      let detail = '<div class="source-path-note">自动读取本机数据，无需额外配置。</div>';
      if (tool.name === 'trae-intl' || tool.name === 'trae-cn') {
        detail = `<div class="field"><label>日志目录</label><input class="input" data-tool-path="${tool.name}" value="${escapeHTML(settings[tool.name] || '')}" placeholder="留空使用系统默认目录"></div>`;
      } else if (tool.name === 'claude') {
        detail = `<div class="claude-project-settings"><p>项目显示与别名</p>${settingsClaudeProjects.map((project, index) => `
          <div class="project-setting">
            <label class="switch"><input type="checkbox" data-project-visible="${index}" ${hiddenProjects.includes(project.name) ? '' : 'checked'}><span></span></label>
            <span class="project-original" title="${escapeHTML(project.name)}">${escapeHTML(project.name)}</span>
            <input class="input" data-project-alias="${index}" value="${escapeHTML(aliases[project.name] || '')}" placeholder="显示名称">
          </div>`).join('') || '<div class="empty-state compact">暂无项目</div>'}</div>`;
      }
      return `<section class="tool-setting-card" data-setting-tool="${tool.name}">
        <header class="tool-setting-head">
          <div><h3>${escapeHTML(tool.label)}</h3><span class="tool-data-state ${tool.hasData ? 'ready' : ''}">${tool.hasData ? '已检测到数据' : '暂无数据'}</span></div>
          <label class="visibility-control"><span>展示</span><span class="switch"><input type="checkbox" data-tool-visible="${tool.name}" ${tool.visible ? 'checked' : ''}><span></span></span></label>
        </header>
        <div class="tool-setting-detail">${detail}</div>
      </section>`;
    }).join('')}</div>`;
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
  $('tokenRefresh').addEventListener('click', () => loadData(false, true));
  $('tokenSettings').addEventListener('click', () => {
    openModal('tokenSettingsModal');
    renderSettings().catch((error) => { $('tokenSettingsBody').innerHTML = `<div class="empty-state compact">${escapeHTML(error.message)}</div>`; });
  });
  $('tokenSettingsSave').addEventListener('click', async () => {
    const saveButton = $('tokenSettingsSave');
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
    settings.hiddenTools = catalogTools
      .filter((tool) => !document.querySelector(`[data-tool-visible="${tool.name}"]`)?.checked)
      .map((tool) => tool.name);
    ['trae-intl', 'trae-cn'].forEach((name) => {
      settings[name] = document.querySelector(`[data-tool-path="${name}"]`)?.value.trim() || '';
    });
    settingsClaudeProjects.forEach((project, index) => {
      const visible = document.querySelector(`[data-project-visible="${index}"]`)?.checked;
      const alias = document.querySelector(`[data-project-alias="${index}"]`)?.value.trim();
      hiddenProjects = visible ? hiddenProjects.filter((name) => name !== project.name) : [...new Set([...hiddenProjects, project.name])];
      if (alias) aliases[project.name] = alias; else delete aliases[project.name];
    });
    settings.aliases = aliases;
    settings.hiddenProjects = hiddenProjects;
    try {
      await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      saveLocalSettings();
      closeModal('tokenSettingsModal');
      toast('设置已保存', '正在刷新受影响的数据', 'success');
      await loadTools();
      if (currentTool) await loadData(false);
    } catch (error) {
      toast('设置保存失败', error.message, 'error');
      return;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = '保存设置';
    }
  });
  window.addEventListener('themechange', renderAll);

  (async () => {
    loadLocalSettings();
    try {
      settings = await api('/api/config');
      aliases = { ...aliases, ...(settings.aliases || {}) };
      hiddenProjects = settings.hiddenProjects || hiddenProjects;
      await loadTools();
    } catch (error) {
      settings = {};
      toast('本地工具识别失败', error.message, 'error', 5000);
      availableTools = [];
      currentTool = '';
      renderToolSwitch();
    }
    if (currentTool) await loadData();
    else $('tokenLoading').classList.remove('show');
    setInterval(() => { if (!document.hidden) loadData(false, true); }, 60000);
  })();
})();
