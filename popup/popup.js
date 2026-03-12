// OZON Brand Guard — Popup Script v2.0.0
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
    log: []
  };

  const MAX_LOG_ENTRIES = 5000;
  let config = {};
  let accumulatedBrands = {};
  let techLogLines = [];

  // ── Init ──
  async function init() {
    config = await loadConfig();
    trimLog();
    renderAll();
    bindEvents();
    updateStatusFromBackground();
  }

  // ── Navigation ──
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

  // ── Script injection ──
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
    renderBrands();
    renderWhitelist();
    renderCountryFilters();
    renderSettings();
    renderLog();
  }

  function renderSettings() {
    const q = (s) => document.querySelector(s);
    const id = (s) => document.getElementById(s);

    q(`input[name="mode"][value="${config.mode || 'scan'}"]`).checked = true;
    q(`input[name="productMode"][value="${config.productMode || 'scan'}"]`).checked = true;

    id('delayRange').value = config.delaySeconds;
    id('delayValue').textContent = config.delaySeconds + 'с';
    id('dryRun').checked = config.dryRun;
    id('defaultComplaint').value = config.defaultComplaint;
    id('notificationsEnabled').checked = config.notificationsEnabled;

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
      });
    });

    // Sub-tabs
    document.querySelectorAll('.sub-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('sub-tab--active'));
        document.querySelectorAll('.sub-content').forEach((c) => c.classList.remove('sub-content--active'));
        tab.classList.add('sub-tab--active');
        document.getElementById('subtab-' + tab.dataset.subtab).classList.add('sub-content--active');
        if (tab.dataset.subtab === 'technical') renderTechLog();
      });
    });

    // ── Главная: Sellers ──
    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', async (e) => { config.mode = e.target.value; await saveConfig(); }));
    document.querySelectorAll('input[name="productMode"]').forEach((r) => r.addEventListener('change', async (e) => { config.productMode = e.target.value; await saveConfig(); }));

    document.getElementById('delayRange').addEventListener('input', (e) => document.getElementById('delayValue').textContent = e.target.value + 'с');
    document.getElementById('delayRange').addEventListener('change', async (e) => { config.delaySeconds = parseInt(e.target.value, 10); await saveConfig(); });
    document.getElementById('dryRun').addEventListener('change', async (e) => { config.dryRun = e.target.checked; await saveConfig(); });

    // Start sellers
    document.getElementById('btnStart').addEventListener('click', async () => {
      techLogLines = [];
      const btn = document.getElementById('btnStart');
      btn.disabled = true; btn.textContent = 'Открываю...';
      try {
        const tab = await ensureSellersPage();
        await ensureContentScript(tab.id);
        safeSendToTab(tab.id, { action: 'start', config });
        setRunningState(true);
      } catch (e) { alert('Не удалось открыть OZON Seller.'); }
      finally { btn.disabled = false; btn.textContent = '▶ Запустить продавцов'; }
    });

    document.getElementById('btnStop').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/app/brand/sellers*' });
      for (const t of tabs) safeSendToTab(t.id, { action: 'stop' });
      setRunningState(false);
    });

    // Start products
    document.getElementById('btnStartProducts').addEventListener('click', async () => {
      techLogLines = [];
      const btn = document.getElementById('btnStartProducts');
      btn.disabled = true; btn.textContent = 'Открываю...';
      try {
        const tab = await ensureProductsPage();
        await ensureProductContentScript(tab.id);
        safeSendToTab(tab.id, { action: 'startProducts', config });
        document.getElementById('btnStartProducts').style.display = 'none';
        document.getElementById('btnStopProducts').style.display = 'flex';
      } catch (e) { alert('Не удалось открыть страницу товаров.'); }
      finally { btn.disabled = false; btn.textContent = '▶ Запустить товары'; }
    });

    document.getElementById('btnStopProducts').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/app/brand-products/*' });
      for (const t of tabs) safeSendToTab(t.id, { action: 'stopProducts' });
      document.getElementById('btnStartProducts').style.display = 'flex';
      document.getElementById('btnStopProducts').style.display = 'none';
    });

    // Schedule — sellers
    document.getElementById('scheduleEnabled').addEventListener('change', async (e) => {
      config.scheduleEnabled = e.target.checked; await saveConfig();
      safeSendRuntime({ action: 'updateSchedule', config });
    });
    document.getElementById('scheduleInterval').addEventListener('change', async (e) => {
      config.scheduleInterval = parseInt(e.target.value, 10); await saveConfig();
      safeSendRuntime({ action: 'updateSchedule', config });
    });

    // Schedule — products
    document.getElementById('productScheduleEnabled').addEventListener('change', async (e) => {
      config.productScheduleEnabled = e.target.checked; await saveConfig();
      safeSendRuntime({ action: 'updateProductSchedule', config });
    });
    document.getElementById('productScheduleInterval').addEventListener('change', async (e) => {
      config.productScheduleInterval = parseInt(e.target.value, 10); await saveConfig();
      safeSendRuntime({ action: 'updateProductSchedule', config });
    });

    // ── Настройки: Brands ──
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

    // Whitelist
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

    // Product settings
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

    // General settings
    document.getElementById('defaultComplaint').addEventListener('change', async (e) => { config.defaultComplaint = e.target.value.trim(); await saveConfig(); });
    document.getElementById('notificationsEnabled').addEventListener('change', async (e) => { config.notificationsEnabled = e.target.checked; await saveConfig(); });

    // Data management
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
    safeSendRuntime({ action: 'getStatus' }, (r) => { if (r && r.running) setRunningState(true); });
  }

  // ── Scanned brands ──
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
    if (msg.action === 'updateStats') {
      document.getElementById('statsCard').style.display = 'flex';
      document.getElementById('statTotal').textContent = msg.stats.total || 0;
      document.getElementById('statViolators').textContent = msg.stats.violators || 0;
      document.getElementById('statWhitelisted').textContent = msg.stats.whitelisted || 0;
      document.getElementById('statComplained').textContent = msg.stats.complained || 0;
    }
    if (msg.action === 'done') { setRunningState(false); loadConfig().then((c) => { config = c; renderLog(); }); }
    if (msg.action === 'logUpdate') { loadConfig().then((c) => { config = c; renderLog(); }); }
    if (msg.action === 'techLog') { techLogLines.push(msg.text); if (techLogLines.length > 500) techLogLines = techLogLines.slice(-500); }

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
