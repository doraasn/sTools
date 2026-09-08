(() => {
  'use strict';
  const { $, api, escapeHTML, highlight, toast, openModal, closeModal, formatNumber, formatDuration } = window.dTools;
  let tables = {};
  let columnCache = {};
  let connectionReady = { source: false, target: false };
  let testedConnection = { source: '', target: '' };
  let saveTimer = null;
  let saveQueue = Promise.resolve(true);
  let activeConfigName = '';
  let activeTableConfigName = '';
  let running = false;
  let nameAction = null;

  const ids = (side) => ({
    host: $(`${side}Host`), port: $(`${side}Port`), dbType: $(`${side}DbType`),
    user: $(`${side}User`), password: $(`${side}Password`), database: $(`${side}Database`),
  });

  function readConnections() {
    const read = (side) => {
      const fields = ids(side);
      return {
        host: fields.host.value.trim(), port: Number(fields.port.value) || 3306,
        dbType: fields.dbType.value || 'mysql', user: fields.user.value.trim(),
        password: fields.password.value, database: fields.database.value.trim(),
      };
    };
    return { source: read('source'), target: read('target') };
  }

  function writeConnections(config = {}) {
    for (const side of ['source', 'target']) {
      const fields = ids(side);
      const value = config[side] || {};
      fields.host.value = value.host || '';
      fields.port.value = value.port || 3306;
      fields.dbType.value = value.dbType || 'mysql';
      fields.user.value = value.user || '';
      fields.password.value = value.password || '';
      fields.database.value = value.database || '';
    }
  }

  const connectionFingerprint = (config) => JSON.stringify([
    config.dbType || 'mysql', config.host || '', Number(config.port) || 3306,
    config.user || '', config.password || '', config.database || '',
  ]);

  function setConnectionState(side, result = null, testedConfig = null) {
    const element = $(`${side}State`);
    element.classList.remove('success', 'error');
    if (!result) {
      element.innerHTML = '<span class="dot"></span>未检测';
      connectionReady[side] = false;
      testedConnection[side] = '';
      return;
    }
    connectionReady[side] = Boolean(result.ok);
    testedConnection[side] = result.ok && testedConfig ? connectionFingerprint(testedConfig) : '';
    element.classList.add(result.ok ? 'success' : 'error');
    element.innerHTML = `<span class="dot ${result.ok ? 'success' : 'danger'}"></span>${escapeHTML(result.ok ? `${result.version} · ${result.tables} 表` : '连接失败')}`;
    element.title = result.error || '';
  }

  function setSaveState(text, state = '') {
    $('saveState').textContent = text;
    $('saveDot').className = `dot ${state}`.trim();
  }

  async function loadDbTypes() {
    const types = await api('/api/sync/db-types');
    const options = Object.entries(types).map(([value, item]) => `<option value="${escapeHTML(value)}">${escapeHTML(item.label)}</option>`).join('');
    $('sourceDbType').innerHTML = options;
    $('targetDbType').innerHTML = options;
  }

  async function loadConfigList(selected = '') {
    const names = await api('/api/sync/configs');
    $('configSelect').innerHTML = names.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    if (selected) $('configSelect').value = selected;
    return names;
  }

  function fillTableConfigList(names, selected = '') {
    $('tableConfigSelect').innerHTML = names.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    if (selected) $('tableConfigSelect').value = selected;
  }

  async function loadActiveConfig() {
    try {
      const result = await api('/api/sync/config');
      activeConfigName = result.config?.name || '';
      activeTableConfigName = result.tableConfig?.name || '';
      writeConnections(result.config || {});
      tables = result.tableConfig?.tables || {};
      await loadConfigList(result.config?.name || '');
      fillTableConfigList(result.tableConfigNames || [], result.tableConfig?.name || '');
      columnCache = {};
      setConnectionState('source'); setConnectionState('target');
      renderTables();
      setSaveState('配置已加载', 'success');
    } catch (error) {
      if (error.message === '无配置') openNameModal('新建连接方案', '输入一个便于识别的名称', '', createConfigAction);
      else toast('配置加载失败', error.message, 'error');
    }
  }

  function saveConfig(showToast = false) {
    // 调用时立即拍摄快照，后续即使切换方案也只会保存到原来的目标。
    const payload = {
      configName: activeConfigName,
      tableConfigName: activeTableConfigName,
      config: readConnections(),
      tableConfig: { tables: JSON.parse(JSON.stringify(tables)) },
    };
    saveQueue = saveQueue.catch(() => false).then(async () => {
      setSaveState('正在保存');
      try {
        await api('/api/sync/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setSaveState('已自动保存', 'success');
        if (showToast) toast('配置已保存', '', 'success');
        return true;
      } catch (error) {
        setSaveState('保存失败', 'danger');
        if (showToast) toast('保存失败', error.message, 'error');
        return false;
      }
    });
    return saveQueue;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    setSaveState('等待保存');
    saveTimer = setTimeout(() => { saveTimer = null; saveConfig(false); }, 800);
  }

  function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      return saveConfig(false);
    }
    return saveQueue.catch(() => false);
  }

  function openNameModal(title, hint, value, action) {
    $('nameModalTitle').textContent = title;
    $('nameModalHint').textContent = hint;
    $('nameModalInput').value = value || '';
    nameAction = action;
    openModal('nameModal');
  }

  async function confirmNameModal() {
    const value = $('nameModalInput').value.trim();
    if (!value || !nameAction) return;
    $('nameModalConfirm').disabled = true;
    try { await nameAction(value); closeModal('nameModal'); }
    catch (error) { toast('操作失败', error.message, 'error'); }
    finally { $('nameModalConfirm').disabled = false; }
  }

  const createConfigAction = async (name) => {
    await flushPendingSave();
    await api('/api/sync/config/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    await loadActiveConfig(); toast('连接方案已创建', name, 'success');
  };
  const renameConfigAction = async (name) => {
    await flushPendingSave();
    await api('/api/sync/config/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, oldName: activeConfigName }) });
    activeConfigName = name;
    await loadConfigList(name); toast('连接方案已重命名', name, 'success');
  };
  const createTableConfigAction = async (name) => {
    await flushPendingSave();
    const result = await api('/api/sync/table-config/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, configName: activeConfigName, copyFrom: activeTableConfigName }) });
    activeTableConfigName = name;
    tables = result.tables || {}; const names = await api(`/api/sync/table-configs?config=${encodeURIComponent(activeConfigName)}`); fillTableConfigList(names, name); renderTables(); toast('表策略已创建', name, 'success');
  };
  const renameTableConfigAction = async (name) => {
    await flushPendingSave();
    await api('/api/sync/table-config/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, configName: activeConfigName, oldName: activeTableConfigName }) });
    activeTableConfigName = name;
    const names = await api(`/api/sync/table-configs?config=${encodeURIComponent(activeConfigName)}`); fillTableConfigList(names, name); toast('表策略已重命名', name, 'success');
  };

  async function testConnections() {
    const button = $('testConnections');
    button.disabled = true; button.innerHTML = '<span class="spinner"></span>正在连接';
    appendConsole('正在并行测试源库与目标库...', 'info');
    try {
      const connections = readConnections();
      const result = await api('/api/sync/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connections) });
      setConnectionState('source', result.source, connections.source); setConnectionState('target', result.target, connections.target);
      for (const side of ['source', 'target']) appendConsole(`${side === 'source' ? '源库' : '目标库'}：${result[side].ok ? `${result[side].version}，${result[side].tables} 张表` : result[side].error}`, result[side].ok ? 'success' : 'error');
      if (result.source.ok) await loadTables();
      if (result.source.ok && result.target.ok) { toast('连接测试通过', '源库和目标库均可用', 'success'); await saveConfig(false); }
      else toast('连接测试未通过', '请查看连接卡片或任务控制台', 'warning');
    } catch (error) { toast('连接测试失败', error.message, 'error'); appendConsole(error.message, 'error'); }
    finally { button.disabled = false; button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"></path><circle cx="12" cy="12" r="9"></circle></svg>测试连接'; }
  }

  async function loadTables() {
    if (!readConnections().source.host) return;
    $('reloadTables').disabled = true;
    try {
      const result = await api('/api/sync/tables-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readConnections().source) });
      columnCache = result.columns || {};
      const nextTables = {};
      (result.tables || []).forEach((name) => {
        nextTables[name] = tables[name] || { enable: false, mode: 'time', timeRange: '', timeField: '' };
        if (!nextTables[name].timeField) nextTables[name].timeField = detectTimeField(columnCache[name] || []);
      });
      tables = nextTables;
      renderTables(); scheduleSave();
      appendConsole(`已加载 ${result.tables.length} 张源库表`, 'success');
    } catch (error) { toast('数据表加载失败', error.message, 'error'); appendConsole(error.message, 'error'); }
    finally { $('reloadTables').disabled = false; }
  }

  function detectTimeField(columns) {
    const types = new Set(['datetime', 'timestamp', 'date']);
    const candidates = columns.filter((column) => types.has(column.type));
    const priorities = ['create_time', 'update_time', 'pub_time', 'display_time', 'createTime', 'updateTime', 'collect_time', 'time', 'date'];
    return priorities.find((name) => candidates.some((column) => column.name === name)) || candidates[0]?.name || '';
  }

  function renderTables() {
    const query = $('tableSearch').value.trim();
    const entries = Object.entries(tables).filter(([name]) => !query || name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b[1].enable) - Number(a[1].enable) || a[0].localeCompare(b[0]));
    const selected = Object.values(tables).filter((table) => table.enable).length;
    $('selectedTables').textContent = selected;
    $('tableSummary').textContent = `${Object.keys(tables).length} 张表 · ${selected} 张已选择`;
    $('masterTable').checked = entries.length > 0 && entries.every(([, table]) => table.enable);
    $('masterTable').indeterminate = entries.some(([, table]) => table.enable) && !entries.every(([, table]) => table.enable);
    if (!entries.length) {
      $('tableBody').innerHTML = `<tr><td colspan="5"><div class="empty-state">${Object.keys(tables).length ? '没有匹配的数据表' : '请先测试源库连接'}</div></td></tr>`;
      return;
    }
    $('tableBody').innerHTML = entries.map(([name, config]) => {
      const columns = columnCache[name] || [];
      const options = ['', ...columns.map((column) => column.name)].map((column) => `<option value="${escapeHTML(column)}" ${column === config.timeField ? 'selected' : ''}>${escapeHTML(column || '不使用时间字段')}</option>`).join('');
      return `<tr class="${config.enable ? 'enabled' : ''}">
        <td class="check-cell"><input type="checkbox" data-table="${escapeHTML(name)}" data-key="enable" ${config.enable ? 'checked' : ''}></td>
        <td><span class="table-name">${highlight(name, query)}</span></td>
        <td><select class="table-control" data-table="${escapeHTML(name)}" data-key="mode"><option value="time" ${config.mode === 'time' ? 'selected' : ''}>时间范围</option><option value="all" ${config.mode === 'all' ? 'selected' : ''}>全量同步</option></select></td>
        <td><input class="table-control" data-table="${escapeHTML(name)}" data-key="timeRange" value="${escapeHTML(config.timeRange || '')}" placeholder="2026-08-01 ~ 2026-08-06" ${config.mode === 'all' ? 'disabled' : ''}></td>
        <td><select class="table-control" data-table="${escapeHTML(name)}" data-key="timeField" ${config.mode === 'all' ? 'disabled' : ''}>${options}</select></td>
      </tr>`;
    }).join('');
  }

  function appendConsole(message, level = 'info') {
    const consoleElement = $('runConsole');
    consoleElement.querySelector('.console-placeholder')?.remove();
    const line = document.createElement('div');
    line.className = `console-line ${level}`;
    line.innerHTML = `<time>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</time><i></i><span>${escapeHTML(message)}</span>`;
    consoleElement.appendChild(line);
    consoleElement.scrollTop = consoleElement.scrollHeight;
  }

  function setRunning(value) {
    running = value;
    const button = $('startSync');
    button.disabled = value;
    button.classList.toggle('running', value);
    button.innerHTML = value ? '<span class="spinner"></span>同步进行中' : '<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"></path></svg>开始同步';
  }

  async function startSync() {
    if (running) return;
    const enabledCount = Object.values(tables).filter((table) => table.enable).length;
    if (!enabledCount) { toast('没有选择数据表', '请至少选择一张表', 'warning'); return; }
    const currentConnections = readConnections();
    const connectionChanged = ['source', 'target'].some((side) => (
      testedConnection[side] !== connectionFingerprint(currentConnections[side])
    ));
    if (!connectionReady.source || !connectionReady.target || connectionChanged) { toast('连接尚未就绪', '连接信息已变化，请重新测试源库和目标库', 'warning'); return; }
    // 在第一次异步等待前锁定按钮，避免双击或快捷键并发启动两个请求。
    setRunning(true);
    if (!await saveConfig(false)) {
      toast('配置保存失败', '同步任务未启动，请先检查配置', 'error');
      setRunning(false);
      return;
    }
    $('runStatus').textContent = '任务运行中';
    appendConsole(`启动同步，共 ${enabledCount} 张表`, 'info');
    try {
      const response = await fetch('/api/sync/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...readConnections(), tables }) });
      if (!response.ok || !response.body) throw new Error(`同步请求失败 (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.msg !== '__DONE__') appendConsole(event.msg, event.level || 'info');
          if (event.summary) $('runStatus').textContent = `${event.summary.failed ? '部分完成' : '已完成'} · ${formatDuration(event.summary.elapsed)}`;
          if (event.msg === '__DONE__') {
            if (event.status === 'success') toast('同步完成', '所有数据表均已提交', 'success');
            else if (event.status === 'partial') toast('同步部分完成', '失败表已回滚，请查看控制台', 'warning', 5000);
            else toast('同步失败', '请查看任务控制台', 'error');
          }
        }
        if (done) break;
      }
    } catch (error) { appendConsole(`连接中断: ${error.message}`, 'error'); toast('同步异常', error.message, 'error'); $('runStatus').textContent = '任务异常'; }
    finally { setRunning(false); }
  }

  $('saveSyncConfig').addEventListener('click', () => saveConfig(true));
  $('testConnections').addEventListener('click', testConnections);
  $('reloadTables').addEventListener('click', loadTables);
  $('startSync').addEventListener('click', startSync);
  $('clearRunLog').addEventListener('click', () => { $('runConsole').innerHTML = '<div class="console-placeholder"><span>&gt;_</span><p>控制台已清空。</p></div>'; });
  $('tableSearch').addEventListener('input', renderTables);
  $('masterTable').addEventListener('change', (event) => {
    const query = $('tableSearch').value.trim().toLowerCase();
    Object.entries(tables).forEach(([name, table]) => { if (!query || name.toLowerCase().includes(query)) table.enable = event.target.checked; });
    renderTables(); scheduleSave();
  });
  $('tableBody').addEventListener('change', (event) => {
    const element = event.target;
    const table = element.dataset.table;
    const key = element.dataset.key;
    if (!table || !key || !tables[table]) return;
    tables[table][key] = element.type === 'checkbox' ? element.checked : element.value;
    renderTables(); scheduleSave();
  });
  document.querySelectorAll('[data-connection]').forEach((container) => {
    const handleConnectionChange = () => {
      setConnectionState(container.dataset.connection);
      scheduleSave();
    };
    container.addEventListener('input', handleConnectionChange);
    container.addEventListener('change', handleConnectionChange);
  });
  document.querySelectorAll('.password-toggle').forEach((button) => button.addEventListener('click', () => {
    const input = $(button.dataset.password); input.type = input.type === 'password' ? 'text' : 'password';
  }));

  $('configSelect').addEventListener('change', async () => {
    const select = $('configSelect');
    const nextName = select.value;
    select.disabled = true;
    try {
      await flushPendingSave();
      const result = await api('/api/sync/config/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nextName }) });
      activeConfigName = result.config?.name || nextName;
      activeTableConfigName = result.tableConfig?.name || '';
      writeConnections(result.config); tables = result.tableConfig?.tables || {}; columnCache = {}; fillTableConfigList(result.tableConfigNames || [], activeTableConfigName); setConnectionState('source'); setConnectionState('target'); renderTables();
    } catch (error) {
      select.value = activeConfigName;
      toast('切换连接方案失败', error.message, 'error');
    } finally { select.disabled = false; }
  });
  $('tableConfigSelect').addEventListener('change', async () => {
    const select = $('tableConfigSelect');
    const nextName = select.value;
    select.disabled = true;
    try {
      await flushPendingSave();
      const result = await api('/api/sync/table-config/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nextName, configName: activeConfigName }) });
      activeTableConfigName = result.name || nextName;
      tables = result.tables || {}; renderTables();
    } catch (error) {
      select.value = activeTableConfigName;
      toast('切换表策略失败', error.message, 'error');
    } finally { select.disabled = false; }
  });
  $('createConfig').addEventListener('click', () => openNameModal('新建连接方案', '例如：开发环境、本地备份', '', createConfigAction));
  $('renameConfig').addEventListener('click', () => openNameModal('重命名连接方案', '名称仅用于本地识别', $('configSelect').value, renameConfigAction));
  $('createTableConfig').addEventListener('click', () => openNameModal('复制表策略', `将复制“${$('tableConfigSelect').value}”的配置`, '', createTableConfigAction));
  $('renameTableConfig').addEventListener('click', () => openNameModal('重命名表策略', '当前策略中的表配置不会改变', $('tableConfigSelect').value, renameTableConfigAction));
  $('nameModalConfirm').addEventListener('click', confirmNameModal);
  $('nameModalInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') confirmNameModal(); });
  $('batchTime').addEventListener('click', () => {
    if (!Object.values(tables).some((table) => table.enable && table.mode !== 'all')) { toast('没有可设置的表', '请选择使用时间模式的数据表', 'warning'); return; }
    openModal('batchTimeModal');
  });
  $('batchTimeConfirm').addEventListener('click', () => {
    const value = $('batchTimeInput').value.trim();
    Object.values(tables).forEach((table) => { if (table.enable && table.mode !== 'all') table.timeRange = value; });
    renderTables(); scheduleSave(); closeModal('batchTimeModal'); toast('时间范围已应用', '', 'success');
  });
  document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); startSync(); } });

  (async () => {
    try {
      await loadDbTypes();
      const exists = await api('/api/sync/config/exists');
      if (!exists.exists) openNameModal('新建连接方案', '先创建方案，再填写源库和目标库信息', '', createConfigAction);
      else await loadActiveConfig();
    } catch (error) { toast('同步工作台初始化失败', error.message, 'error', 5000); }
  })();
})();
