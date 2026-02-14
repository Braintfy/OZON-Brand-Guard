// OZON Brand Guard — Popup Script
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  // ── Default config ──
  const DEFAULT_CONFIG = {
    brands: [],
    whitelist: [
      { value: 'Ozon', type: 'name' }
    ],
    bannedCountries: ['CN'],
    useCountryFilter: true,
    defaultComplaint: 'Продажа подделок на мой бренд',
    delaySeconds: 20,
    mode: 'scan',
    dryRun: false,
    scheduleEnabled: false,
    scheduleInterval: 6,
    notificationsEnabled: true,
    log: []
  };

  const MAX_LOG_ENTRIES = 5000;

  let config = {};
  let accumulatedBrands = {};
  let techLogLines = []; // Technical logs from current session

  // ── Init ──
  async function init() {
    config = await loadConfig();
    trimLog();
    renderAll();
    bindEvents();
    updateStatusFromBackground();
  }

  // ── Ensure content script is injected ──
  async function ensureContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css']
      });
    } catch (e) {
      console.log('[OBG] Content script inject:', e.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  function safeSendToTab(tabId, msg) {
    chrome.tabs.sendMessage(tabId, msg, () => {
      if (chrome.runtime.lastError) {
        console.log('[OBG] Tab message error:', chrome.runtime.lastError.message);
      }
    });
  }

  function safeSendRuntime(msg, callback) {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[OBG] Runtime message error:', chrome.runtime.lastError.message);
      }
      if (callback) callback(response);
    });
  }

  // ── Storage ──
  async function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('obgConfig', (result) => {
        resolve({ ...DEFAULT_CONFIG, ...result.obgConfig });
      });
    });
  }

  async function saveConfig() {
    trimLog();
    return new Promise((resolve) => {
      chrome.storage.local.set({ obgConfig: config }, resolve);
    });
  }

  function trimLog() {
    if (config.log && config.log.length > MAX_LOG_ENTRIES) {
      config.log = config.log.slice(-MAX_LOG_ENTRIES);
    }
  }

  // ── Rendering ──
  function renderAll() {
    renderBrands();
    renderWhitelist();
    renderCountryFilters();
    renderSettings();
    renderLog();
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

      // Red highlight if no file
      if (!brand.fileData) {
        item.classList.add('brand-item--no-file');
      }

      // File select button
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

      // Brand name change
      item.querySelector('.brand-name').addEventListener('change', async (e) => {
        brand.name = e.target.value.trim();
        await saveConfig();
      });

      // Complaint text change
      item.querySelector('.brand-complaint').addEventListener('change', async (e) => {
        brand.complaint = e.target.value.trim();
        await saveConfig();
      });

      // Delete
      clone.querySelector('.btn-icon--delete').addEventListener('click', async () => {
        config.brands = config.brands.filter((b) => b.id !== brand.id);
        await saveConfig();
        renderBrands();
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
      div.innerHTML = `
        <span>${entry.value} <small style="color:#999">(${entry.type === 'inn' ? 'ИНН' : 'Имя'})</small></span>
        <button class="btn-icon btn-icon--delete" data-index="${index}" title="Удалить">×</button>
      `;
      container.appendChild(div);
    });

    container.querySelectorAll('.btn-icon--delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index, 10);
        config.whitelist.splice(idx, 1);
        await saveConfig();
        renderWhitelist();
      });
    });
  }

  function renderCountryFilters() {
    document.querySelectorAll('.country-filter').forEach((cb) => {
      cb.checked = config.bannedCountries.includes(cb.value);
    });
    document.getElementById('useCountryFilter').checked = config.useCountryFilter;
  }

  function renderSettings() {
    document.querySelector(`input[name="mode"][value="${config.mode}"]`).checked = true;
    document.getElementById('delayRange').value = config.delaySeconds;
    document.getElementById('delayValue').textContent = config.delaySeconds + 'с';
    document.getElementById('defaultComplaint').value = config.defaultComplaint;
    document.getElementById('dryRun').checked = config.dryRun;
    document.getElementById('notificationsEnabled').checked = config.notificationsEnabled;
    document.getElementById('scheduleEnabled').checked = config.scheduleEnabled;
    document.getElementById('scheduleInterval').value = config.scheduleInterval;
    document.getElementById('scheduleOptions').style.display = config.scheduleEnabled ? 'block' : 'none';
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
    const sorted = [...config.log].reverse();
    sorted.forEach((entry) => {
      const tr = document.createElement('tr');
      const statusClass = entry.success ? 'status-ok' : 'status-fail';
      const statusText = entry.success ? 'OK' : 'Ошибка';
      tr.innerHTML = `
        <td>${formatDate(entry.date)}</td>
        <td><strong>${esc(entry.seller || '')}</strong></td>
        <td>${esc(entry.inn || '')}</td>
        <td>${esc(entry.brand || '')}</td>
        <td>${esc(entry.country || '')}</td>
        <td class="${statusClass}">${statusText}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderTechLog() {
    const container = document.getElementById('techLogList');
    if (techLogLines.length === 0) {
      container.innerHTML = '<div class="tech-log-line" style="color:#666">Нет событий</div>';
      return;
    }
    container.innerHTML = '';
    techLogLines.slice(-200).forEach((line) => {
      const div = document.createElement('div');
      let cls = 'tech-log-line';
      if (line.includes('[DIAG]')) cls += ' tech-log-line--diag';
      else if (line.includes('✓') || line.includes('success')) cls += ' tech-log-line--success';
      else if (line.includes('❌') || line.includes('error') || line.includes('Ошибка')) cls += ' tech-log-line--error';
      else if (line.includes('⏳') || line.includes('Остановлено')) cls += ' tech-log-line--warning';
      div.className = cls;
      div.textContent = line;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  // ── Export functions ──
  function getLogData() {
    return (config.log || []).map((e) => ({
      date: formatDate(e.date),
      seller: e.seller || '',
      inn: e.inn || '',
      brand: e.brand || '',
      country: e.country || '',
      status: e.success ? 'OK' : 'Ошибка',
      error: e.error || ''
    }));
  }

  function exportCSV() {
    const rows = getLogData();
    const header = 'Дата;Продавец;ИНН;Бренд;Страна;Статус;Ошибка';
    const lines = rows.map((r) =>
      `${r.date};${r.seller};${r.inn};${r.brand};${r.country};${r.status};${r.error}`
    );
    const csv = '\uFEFF' + header + '\n' + lines.join('\n'); // BOM for Excel UTF-8
    downloadFile(csv, 'ozon-brand-guard-complaints.csv', 'text/csv;charset=utf-8');
  }

  function exportExcel() {
    const rows = getLogData();
    let html = '<html><head><meta charset="UTF-8"></head><body>';
    html += '<table border="1" style="border-collapse:collapse;font-family:Arial;font-size:12px">';
    html += '<tr style="background:#005bff;color:#fff;font-weight:bold">';
    html += '<th>Дата</th><th>Продавец</th><th>ИНН</th><th>Бренд</th><th>Страна</th><th>Статус</th><th>Ошибка</th>';
    html += '</tr>';
    rows.forEach((r) => {
      const bg = r.status === 'OK' ? '#e8f5e9' : '#ffebee';
      html += `<tr style="background:${bg}">`;
      html += `<td>${esc(r.date)}</td><td>${esc(r.seller)}</td><td>${esc(r.inn)}</td>`;
      html += `<td>${esc(r.brand)}</td><td>${esc(r.country)}</td>`;
      html += `<td style="color:${r.status === 'OK' ? 'green' : 'red'};font-weight:bold">${r.status}</td>`;
      html += `<td>${esc(r.error)}</td></tr>`;
    });
    html += '</table></body></html>';
    downloadFile(html, 'ozon-brand-guard-complaints.xls', 'application/vnd.ms-excel;charset=utf-8');
  }

  function exportTXT() {
    const rows = getLogData();
    const pad = (s, n) => (s + ' '.repeat(n)).substring(0, n);
    let txt = pad('Дата', 18) + pad('Продавец', 30) + pad('ИНН', 15) + pad('Бренд', 20) + pad('Страна', 8) + pad('Статус', 10) + 'Ошибка\n';
    txt += '-'.repeat(110) + '\n';
    rows.forEach((r) => {
      txt += pad(r.date, 18) + pad(r.seller, 30) + pad(r.inn, 15) + pad(r.brand, 20) + pad(r.country, 8) + pad(r.status, 10) + r.error + '\n';
    });
    downloadFile(txt, 'ozon-brand-guard-complaints.txt', 'text/plain;charset=utf-8');
  }

  function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
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

    // Sub-tabs (log section)
    document.querySelectorAll('.sub-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('sub-tab--active'));
        document.querySelectorAll('.sub-content').forEach((c) => c.classList.remove('sub-content--active'));
        tab.classList.add('sub-tab--active');
        document.getElementById('subtab-' + tab.dataset.subtab).classList.add('sub-content--active');
        if (tab.dataset.subtab === 'technical') renderTechLog();
      });
    });

    // Mode
    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener('change', async (e) => {
        config.mode = e.target.value;
        await saveConfig();
      });
    });

    // Delay
    document.getElementById('delayRange').addEventListener('input', (e) => {
      document.getElementById('delayValue').textContent = e.target.value + 'с';
    });
    document.getElementById('delayRange').addEventListener('change', async (e) => {
      config.delaySeconds = parseInt(e.target.value, 10);
      await saveConfig();
    });

    // Scan brands from page
    document.getElementById('btnScanBrands').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes('seller.ozon.ru/app/brand/sellers')) {
        alert('Откройте страницу "Продавцы бренда" на OZON Seller:\nhttps://seller.ozon.ru/app/brand/sellers');
        return;
      }
      document.getElementById('btnScanBrands').disabled = true;
      document.getElementById('btnScanBrands').textContent = 'Сканирую...';
      await ensureContentScript(tab.id);
      safeSendToTab(tab.id, { action: 'scanBrands' });
    });

    // Add brand
    document.getElementById('btnAddBrand').addEventListener('click', async () => {
      const id = 'brand_' + Date.now();
      config.brands.push({ id, name: '', complaint: '', fileData: null, fileName: '' });
      await saveConfig();
      renderBrands();
    });

    // Add whitelist
    document.getElementById('btnAddWhitelist').addEventListener('click', async () => {
      const input = document.getElementById('whitelistInput');
      const val = input.value.trim();
      if (!val) return;

      const type = /^\d+$/.test(val) ? 'inn' : 'name';
      config.whitelist.push({ value: val, type });
      input.value = '';
      await saveConfig();
      renderWhitelist();
    });

    document.getElementById('whitelistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btnAddWhitelist').click();
      }
    });

    // Country filters
    document.querySelectorAll('.country-filter').forEach((cb) => {
      cb.addEventListener('change', async () => {
        config.bannedCountries = Array.from(document.querySelectorAll('.country-filter:checked')).map((c) => c.value);
        await saveConfig();
      });
    });

    document.getElementById('useCountryFilter').addEventListener('change', async (e) => {
      config.useCountryFilter = e.target.checked;
      await saveConfig();
    });

    // Default complaint
    document.getElementById('defaultComplaint').addEventListener('change', async (e) => {
      config.defaultComplaint = e.target.value.trim();
      await saveConfig();
    });

    // Dry run
    document.getElementById('dryRun').addEventListener('change', async (e) => {
      config.dryRun = e.target.checked;
      await saveConfig();
    });

    // Notifications
    document.getElementById('notificationsEnabled').addEventListener('change', async (e) => {
      config.notificationsEnabled = e.target.checked;
      await saveConfig();
    });

    // Schedule
    document.getElementById('scheduleEnabled').addEventListener('change', async (e) => {
      config.scheduleEnabled = e.target.checked;
      document.getElementById('scheduleOptions').style.display = e.target.checked ? 'block' : 'none';
      await saveConfig();
      safeSendRuntime({ action: 'updateSchedule', config });
    });

    document.getElementById('scheduleInterval').addEventListener('change', async (e) => {
      config.scheduleInterval = parseInt(e.target.value, 10);
      await saveConfig();
      safeSendRuntime({ action: 'updateSchedule', config });
    });

    // Start
    document.getElementById('btnStart').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes('seller.ozon.ru/app/brand/sellers')) {
        alert('Откройте страницу "Продавцы бренда" на OZON Seller:\nhttps://seller.ozon.ru/app/brand/sellers');
        return;
      }
      techLogLines = []; // Clear tech log on new session
      await ensureContentScript(tab.id);
      safeSendToTab(tab.id, { action: 'start', config });
      setRunningState(true);
    });

    // Stop
    document.getElementById('btnStop').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        safeSendToTab(tab.id, { action: 'stop' });
      }
      setRunningState(false);
    });

    // Export settings
    document.getElementById('btnExport').addEventListener('click', () => {
      const data = JSON.stringify(config, null, 2);
      downloadFile(data, 'ozon-brand-guard-settings.json', 'application/json');
    });

    // Import settings
    document.getElementById('btnImport').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });

    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const imported = JSON.parse(text);
        config = { ...DEFAULT_CONFIG, ...imported };
        await saveConfig();
        renderAll();
        alert('Настройки импортированы');
      } catch {
        alert('Ошибка чтения файла');
      }
    });

    // Export complaint log
    document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
    document.getElementById('btnExportExcel').addEventListener('click', exportExcel);
    document.getElementById('btnExportTXT').addEventListener('click', exportTXT);

    // Clear log
    document.getElementById('btnClearLog').addEventListener('click', async () => {
      if (!confirm('Очистить историю жалоб?')) return;
      config.log = [];
      await saveConfig();
      renderLog();
    });

    // Reset all
    document.getElementById('btnResetAll').addEventListener('click', async () => {
      if (!confirm('Сбросить ВСЕ настройки к значениям по умолчанию?')) return;
      config = { ...DEFAULT_CONFIG };
      await saveConfig();
      renderAll();
    });
  }

  // ── State ──
  function setRunningState(running) {
    document.getElementById('btnStart').style.display = running ? 'none' : 'flex';
    document.getElementById('btnStop').style.display = running ? 'flex' : 'none';

    const indicator = document.getElementById('statusIndicator');
    const dot = indicator.querySelector('.status-dot');
    const text = indicator.querySelector('.status-text');

    dot.className = 'status-dot ' + (running ? 'status-dot--running' : 'status-dot--idle');
    text.textContent = running ? 'Работает...' : 'Готов';
  }

  function updateStatusFromBackground() {
    safeSendRuntime({ action: 'getStatus' }, (response) => {
      if (response && response.running) {
        setRunningState(true);
      }
    });
  }

  // ── Scanned brands rendering ──
  function renderScannedBrands(pageInfo) {
    const container = document.getElementById('scannedBrandsList');
    container.innerHTML = '';

    const brandList = Object.entries(accumulatedBrands)
      .map(([name, count]) => ({ name, sellersCount: count }))
      .sort((a, b) => b.sellersCount - a.sellersCount);

    if (pageInfo) {
      const infoDiv = document.createElement('div');
      infoDiv.className = 'scan-page-info';
      infoDiv.innerHTML = `${pageInfo.from}-${pageInfo.to} из ${pageInfo.total}
        ${pageInfo.to < pageInfo.total ? ' — перелистните и нажмите «Найти» снова' : ' — все просканированы'}`;
      container.appendChild(infoDiv);
    }

    if (brandList.length === 0) {
      container.innerHTML += '<p class="hint">Бренды не найдены</p>';
      return;
    }

    brandList.forEach((brand) => {
      const div = document.createElement('label');
      div.className = 'scanned-brand';
      const isAlreadyAdded = config.brands.some(
        (b) => b.name.toLowerCase() === brand.name.toLowerCase()
      );
      div.innerHTML = `
        <input type="checkbox" class="scanned-brand-cb" data-brand="${brand.name}" ${isAlreadyAdded ? 'checked disabled' : ''}>
        <span class="scanned-brand__name">${brand.name}</span>
        <span class="scanned-brand__sellers">${brand.sellersCount} продавцов</span>
      `;
      if (isAlreadyAdded) {
        div.classList.add('scanned-brand--mine');
        div.title = 'Уже добавлен';
      }
      container.appendChild(div);
    });

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'scanned-actions';
    actionsDiv.innerHTML = `
      <button class="btn btn--primary" id="btnApplyScannedBrands" style="flex:1">Отметить как свои</button>
      <button class="btn btn--secondary" id="btnClearScanned">Сброс</button>
    `;
    container.appendChild(actionsDiv);

    document.getElementById('btnApplyScannedBrands').addEventListener('click', async () => {
      const checked = container.querySelectorAll('.scanned-brand-cb:checked:not(:disabled)');
      let added = 0;

      for (const cb of checked) {
        const brandName = cb.dataset.brand;
        const exists = config.brands.some(
          (b) => b.name.toLowerCase() === brandName.toLowerCase()
        );
        if (!exists) {
          const id = 'brand_' + Date.now() + '_' + added;
          config.brands.push({ id, name: brandName, complaint: '', fileData: null, fileName: '' });

          const inWhitelist = config.whitelist.some(
            (w) => w.value.toLowerCase() === brandName.toLowerCase()
          );
          if (!inWhitelist) {
            config.whitelist.push({ value: brandName, type: 'name' });
          }
          added++;
        }
      }

      if (added > 0) {
        await saveConfig();
        renderBrands();
        renderWhitelist();
        renderScannedBrands(pageInfo);
      }
    });

    document.getElementById('btnClearScanned').addEventListener('click', () => {
      accumulatedBrands = {};
      container.innerHTML = '';
    });
  }

  // ── Message listener ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'updateStats') {
      document.getElementById('statsCard').style.display = 'block';
      document.getElementById('statTotal').textContent = msg.stats.total || 0;
      document.getElementById('statViolators').textContent = msg.stats.violators || 0;
      document.getElementById('statWhitelisted').textContent = msg.stats.whitelisted || 0;
      document.getElementById('statComplained').textContent = msg.stats.complained || 0;
    }

    if (msg.action === 'done') {
      setRunningState(false);
      loadConfig().then((c) => {
        config = c;
        renderLog();
      });
    }

    if (msg.action === 'logUpdate') {
      loadConfig().then((c) => {
        config = c;
        renderLog();
      });
    }

    // Technical log line from content script
    if (msg.action === 'techLog') {
      techLogLines.push(msg.text);
      if (techLogLines.length > 500) techLogLines = techLogLines.slice(-500);
    }

    if (msg.action === 'scanBrandsResult') {
      const btn = document.getElementById('btnScanBrands');
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04-1.06 1.06-3.04-3.04z"/></svg>
        Найти бренды на странице
      `;

      if (msg.brands && msg.brands.length > 0) {
        msg.brands.forEach((b) => {
          accumulatedBrands[b.name] = (accumulatedBrands[b.name] || 0) + b.sellersCount;
        });
      }
      renderScannedBrands(msg.pageInfo || null);
    }
  });

  init();
})();
