// OZON Brand Guard — Popup Script v3.0.0
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  const DEFAULT_CONFIG = {
    brands: [],
    whitelist: [{ value: 'Ozon', type: 'name' }],
    bannedCountries: ['CN'],
    useCountryFilter: true,
    defaultComplaint: 'Продажа подделок на мой бренд',
    productComplaintText: '',
    productFileData: null,
    productFileName: '',
    skipProductFile: false,
    delaySeconds: 15,
    mode: 'scan',
    productMode: 'scan',
    dryRun: false,
    scheduleEnabled: false,
    scheduleInterval: 6,
    productScheduleEnabled: false,
    productScheduleInterval: 6,
    notificationsEnabled: true,
    log: [],
    // New: duplicate search
    duplicateWhitelist: [],
    duplicateDelay: 3,
    lastDuplicateResults: [],
    savedSkuInput: ''
  };

  const MAX_LOG_ENTRIES = 5000;
  let config = {};
  let accumulatedBrands = {};
  let techLogLines = [];
  let duplicateResults = []; // In-memory results for current session

  // ── Init ──
  async function init() {
    config = await loadConfig();
    techLogLines = await loadTechLogs();
    duplicateResults = config.lastDuplicateResults || [];
    trimLog();
    renderAll();
    bindEvents();
    updateStatusFromBackground();
  }

  // ── Tech log persistence ──
  function saveTechLogs() {
    chrome.storage.local.set({ obgTechLog: techLogLines.slice(-500) });
  }

  function loadTechLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.get('obgTechLog', (result) => resolve(result.obgTechLog || []));
    });
  }

  // ── Navigation (legacy) ──
  async function ensureOzonPage(targetUrl, urlCheck) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.includes(urlCheck)) return activeTab;
    const existing = await chrome.tabs.query({ url: targetUrl + '*' });
    if (existing.length > 0) {
      await chrome.tabs.update(existing[0].id, { active: true });
      await new Promise((r) => setTimeout(r, 1000));
      return existing[0];
    }
    if (activeTab && activeTab.url && activeTab.url.includes('seller.ozon.ru')) {
      await chrome.tabs.update(activeTab.id, { url: targetUrl });
      await waitForTabLoad(activeTab.id);
      return activeTab;
    }
    const newTab = await chrome.tabs.create({ url: targetUrl });
    await waitForTabLoad(newTab.id);
    return newTab;
  }

  function ensureSellersPage() { return ensureOzonPage('https://seller.ozon.ru/app/brand/sellers', 'seller.ozon.ru/app/brand/sellers'); }
  function ensureProductsPage() { return ensureOzonPage('https://seller.ozon.ru/app/brand-products/all', 'seller.ozon.ru/app/brand-products'); }

  function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
    });
  }

  // ── Script injection (legacy) ──
  async function ensureContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    } catch (e) { console.log('[OBG] inject:', e.message); }
    await new Promise((r) => setTimeout(r, 300));
  }

  async function ensureProductContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content-products.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    } catch (e) { console.log('[OBG] product inject:', e.message); }
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Messaging ──
  function safeSendToTab(tabId, msg) {
    chrome.tabs.sendMessage(tabId, msg, () => { if (chrome.runtime.lastError) { /* ignore */ } });
  }

  function safeSendRuntime(msg, cb) {
    chrome.runtime.sendMessage(msg, (r) => { if (chrome.runtime.lastError) { /* ignore */ } if (cb) cb(r); });
  }

  // ── Storage ──
  async function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('obgConfig', (result) => resolve({ ...DEFAULT_CONFIG, ...result.obgConfig }));
    });
  }

  async function saveConfig() {
    trimLog();
    return new Promise((resolve) => chrome.storage.local.set({ obgConfig: config }, resolve));
  }

  function trimLog() {
    if (config.log && config.log.length > MAX_LOG_ENTRIES) config.log = config.log.slice(-MAX_LOG_ENTRIES);
  }

  // ── Rendering ──
  function renderAll() {
    renderDuplicateSettings();
    renderDupWhitelist();
    renderDuplicateReport();
    renderDuplicateQuickResults();
    renderBrands();
    renderWhitelist();
    renderCountryFilters();
    renderLegacySettings();
    renderLog();
  }

  // ── NEW: Duplicate search rendering ──
  function renderDuplicateSettings() {
    const id = (s) => document.getElementById(s);
    id('skuInput').value = config.savedSkuInput || '';
    id('dupDelayRange').value = config.duplicateDelay || 3;
    id('dupDelayValue').textContent = (config.duplicateDelay || 3) + 'с';
    id('notificationsEnabled').checked = config.notificationsEnabled;
  }

  function renderDupWhitelist() {
    const container = document.getElementById('dupWhitelistEntries');
    if (!container) return;
    container.innerHTML = '';
    const wl = config.duplicateWhitelist || [];
    wl.forEach((entry, index) => {
      const typeLabel = { sku: 'SKU', seller: 'Продавец', inn: 'ИНН' }[entry.type] || entry.type;
      const div = document.createElement('div');
      div.className = 'whitelist-entry';
      div.innerHTML = `<span>${esc(entry.value)} <small style="color:#999">(${typeLabel})</small></span>
        <button class="btn-icon btn-icon--delete" data-index="${index}" title="Удалить">×</button>`;
      container.appendChild(div);
    });
    container.querySelectorAll('.btn-icon--delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        config.duplicateWhitelist.splice(parseInt(btn.dataset.index, 10), 1);
        await saveConfig(); renderDupWhitelist();
      });
    });
  }

  function renderDuplicateQuickResults() {
    const card = document.getElementById('dupQuickResults');
    const list = document.getElementById('dupQuickList');
    const countEl = document.getElementById('dupResultCount');
    if (!card || !list) return;

    if (duplicateResults.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    countEl.textContent = duplicateResults.length;

    // Group by source SKU
    const grouped = {};
    duplicateResults.forEach(r => {
      if (!grouped[r.sourceSku]) grouped[r.sourceSku] = [];
      grouped[r.sourceSku].push(r);
    });

    list.innerHTML = '';
    for (const [sku, items] of Object.entries(grouped)) {
      const group = document.createElement('div');
      group.className = 'dup-group';
      group.innerHTML = `<div class="dup-group__header">
        <strong>SKU ${esc(sku)}</strong>
        <span class="dup-group__count">${items.length} дубликатов</span>
      </div>`;
      const itemsDiv = document.createElement('div');
      itemsDiv.className = 'dup-group__items';
      items.slice(0, 5).forEach(item => {
        const d = document.createElement('div');
        d.className = 'dup-item';
        d.innerHTML = `<span class="dup-item__sku">${esc(item.sku)}</span>
          <span class="dup-item__price">${item.price ? item.price + ' ₽' : '—'}</span>
          <a href="${esc(item.url)}" target="_blank" class="dup-item__link" title="${esc(item.name)}">→</a>`;
        itemsDiv.appendChild(d);
      });
      if (items.length > 5) {
        const more = document.createElement('div');
        more.className = 'dup-item dup-item--more';
        more.textContent = `+ ещё ${items.length - 5}...`;
        itemsDiv.appendChild(more);
      }
      group.appendChild(itemsDiv);
      list.appendChild(group);
    }
  }

  function renderDuplicateReport() {
    const tbody = document.getElementById('reportTableBody');
    const emptyMsg = document.getElementById('reportEmpty');
    const countEl = document.getElementById('reportTotalCount');
    const table = document.getElementById('reportTable');
    if (!tbody) return;

    countEl.textContent = duplicateResults.length;
    if (duplicateResults.length === 0) {
      tbody.innerHTML = '';
      emptyMsg.style.display = 'block';
      table.style.display = 'none';
      return;
    }

    emptyMsg.style.display = 'none';
    table.style.display = 'table';
    tbody.innerHTML = '';

    duplicateResults.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(item.sourceSku || '')}</td>
        <td><strong>${esc(item.sku || '')}</strong></td>
        <td title="${esc(item.name || '')}">${esc((item.name || '').substring(0, 40))}${(item.name || '').length > 40 ? '...' : ''}</td>
        <td>${item.price ? esc(item.price) + ' ₽' : '—'}</td>
        <td>${esc(item.seller || '—')}</td>
        <td><a href="${esc(item.url || '')}" target="_blank" style="color:#005bff">Открыть</a></td>`;
      tbody.appendChild(tr);
    });
  }

  // ── Legacy rendering ──
  function renderLegacySettings() {
    const id = (s) => document.getElementById(s);

    // Mode switches (button-based)
    document.querySelectorAll('.mode-switch').forEach((sw) => {
      const name = sw.dataset.name;
      const val = config[name] || 'scan';
      sw.querySelectorAll('.mode-switch__btn').forEach((btn) => {
        btn.classList.toggle('mode-switch__btn--active', btn.dataset.value === val);
      });
    });

    id('delayRange').value = config.delaySeconds;
    id('delayValue').textContent = config.delaySeconds + 'с';
    id('dryRun').checked = config.dryRun;
    id('defaultComplaint').value = config.defaultComplaint;

    id('scheduleEnabled').checked = config.scheduleEnabled;
    id('scheduleInterval').value = config.scheduleInterval;
    id('productScheduleEnabled').checked = config.productScheduleEnabled;
    id('productScheduleInterval').value = config.productScheduleInterval;

    id('productComplaintText').value = config.productComplaintText || '';
    id('productFileName').textContent = config.productFileName || 'Из настроек бренда';
    id('skipProductFile').checked = config.skipProductFile;
  }

  function renderBrands() {
    const container = document.getElementById('brandsList');
    container.innerHTML = '';

    config.brands.forEach((brand) => {
      const template = document.getElementById('brandTemplate');
      const clone = template.content.cloneNode(true);
      const item = clone.querySelector('.brand-item');

      item.dataset.brandId = brand.id;
      item.querySelector('.brand-name').value = brand.name;
      item.querySelector('.brand-complaint').value = brand.complaint || '';

      const fileName = clone.querySelector('.file-name');
      fileName.textContent = brand.fileName || 'Файл не выбран';

      if (!brand.fileData) item.classList.add('brand-item--no-file');

      const fileBtn = clone.querySelector('.btn--small');
      const fileInput = clone.querySelector('.brand-file');
      fileBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          brand.fileData = reader.result;
          brand.fileName = file.name;
          fileName.textContent = file.name;
          item.classList.remove('brand-item--no-file');
          await saveConfig();
        };
        reader.readAsDataURL(file);
      });

      item.querySelector('.brand-name').addEventListener('change', async (e) => {
        brand.name = e.target.value.trim(); await saveConfig();
      });
      item.querySelector('.brand-complaint').addEventListener('change', async (e) => {
        brand.complaint = e.target.value.trim(); await saveConfig();
      });
      clone.querySelector('.btn-icon--delete').addEventListener('click', async () => {
        config.brands = config.brands.filter((b) => b.id !== brand.id);
        await saveConfig(); renderBrands();
      });

      container.appendChild(clone);
    });
  }

  function renderWhitelist() {
    const container = document.getElementById('whitelistEntries');
    container.innerHTML = '';
    config.whitelist.forEach((entry, index) => {
      const div = document.createElement('div');
      div.className = 'whitelist-entry';
      div.innerHTML = `<span>${entry.value} <small style="color:#999">(${entry.type === 'inn' ? 'ИНН' : 'Имя'})</small></span>
        <button class="btn-icon btn-icon--delete" data-index="${index}" title="Удалить">×</button>`;
      container.appendChild(div);
    });
    container.querySelectorAll('.btn-icon--delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        config.whitelist.splice(parseInt(btn.dataset.index, 10), 1);
        await saveConfig(); renderWhitelist();
      });
    });
  }

  function renderCountryFilters() {
    document.querySelectorAll('.country-filter').forEach((cb) => cb.checked = config.bannedCountries.includes(cb.value));
    document.getElementById('useCountryFilter').checked = config.useCountryFilter;
  }

  function renderLog() {
    const tbody = document.getElementById('logTableBody');
    const emptyMsg = document.getElementById('logEmpty');
    const exportBtns = document.getElementById('logExportBtns');
    const countEl = document.getElementById('logCount');
    const logLen = (config.log || []).length;
    countEl.textContent = `${logLen} / ${MAX_LOG_ENTRIES}`;

    if (!config.log || logLen === 0) {
      tbody.innerHTML = '';
      emptyMsg.style.display = 'block';
      document.getElementById('logTable').style.display = 'none';
      exportBtns.style.display = 'none';
      return;
    }

    emptyMsg.style.display = 'none';
    document.getElementById('logTable').style.display = 'table';
    exportBtns.style.display = 'flex';

    tbody.innerHTML = '';
    [...config.log].reverse().forEach((entry) => {
      const tr = document.createElement('tr');
      const cls = entry.success ? 'status-ok' : 'status-fail';
      const type = entry.country === 'товар' ? 'Товар' : (entry.country || 'Продавец');
      tr.innerHTML = `<td>${formatDate(entry.date)}</td><td><strong>${esc(entry.seller || '')}</strong></td>
        <td>${esc(entry.inn || '')}</td><td>${esc(entry.brand || '')}</td>
        <td>${esc(type)}</td><td class="${cls}">${entry.success ? 'OK' : 'Ошибка'}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderTechLog() {
    const container = document.getElementById('techLogList');
    if (techLogLines.length === 0) { container.innerHTML = '<div class="tech-log-line" style="color:#666">Нет событий</div>'; return; }
    container.innerHTML = '';
    techLogLines.slice(-200).forEach((line) => {
      const div = document.createElement('div');
      let cls = 'tech-log-line';
      if (line.includes('[DIAG]')) cls += ' tech-log-line--diag';
      else if (line.includes('✓')) cls += ' tech-log-line--success';
      else if (line.includes('❌') || line.includes('Ошибка')) cls += ' tech-log-line--error';
      else if (line.includes('⏳') || line.includes('Остановлено')) cls += ' tech-log-line--warning';
      div.className = cls;
      div.textContent = line;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function formatDate(ds) { const d = new Date(ds); return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

  // ── Export ──
  function getLogData() {
    return (config.log || []).map((e) => ({
      date: formatDate(e.date), seller: e.seller || '', inn: e.inn || '',
      brand: e.brand || '', type: e.country === 'товар' ? 'Товар' : (e.country || 'Продавец'),
      status: e.success ? 'OK' : 'Ошибка', error: e.error || ''
    }));
  }

  function exportCSV() {
    const rows = getLogData();
    const csv = '\uFEFF' + 'Дата;Продавец;ИНН;Бренд;Тип;Статус;Ошибка\n' +
      rows.map((r) => `${r.date};${r.seller};${r.inn};${r.brand};${r.type};${r.status};${r.error}`).join('\n');
    downloadFile(csv, 'brand-guard-complaints.csv', 'text/csv;charset=utf-8');
  }

  function exportExcel() {
    const rows = getLogData();
    let h = '<html><head><meta charset="UTF-8"></head><body><table border="1" style="border-collapse:collapse;font-family:Arial;font-size:12px">';
    h += '<tr style="background:#005bff;color:#fff;font-weight:bold"><th>Дата</th><th>Продавец</th><th>ИНН</th><th>Бренд</th><th>Тип</th><th>Статус</th><th>Ошибка</th></tr>';
    rows.forEach((r) => {
      h += `<tr style="background:${r.status === 'OK' ? '#e8f5e9' : '#ffebee'}"><td>${esc(r.date)}</td><td>${esc(r.seller)}</td><td>${esc(r.inn)}</td><td>${esc(r.brand)}</td><td>${esc(r.type)}</td><td style="color:${r.status === 'OK' ? 'green' : 'red'};font-weight:bold">${r.status}</td><td>${esc(r.error)}</td></tr>`;
    });
    downloadFile(h + '</table></body></html>', 'brand-guard-complaints.xls', 'application/vnd.ms-excel;charset=utf-8');
  }

  function exportTXT() {
    const rows = getLogData();
    const p = (s, n) => (s + ' '.repeat(n)).substring(0, n);
    let t = p('Дата', 18) + p('Продавец', 30) + p('ИНН', 15) + p('Бренд', 20) + p('Тип', 10) + p('Статус', 10) + 'Ошибка\n' + '-'.repeat(110) + '\n';
    rows.forEach((r) => { t += p(r.date, 18) + p(r.seller, 30) + p(r.inn, 15) + p(r.brand, 20) + p(r.type, 10) + p(r.status, 10) + r.error + '\n'; });
    downloadFile(t, 'brand-guard-complaints.txt', 'text/plain;charset=utf-8');
  }

  function downloadFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Events ──
  function bindEvents() {
    // Tabs
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab--active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('tab-content--active'));
        tab.classList.add('tab--active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('tab-content--active');
        if (tab.dataset.tab === 'report') { renderDuplicateReport(); renderTechLog(); }
      });
    });

    // ═══════════ NEW: Duplicate search events ═══════════
    document.getElementById('dupDelayRange').addEventListener('input', (e) => document.getElementById('dupDelayValue').textContent = e.target.value + 'с');
    document.getElementById('dupDelayRange').addEventListener('change', async (e) => { config.duplicateDelay = parseInt(e.target.value, 10); await saveConfig(); });
    document.getElementById('skuInput').addEventListener('change', async (e) => { config.savedSkuInput = e.target.value; await saveConfig(); });

    // Start duplicate search
    document.getElementById('btnStartDuplicates').addEventListener('click', async () => {
      const raw = document.getElementById('skuInput').value;
      const skus = raw.split(/[\s,;\n]+/).map(s => s.trim()).filter(s => /^\d{5,}$/.test(s));
      if (skus.length === 0) { alert('Введите хотя бы один SKU (числовой артикул OZON)'); return; }

      config.savedSkuInput = raw;
      await saveConfig();

      techLogLines = []; saveTechLogs();
      duplicateResults = [];
      renderDuplicateQuickResults();

      document.getElementById('btnStartDuplicates').style.display = 'none';
      document.getElementById('btnStopDuplicates').style.display = 'flex';
      document.getElementById('dupProgressCard').style.display = 'block';
      setRunningState(true);

      safeSendRuntime({ action: 'launchDuplicates', skus, config: { duplicateWhitelist: config.duplicateWhitelist, duplicateDelay: config.duplicateDelay } });
    });

    // Stop duplicate search
    document.getElementById('btnStopDuplicates').addEventListener('click', () => {
      safeSendRuntime({ action: 'stopDuplicates' });
      document.getElementById('btnStartDuplicates').style.display = 'flex';
      document.getElementById('btnStopDuplicates').style.display = 'none';
      setRunningState(false);
    });

    // Copy all SKUs
    const copySkuHandler = () => {
      const skuList = duplicateResults.map(r => r.sku).filter(Boolean);
      const unique = [...new Set(skuList)];
      navigator.clipboard.writeText(unique.join('\n')).then(() => {
        const btn = document.getElementById('btnCopyAllSkus');
        const origText = btn.textContent;
        btn.textContent = 'Скопировано!';
        setTimeout(() => btn.textContent = origText, 2000);
      });
    };
    document.getElementById('btnCopyAllSkus').addEventListener('click', copySkuHandler);
    document.getElementById('btnReportCopySkus').addEventListener('click', copySkuHandler);

    // Quick Excel export
    const excelHandler = () => exportDuplicatesExcel();
    document.getElementById('btnQuickExcel').addEventListener('click', excelHandler);
    document.getElementById('btnReportExcel').addEventListener('click', excelHandler);

    // Report CSV
    document.getElementById('btnReportCSV').addEventListener('click', () => exportDuplicatesCSV());

    // Go to report tab
    document.getElementById('btnGoReport').addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('tab-content--active'));
      document.querySelector('.tab[data-tab="report"]').classList.add('tab--active');
      document.getElementById('tab-report').classList.add('tab-content--active');
      renderDuplicateReport(); renderTechLog();
    });

    // Clear report
    document.getElementById('btnReportClear').addEventListener('click', async () => {
      if (!confirm('Очистить отчёт дубликатов?')) return;
      duplicateResults = [];
      config.lastDuplicateResults = [];
      await saveConfig();
      renderDuplicateReport();
      renderDuplicateQuickResults();
    });

    // Duplicate whitelist
    document.getElementById('btnAddDupWhitelist').addEventListener('click', async () => {
      const input = document.getElementById('dupWhitelistInput');
      const val = input.value.trim(); if (!val) return;
      const type = document.getElementById('dupWhitelistType').value;
      if (!config.duplicateWhitelist) config.duplicateWhitelist = [];
      config.duplicateWhitelist.push({ value: val, type });
      input.value = ''; await saveConfig(); renderDupWhitelist();
    });
    document.getElementById('dupWhitelistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btnAddDupWhitelist').click(); });

    // ═══════════ LEGACY: Brand protection events ═══════════
    document.querySelectorAll('.mode-switch').forEach((sw) => {
      sw.querySelectorAll('.mode-switch__btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = sw.dataset.name;
          const value = btn.dataset.value;
          config[name] = value;
          await saveConfig();
          sw.querySelectorAll('.mode-switch__btn').forEach((b) => b.classList.remove('mode-switch__btn--active'));
          btn.classList.add('mode-switch__btn--active');
        });
      });
    });

    document.getElementById('delayRange').addEventListener('input', (e) => document.getElementById('delayValue').textContent = e.target.value + 'с');
    document.getElementById('delayRange').addEventListener('change', async (e) => { config.delaySeconds = parseInt(e.target.value, 10); await saveConfig(); });
    document.getElementById('dryRun').addEventListener('change', async (e) => { config.dryRun = e.target.checked; await saveConfig(); });

    document.getElementById('btnStart').addEventListener('click', async () => {
      techLogLines = []; saveTechLogs();
      const activeBtn = document.querySelector('.mode-switch[data-name="mode"] .mode-switch__btn--active');
      if (activeBtn) config.mode = activeBtn.dataset.value;
      if (config.mode !== 'complain') config.mode = 'scan';
      await saveConfig();
      safeSendRuntime({ action: 'launchSellers', config });
      setRunningState(true);
    });

    document.getElementById('btnStop').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
      for (const t of tabs) safeSendToTab(t.id, { action: 'stop' });
      safeSendRuntime({ action: 'setRunning', running: false });
      setRunningState(false);
    });

    document.getElementById('btnStartProducts').addEventListener('click', async () => {
      techLogLines = []; saveTechLogs();
      const activeBtn = document.querySelector('.mode-switch--orange .mode-switch__btn--active');
      if (activeBtn) config.productMode = activeBtn.dataset.value;
      if (config.productMode !== 'complain') config.productMode = 'scan';
      await saveConfig();
      safeSendRuntime({ action: 'launchProducts', config });
      document.getElementById('btnStartProducts').style.display = 'none';
      document.getElementById('btnStopProducts').style.display = 'flex';
    });

    document.getElementById('btnStopProducts').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
      for (const t of tabs) safeSendToTab(t.id, { action: 'stopProducts' });
      safeSendRuntime({ action: 'setRunning', running: false });
      document.getElementById('btnStartProducts').style.display = 'flex';
      document.getElementById('btnStopProducts').style.display = 'none';
    });

    document.getElementById('scheduleEnabled').addEventListener('change', async (e) => { config.scheduleEnabled = e.target.checked; await saveConfig(); safeSendRuntime({ action: 'updateSchedule', config }); });
    document.getElementById('scheduleInterval').addEventListener('change', async (e) => { config.scheduleInterval = parseInt(e.target.value, 10); await saveConfig(); safeSendRuntime({ action: 'updateSchedule', config }); });
    document.getElementById('productScheduleEnabled').addEventListener('change', async (e) => { config.productScheduleEnabled = e.target.checked; await saveConfig(); safeSendRuntime({ action: 'updateProductSchedule', config }); });
    document.getElementById('productScheduleInterval').addEventListener('change', async (e) => { config.productScheduleInterval = parseInt(e.target.value, 10); await saveConfig(); safeSendRuntime({ action: 'updateProductSchedule', config }); });

    document.getElementById('btnScanBrands').addEventListener('click', async () => {
      const scanBtn = document.getElementById('btnScanBrands');
      scanBtn.disabled = true; scanBtn.textContent = 'Открываю...';
      try {
        const tab = await ensureSellersPage();
        scanBtn.textContent = 'Сканирую...';
        await ensureContentScript(tab.id);
        safeSendToTab(tab.id, { action: 'scanBrands' });
      } catch (e) {
        scanBtn.disabled = false;
        scanBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z"/></svg> Найти бренды на странице`;
      }
    });

    document.getElementById('btnAddBrand').addEventListener('click', async () => {
      config.brands.push({ id: 'brand_' + Date.now(), name: '', complaint: '', fileData: null, fileName: '' });
      await saveConfig(); renderBrands();
    });

    document.getElementById('btnAddWhitelist').addEventListener('click', async () => {
      const input = document.getElementById('whitelistInput');
      const val = input.value.trim(); if (!val) return;
      config.whitelist.push({ value: val, type: /^\d+$/.test(val) ? 'inn' : 'name' });
      input.value = ''; await saveConfig(); renderWhitelist();
    });
    document.getElementById('whitelistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btnAddWhitelist').click(); });

    document.querySelectorAll('.country-filter').forEach((cb) => cb.addEventListener('change', async () => {
      config.bannedCountries = Array.from(document.querySelectorAll('.country-filter:checked')).map((c) => c.value);
      await saveConfig();
    }));
    document.getElementById('useCountryFilter').addEventListener('change', async (e) => { config.useCountryFilter = e.target.checked; await saveConfig(); });

    document.getElementById('productComplaintText').addEventListener('change', async (e) => { config.productComplaintText = e.target.value.trim(); await saveConfig(); });
    document.getElementById('btnProductFileSelect').addEventListener('click', () => document.getElementById('productFile').click());
    document.getElementById('productFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        config.productFileData = reader.result; config.productFileName = file.name;
        document.getElementById('productFileName').textContent = file.name;
        await saveConfig();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('skipProductFile').addEventListener('change', async (e) => { config.skipProductFile = e.target.checked; await saveConfig(); });

    document.getElementById('defaultComplaint').addEventListener('change', async (e) => { config.defaultComplaint = e.target.value.trim(); await saveConfig(); });
    document.getElementById('notificationsEnabled').addEventListener('change', async (e) => { config.notificationsEnabled = e.target.checked; await saveConfig(); });

    // ═══════════ SHARED: Data management ═══════════
    document.getElementById('btnExport').addEventListener('click', () => downloadFile(JSON.stringify(config, null, 2), 'brand-guard-settings.json', 'application/json'));
    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { config = { ...DEFAULT_CONFIG, ...JSON.parse(await file.text()) }; await saveConfig(); renderAll(); alert('Импортировано'); }
      catch { alert('Ошибка файла'); }
    });
    document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
    document.getElementById('btnExportExcel').addEventListener('click', exportExcel);
    document.getElementById('btnExportTXT').addEventListener('click', exportTXT);
    document.getElementById('btnClearLog').addEventListener('click', async () => { if (!confirm('Очистить историю?')) return; config.log = []; await saveConfig(); renderLog(); });
    document.getElementById('btnResetAll').addEventListener('click', async () => { if (!confirm('Сбросить ВСЕ настройки?')) return; config = { ...DEFAULT_CONFIG }; await saveConfig(); renderAll(); });

    // Tech log actions
    document.getElementById('btnCopyTechLog').addEventListener('click', () => {
      const text = techLogLines.join('\n');
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btnCopyTechLog');
        btn.textContent = 'Скопировано!';
        setTimeout(() => btn.textContent = 'Копировать', 2000);
      });
    });
    document.getElementById('btnSaveTechLog').addEventListener('click', () => {
      downloadFile(techLogLines.join('\n'), 'brand-guard-techlog-' + Date.now() + '.txt', 'text/plain;charset=utf-8');
    });
    document.getElementById('btnClearTechLog').addEventListener('click', () => { techLogLines = []; saveTechLogs(); renderTechLog(); });
  }

  // ── NEW: Duplicate export functions ──
  function exportDuplicatesExcel() {
    if (duplicateResults.length === 0) return;
    let h = '<html><head><meta charset="UTF-8"></head><body><table border="1" style="border-collapse:collapse;font-family:Arial;font-size:12px">';
    h += '<tr style="background:#005bff;color:#fff;font-weight:bold"><th>Мой SKU</th><th>SKU дубликата</th><th>Название</th><th>Цена</th><th>Продавец</th><th>Ссылка</th></tr>';
    duplicateResults.forEach(r => {
      h += `<tr><td>${esc(r.sourceSku || '')}</td><td>${esc(r.sku || '')}</td><td>${esc(r.name || '')}</td><td>${r.price || ''}</td><td>${esc(r.seller || '')}</td><td><a href="${esc(r.url || '')}">${esc(r.url || '')}</a></td></tr>`;
    });
    const ts = new Date().toISOString().replace(/[:.]/g, '').substring(0, 15);
    downloadFile(h + '</table></body></html>', `duplicates_${ts}.xls`, 'application/vnd.ms-excel;charset=utf-8');
  }

  function exportDuplicatesCSV() {
    if (duplicateResults.length === 0) return;
    const csv = '\uFEFF' + 'Мой SKU;SKU дубликата;Название;Цена;Продавец;Ссылка\n' +
      duplicateResults.map(r => `${r.sourceSku || ''};${r.sku || ''};${(r.name || '').replace(/;/g, ',')};${r.price || ''};${(r.seller || '').replace(/;/g, ',')};${r.url || ''}`).join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '').substring(0, 15);
    downloadFile(csv, `duplicates_${ts}.csv`, 'text/csv;charset=utf-8');
  }

  // ── State ──
  function setRunningState(running) {
    document.getElementById('btnStart').style.display = running ? 'none' : 'flex';
    document.getElementById('btnStop').style.display = running ? 'flex' : 'none';
    const indicator = document.getElementById('statusIndicator');
    indicator.querySelector('.status-dot').className = 'status-dot ' + (running ? 'status-dot--running' : 'status-dot--idle');
    indicator.querySelector('.status-text').textContent = running ? 'Работает...' : 'Готов';
  }

  function updateStatusFromBackground() {
    safeSendRuntime({ action: 'getStatus' }, (r) => {
      if (!r) return;
      if (r.running) setRunningState(true);
      // Restore duplicate stats
      if (r.duplicateStats) {
        document.getElementById('dupProgressCard').style.display = 'block';
        updateDuplicateProgress(r.duplicateStats);
      }
      // Restore legacy stats
      if (r.sellerStats) {
        document.getElementById('statsCard').style.display = 'flex';
        document.getElementById('statTotal').textContent = r.sellerStats.total || 0;
        document.getElementById('statViolators').textContent = r.sellerStats.violators || 0;
        document.getElementById('statWhitelisted').textContent = r.sellerStats.whitelisted || 0;
        document.getElementById('statComplained').textContent = r.sellerStats.complained || 0;
      }
      if (r.productStats) {
        document.getElementById('productStatsCard').style.display = 'flex';
        document.getElementById('pStatTotal').textContent = r.productStats.total || 0;
        document.getElementById('pStatViolators').textContent = r.productStats.violators || 0;
        document.getElementById('pStatWhitelisted').textContent = r.productStats.whitelisted || 0;
        document.getElementById('pStatComplained').textContent = r.productStats.complained || 0;
      }
    });
  }

  function updateDuplicateProgress(stats) {
    const pct = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;
    document.getElementById('dupProgressFill').style.width = pct + '%';
    document.getElementById('dupProgressText').textContent = `${stats.processed} / ${stats.total}`;
    document.getElementById('dupStatProcessed').textContent = stats.processed;
    document.getElementById('dupStatFound').textContent = stats.found;
  }

  // ── Scanned brands (legacy) ──
  function renderScannedBrands(pageInfo) {
    const container = document.getElementById('scannedBrandsList');
    container.innerHTML = '';
    const brandList = Object.entries(accumulatedBrands).map(([name, count]) => ({ name, sellersCount: count })).sort((a, b) => b.sellersCount - a.sellersCount);

    if (pageInfo) {
      const d = document.createElement('div'); d.className = 'scan-page-info';
      d.innerHTML = `${pageInfo.from}-${pageInfo.to} из ${pageInfo.total}${pageInfo.to < pageInfo.total ? ' — перелистните и нажмите снова' : ''}`;
      container.appendChild(d);
    }
    if (brandList.length === 0) { container.innerHTML += '<p class="hint">Бренды не найдены</p>'; return; }

    brandList.forEach((brand) => {
      const div = document.createElement('label'); div.className = 'scanned-brand';
      const added = config.brands.some((b) => b.name.toLowerCase() === brand.name.toLowerCase());
      div.innerHTML = `<input type="checkbox" class="scanned-brand-cb" data-brand="${brand.name}" ${added ? 'checked disabled' : ''}><span class="scanned-brand__name">${brand.name}</span><span class="scanned-brand__sellers">${brand.sellersCount}</span>`;
      if (added) { div.classList.add('scanned-brand--mine'); div.title = 'Уже добавлен'; }
      container.appendChild(div);
    });

    const ad = document.createElement('div'); ad.className = 'scanned-actions';
    ad.innerHTML = `<button class="btn btn--primary" id="btnApplyScannedBrands" style="flex:1">Добавить выбранные</button><button class="btn btn--secondary" id="btnClearScanned">Сброс</button>`;
    container.appendChild(ad);

    document.getElementById('btnApplyScannedBrands').addEventListener('click', async () => {
      let added = 0;
      for (const cb of container.querySelectorAll('.scanned-brand-cb:checked:not(:disabled)')) {
        const n = cb.dataset.brand;
        if (!config.brands.some((b) => b.name.toLowerCase() === n.toLowerCase())) {
          config.brands.push({ id: 'brand_' + Date.now() + '_' + added, name: n, complaint: '', fileData: null, fileName: '' });
          if (!config.whitelist.some((w) => w.value.toLowerCase() === n.toLowerCase())) config.whitelist.push({ value: n, type: 'name' });
          added++;
        }
      }
      if (added > 0) { await saveConfig(); renderBrands(); renderWhitelist(); renderScannedBrands(pageInfo); }
    });
    document.getElementById('btnClearScanned').addEventListener('click', () => { accumulatedBrands = {}; container.innerHTML = ''; });
  }

  // ── Messages ──
  chrome.runtime.onMessage.addListener((msg) => {
    // ── NEW: Duplicate search messages ──
    if (msg.action === 'updateDuplicateStats') {
      document.getElementById('dupProgressCard').style.display = 'block';
      updateDuplicateProgress(msg.stats);
    }

    if (msg.action === 'duplicatePageDone') {
      // Accumulate results in memory
      if (msg.competitors && msg.competitors.length > 0) {
        for (const comp of msg.competitors) {
          if (!duplicateResults.some(r => r.sku === comp.sku && r.sourceSku === comp.sourceSku)) {
            duplicateResults.push(comp);
          }
        }
      }
      renderDuplicateQuickResults();
    }

    if (msg.action === 'doneDuplicates') {
      setRunningState(false);
      document.getElementById('btnStartDuplicates').style.display = 'flex';
      document.getElementById('btnStopDuplicates').style.display = 'none';
      // Save results to config for persistence
      if (msg.results && msg.results.length > 0) {
        duplicateResults = msg.results;
      }
      config.lastDuplicateResults = duplicateResults;
      saveConfig();
      renderDuplicateQuickResults();
      renderDuplicateReport();
    }

    // ── LEGACY: Brand protection messages ──
    if (msg.action === 'updateStats') {
      document.getElementById('statsCard').style.display = 'flex';
      document.getElementById('statTotal').textContent = msg.stats.total || 0;
      document.getElementById('statViolators').textContent = msg.stats.violators || 0;
      document.getElementById('statWhitelisted').textContent = msg.stats.whitelisted || 0;
      document.getElementById('statComplained').textContent = msg.stats.complained || 0;
    }
    if (msg.action === 'done') { setRunningState(false); loadConfig().then((c) => { config = c; renderLog(); }); }
    if (msg.action === 'logUpdate') { loadConfig().then((c) => { config = c; renderLog(); }); }
    if (msg.action === 'techLog') {
      techLogLines.push(msg.text);
      if (techLogLines.length > 500) techLogLines = techLogLines.slice(-500);
      saveTechLogs();
      // Update tech log if report tab is visible
      const reportTab = document.getElementById('tab-report');
      if (reportTab && reportTab.classList.contains('tab-content--active')) {
        renderTechLog();
      }
    }

    if (msg.action === 'updateProductStats') {
      document.getElementById('productStatsCard').style.display = 'flex';
      document.getElementById('pStatTotal').textContent = msg.stats.total || 0;
      document.getElementById('pStatViolators').textContent = msg.stats.violators || 0;
      document.getElementById('pStatWhitelisted').textContent = msg.stats.whitelisted || 0;
      document.getElementById('pStatComplained').textContent = msg.stats.complained || 0;
    }
    if (msg.action === 'doneProducts') {
      document.getElementById('btnStartProducts').style.display = 'flex';
      document.getElementById('btnStopProducts').style.display = 'none';
      loadConfig().then((c) => { config = c; renderLog(); });
    }

    if (msg.action === 'scanBrandsResult') {
      const btn = document.getElementById('btnScanBrands'); btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z"/></svg> Найти бренды на странице`;
      if (msg.brands && msg.brands.length > 0) msg.brands.forEach((b) => accumulatedBrands[b.name] = (accumulatedBrands[b.name] || 0) + b.sellersCount);
      renderScannedBrands(msg.pageInfo || null);
    }
  });

  init();
})();
