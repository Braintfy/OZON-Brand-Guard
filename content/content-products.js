// OZON Brand Guard — Content Script for Brand Products Page
// Автор: firayzer (https://t.me/firayzer)
// Работает на: https://seller.ozon.ru/app/brand-products/*

(function () {
  'use strict';

  if (window.__obgProductsLoaded) return;
  window.__obgProductsLoaded = true;

  // ── State ──
  let config = null;
  let isRunning = false;
  let shouldStop = false;
  let stats = { total: 0, violators: 0, whitelisted: 0, complained: 0, skipped: 0 };
  let panelEl = null;
  let logLines = [];

  // ── Safe message sender ──
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  // ── Simulate real click (React 17+ PointerEvents) ──
  function simulateRealClick(element) {
    if (!element) return;
    if (element.scrollIntoViewIfNeeded) {
      element.scrollIntoViewIfNeeded(true);
    } else {
      element.scrollIntoView({ block: 'center' });
    }

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const evtOpts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1
    };

    try { element.focus(); } catch (e) { /* ignore */ }

    element.dispatchEvent(new PointerEvent('pointerover', evtOpts));
    element.dispatchEvent(new PointerEvent('pointerenter', { ...evtOpts, bubbles: false }));
    element.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
    element.dispatchEvent(new PointerEvent('pointerup', evtOpts));
    element.dispatchEvent(new MouseEvent('mouseover', evtOpts));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...evtOpts, bubbles: false }));
    element.dispatchEvent(new MouseEvent('mousedown', evtOpts));
    element.dispatchEvent(new MouseEvent('mouseup', evtOpts));
    element.dispatchEvent(new MouseEvent('click', evtOpts));
    try { element.click(); } catch (e) { /* ignore */ }
  }

  // ── Message handling ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'startProducts':
        config = msg.config;
        startProcess();
        break;
      case 'stopProducts':
        stopProcess();
        break;
    }
  });

  // ── Main process ──
  async function startProcess() {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;
    stats = { total: 0, violators: 0, whitelisted: 0, complained: 0, skipped: 0 };
    logLines = [];

    safeSend({ action: 'setRunning', running: true });
    showPanel();
    log('Запуск сканирования товаров...');

    try {
      await processAllPages();
      log(`Готово! Жалоб отправлено: ${stats.complained}`, 'success');

      if (config.notificationsEnabled) {
        safeSend({
          action: 'showNotification',
          title: 'Brand Guard — Товары',
          message: `Нарушителей: ${stats.violators}, Жалоб: ${stats.complained}`
        });
      }
    } catch (err) {
      log('Ошибка: ' + err.message, 'error');
    } finally {
      isRunning = false;
      safeSend({ action: 'setRunning', running: false });
      safeSend({ action: 'doneProducts' });
      sendStats();
    }
  }

  function stopProcess() {
    shouldStop = true;
    isRunning = false;
    log('Остановлено пользователем', 'warning');
    safeSend({ action: 'setRunning', running: false });
    safeSend({ action: 'doneProducts' });
    try {
      closeModal();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (e) { /* ignore */ }
  }

  // ── Page processing ──
  async function processAllPages() {
    let pageNum = 1;

    while (!shouldStop) {
      log(`Обработка страницы ${pageNum}...`);
      await waitForTable();

      const products = parseProductsTable();
      stats.total += products.length;
      log(`Найдено товаров на странице: ${products.length}`);

      for (const product of products) {
        if (shouldStop) break;

        const isWhitelisted = checkWhitelist(product.seller);

        if (isWhitelisted) {
          stats.whitelisted++;
          highlightRow(product.rowElement, 'safe');
          log(`✓ ${product.name.substring(0, 40)} — продавец ${product.seller} в whitelist`, 'safe');
          continue;
        }

        // Violator — not in whitelist
        stats.violators++;
        highlightRow(product.rowElement, 'violator');
        log(`✗ ${product.name.substring(0, 40)} — продавец: ${product.seller}`, 'danger');

        if (config.mode === 'complain' && !config.dryRun) {
          await fileProductComplaint(product);
        }

        sendStats();
      }

      if (shouldStop) break;
      const hasNext = await goToNextPage();
      if (!hasNext) {
        log('Все страницы обработаны');
        break;
      }

      pageNum++;
      if (shouldStop) break;
      await sleep(2000);
    }
  }

  // ── Table parsing ──
  // Brand-products table structure:
  // td[0] = Product name + SKU + image
  // td[1] = Date created
  // td[2] = Brand
  // td[3] = Seller
  // td[4] = Customer price
  // td[5] = Seller price
  // td[6] = Menu button (⋮)
  function parseProductsTable() {
    const products = [];

    let rows = Array.from(document.querySelectorAll('table tbody tr'));
    if (rows.length === 0) {
      rows = Array.from(document.querySelectorAll('table tr'));
    }
    rows = rows.filter((row) => row.querySelectorAll('td').length >= 5);

    rows.forEach((row) => {
      const product = extractProductFromRow(row);
      if (product) {
        products.push(product);
      }
    });

    return products;
  }

  function extractProductFromRow(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 6) return null;

    // Product name: inside first td, look for title attribute or link text
    const nameEl = cells[0].querySelector('[title]') || cells[0].querySelector('a');
    const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : cells[0].textContent.trim();

    // SKU: look for "SKU XXXXXXX" text
    const skuEl = cells[0].querySelector('[class*="label"]');
    const skuText = skuEl ? skuEl.textContent.trim() : '';
    const skuMatch = skuText.match(/SKU\s*(\d+)/i);
    const sku = skuMatch ? skuMatch[1] : '';

    // Product link
    const linkEl = cells[0].querySelector('a[href*="ozon.ru"]');
    const link = linkEl ? linkEl.href : '';

    // Brand: td[2]
    const brandEl = cells[2].querySelector('[title]');
    const brand = brandEl ? brandEl.getAttribute('title') : cells[2].textContent.trim();

    // Seller: td[3]
    const sellerEl = cells[3].querySelector('[title]');
    const seller = sellerEl ? sellerEl.getAttribute('title') : cells[3].textContent.trim();

    // Date: td[1]
    const dateEl = cells[1].querySelector('[title]');
    const date = dateEl ? dateEl.getAttribute('title') : cells[1].textContent.trim();

    // Customer price: td[4]
    const priceText = cells[4].textContent.trim().replace(/\s/g, '');

    // Menu button: last td
    const lastTd = cells[cells.length - 1];
    const menuButton = lastTd.querySelector('button') || findMenuButton(row);

    return {
      name,
      sku,
      link,
      brand,
      seller,
      date,
      price: priceText,
      rowElement: row,
      menuButton
    };
  }

  function findMenuButton(row) {
    const allButtons = row.querySelectorAll('button');
    for (const btn of allButtons) {
      const svg = btn.querySelector('svg');
      const text = btn.textContent.trim();
      if (svg && !text) return btn;
    }
    if (allButtons.length > 0) return allButtons[allButtons.length - 1];
    return null;
  }

  // ── Whitelist check ──
  function checkWhitelist(sellerName) {
    if (!sellerName || !config.whitelist) return false;
    for (const entry of config.whitelist) {
      if (entry.type === 'name' && sellerName.toLowerCase().includes(entry.value.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  // ── Complaint automation ──
  const MIN_COOLDOWN_MS = 10000;

  async function fileProductComplaint(product) {
    if (shouldStop) return;
    log(`Подаём жалобу на товар: ${product.name.substring(0, 40)}...`);

    const startTime = Date.now();

    try {
      if (!product.menuButton) {
        log(`  Кнопка меню не найдена`, 'error');
        stats.skipped++;
        return;
      }

      product.rowElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(1000);
      if (shouldStop) return;

      simulateRealClick(product.menuButton);
      log(`  Клик на меню (⋮)...`);
      await sleep(2000);
      if (shouldStop) return;

      // Find and click "Пожаловаться"
      const complainButton = await findComplainButtonWithRetry();
      if (shouldStop) return;
      if (!complainButton) {
        log(`  Кнопка "Пожаловаться" не найдена`, 'error');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(500);
        stats.skipped++;
        return;
      }

      simulateRealClick(complainButton);
      log(`  Открываем форму жалобы...`);
      await sleep(4000);
      if (shouldStop) return;

      // Fill complaint text
      const complaintText = getProductComplaintText(product.brand);
      const textarea = await findTextareaInModal();
      if (shouldStop) return;

      if (!textarea) {
        log(`  Поле текста жалобы не найдено`, 'error');
        closeModal();
        stats.skipped++;
        return;
      }

      setInputValueSmart(textarea, complaintText);
      log(`  Текст жалобы заполнен`);
      await sleep(2000);
      if (shouldStop) return;

      // Attach file
      const brand = config.brands.find(
        (b) => b.name.toLowerCase() === product.brand.toLowerCase()
      );

      // Use product-specific file first, fallback to brand file
      const fileData = config.productFileData || (brand && brand.fileData);
      const fileName = config.productFileName || (brand && brand.fileName);

      if (fileData) {
        await attachFile(fileData, fileName);
        log(`  ⏳ Ожидание загрузки файла (8с)...`);
        await sleep(8000);
        if (shouldStop) return;
      }

      // Click submit
      const submitButton = findSubmitButton();
      if (!submitButton) {
        log(`  Кнопка "Отправить" не найдена`, 'error');
        closeModal();
        stats.skipped++;
        return;
      }

      simulateRealClick(submitButton);
      log(`  Отправляем жалобу...`);
      await sleep(3000);

      stats.complained++;
      log(`  ✓ Жалоба отправлена на товар ${product.name.substring(0, 30)}`, 'success');

      safeSend({
        action: 'logComplaint',
        entry: {
          date: new Date().toISOString(),
          seller: product.seller,
          inn: product.sku,
          brand: product.brand,
          country: 'товар',
          success: true
        }
      });

    } catch (err) {
      log(`  Ошибка: ${err.message}`, 'error');

      safeSend({
        action: 'logComplaint',
        entry: {
          date: new Date().toISOString(),
          seller: product.seller,
          inn: product.sku,
          brand: product.brand,
          country: 'товар',
          success: false,
          error: err.message
        }
      });

      closeModal();
    }

    await waitCooldown(startTime);
  }

  async function waitCooldown(startTime) {
    if (shouldStop) return;
    const elapsed = Date.now() - startTime;
    const delay = Math.max(config.delaySeconds * 1000, MIN_COOLDOWN_MS);
    const jitter = Math.floor(Math.random() * 5000);
    const remaining = delay + jitter - elapsed;
    if (remaining > 0) {
      log(`  ⏳ Ожидание ${Math.round(remaining / 1000)}с...`, 'warning');
      await sleep(remaining);
    }
  }

  function getProductComplaintText(brandName) {
    // Use product-specific complaint text first
    if (config.productComplaintText) {
      return config.productComplaintText.replace(/https?:\/\/[^\s]+/gi, '').replace(/\s{2,}/g, ' ').trim();
    }
    // Fallback to brand complaint text
    const brand = config.brands.find(
      (b) => b.name.toLowerCase() === brandName.toLowerCase()
    );
    let text = '';
    if (brand && brand.complaint) {
      text = brand.complaint;
    } else {
      text = config.defaultComplaint || 'Копия товара моего бренда';
    }
    return text.replace(/https?:\/\/[^\s]+/gi, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ── Find "Пожаловаться" button ──
  async function findComplainButtonWithRetry() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (shouldStop) return null;
      log(`  Поиск кнопки "Пожаловаться" (попытка ${attempt}/5)...`);

      const btn = findComplainButtonInDOM();
      if (btn) {
        log(`  Кнопка найдена!`, 'success');
        return btn;
      }

      if (attempt < 5) await sleep(1500);
    }
    return null;
  }

  function findComplainButtonInDOM() {
    const ourPanel = document.getElementById('obg-float-panel');

    const allClickable = document.querySelectorAll(
      'button, [role="menuitem"], [role="option"], a, li, span, div'
    );

    let bestMatch = null;
    let bestSpecificity = 0;

    for (const el of allClickable) {
      if (ourPanel && ourPanel.contains(el)) continue;
      if (el.closest('#obg-float-panel')) continue;

      const ownText = getOwnText(el).toLowerCase();
      const fullText = el.textContent.trim().toLowerCase();

      let specificity = 0;
      // On products page, the button text is just "Пожаловаться"
      if (ownText === 'пожаловаться') {
        specificity = 10;
      } else if (ownText.includes('пожаловаться')) {
        specificity = 8;
      } else if (fullText === 'пожаловаться' && fullText.length < 30) {
        specificity = 6;
      } else if (fullText.includes('пожаловаться') && fullText.length < 40) {
        specificity = 4;
      } else {
        continue;
      }

      if (el.children.length === 0) specificity += 2;
      if (el.getAttribute('role') === 'menuitem') specificity += 1;

      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        bestMatch = el;
      }
    }

    if (bestMatch) {
      const menuItem = bestMatch.closest('[role="menuitem"]');
      if (menuItem && !menuItem.closest('#obg-float-panel')) return menuItem;
      // Walk up to find clickable container
      const clickable = bestMatch.closest('[class*="cs2110-a4"]') || bestMatch.closest('div[class*="cs0110"]');
      if (clickable && !clickable.closest('#obg-float-panel')) return clickable;
      return bestMatch;
    }
    return null;
  }

  function getOwnText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }

  // ── Find textarea ──
  async function findTextareaInModal() {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (shouldStop) return null;
      log(`  Поиск поля ввода (попытка ${attempt}/8)...`);

      const formTextarea = document.querySelector('form textarea') || document.querySelector('textarea');
      if (formTextarea) {
        log(`  ✓ Поле найдено`, 'success');
        return formTextarea;
      }

      const byId = document.querySelector('textarea[id^="baseInput"]');
      if (byId) {
        log(`  ✓ Поле найдено по ID`, 'success');
        return byId;
      }

      if (attempt < 8 && !shouldStop) await sleep(2000);
    }
    log(`  ❌ Textarea не найден`, 'error');
    return null;
  }

  // ── Submit button ──
  function findSubmitButton() {
    const allBtns = document.querySelectorAll('form button[type="submit"]');
    for (const btn of allBtns) {
      if (btn.textContent.trim().includes('Отправить')) return btn;
    }
    const allBtns2 = document.querySelectorAll('button');
    for (const btn of allBtns2) {
      if (btn.textContent.trim().toLowerCase() === 'отправить') return btn;
    }
    return null;
  }

  // ── File attachment ──
  async function attachFile(fileData, fileName) {
    if (!fileData) return;
    try {
      let fileInput = document.querySelector('form input[type="file"]') || document.querySelector('input[type="file"]');
      if (!fileInput) {
        await sleep(2000);
        fileInput = document.querySelector('input[type="file"]');
      }
      if (!fileInput) {
        log('  Поле загрузки файла не найдено', 'warning');
        return;
      }

      const response = await fetch(fileData);
      const blob = await response.blob();
      const file = new File([blob], fileName || 'trademark.pdf', { type: blob.type });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

      log(`  Файл прикреплён: ${fileName || 'trademark.pdf'}`);
    } catch (err) {
      log(`  Ошибка загрузки файла: ${err.message}`, 'warning');
    }
  }

  // ── Input helpers (React-compatible) ──
  function setInputValueSmart(element, value) {
    const isContentEditable = element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === '';
    if (isContentEditable) {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function closeModal() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Also try clicking close button (X)
    const closeButtons = document.querySelectorAll('button[type="button"]');
    for (const btn of closeButtons) {
      if (btn.querySelector('svg') && !btn.textContent.trim() && btn.closest('[class*="md5-h5r"], [class*="modal"], [class*="Modal"], [role="dialog"]')) {
        btn.click();
        return;
      }
    }
  }

  // ── Pagination ──
  async function goToNextPage() {
    const paginationButtons = document.querySelectorAll('ul li button');
    const pageBtns = Array.from(paginationButtons).filter((btn) => /^\d+$/.test(btn.textContent.trim()));

    if (pageBtns.length > 0) {
      let currentIndex = -1;
      for (let i = 0; i < pageBtns.length; i++) {
        if (pageBtns[i].getAttribute('data-selected') === 'true' || pageBtns[i].disabled) {
          currentIndex = i;
          break;
        }
      }
      // Also detect current by special class (md5-s3 in the provided HTML)
      if (currentIndex === -1) {
        for (let i = 0; i < pageBtns.length; i++) {
          if (pageBtns[i].className.includes('s3') || pageBtns[i].parentElement?.className.includes('s3')) {
            currentIndex = i;
            break;
          }
        }
      }

      if (currentIndex >= 0 && currentIndex < pageBtns.length - 1) {
        const nextBtn = pageBtns[currentIndex + 1];
        log(`  Переход на страницу ${nextBtn.textContent.trim()}...`);
        nextBtn.click();
        await sleep(3000);
        return true;
      }
    }

    // Fallback: look for next arrow button
    const allSvgBtns = document.querySelectorAll('.md5-s1');
    const lastSvgBtn = allSvgBtns[allSvgBtns.length - 1];
    if (lastSvgBtn && lastSvgBtn.querySelector && lastSvgBtn.querySelector('svg')) {
      lastSvgBtn.click();
      await sleep(3000);
      // Verify page actually changed
      return true;
    }

    return false;
  }

  // ── DOM helpers ──
  async function waitForTable(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const table = document.querySelector('table');
      if (table && table.querySelectorAll('tbody tr').length > 0) return table;
      await sleep(500);
    }
    throw new Error('Таблица товаров не найдена');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function highlightRow(row, type) {
    if (!row) return;
    row.classList.remove('obg-violator-row', 'obg-whitelisted-row');
    if (type === 'violator') row.classList.add('obg-violator-row');
    else if (type === 'safe') row.classList.add('obg-whitelisted-row');
  }

  // ── Floating panel ──
  let panelMinimized = false;

  function showPanel() {
    removePanel();
    panelEl = document.createElement('div');
    panelEl.id = 'obg-float-panel';
    panelEl.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; width: 380px;
      background: #fff; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18); z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden; resize: both; min-width: 300px; min-height: 60px;
    `;

    panelEl.innerHTML = `
      <div id="obg-panel-header" style="
        padding: 10px 12px; background: #e65100; color: #fff;
        display: flex; align-items: center; gap: 8px; cursor: grab; user-select: none;
      ">
        <span style="font-weight: 600; font-size: 13px; flex:1;">Brand Guard — Товары</span>
        <span id="obg-panel-status" style="font-size: 11px; background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 8px;">Работает...</span>
        <button id="obg-btn-stop" title="Остановить" style="
          background: #ff3b30; border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center;
        ">■</button>
        <button id="obg-btn-minimize" title="Свернуть" style="
          background: rgba(255,255,255,0.25); border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center;
        ">−</button>
        <button id="obg-btn-close" title="Закрыть" style="
          background: rgba(255,255,255,0.25); border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center;
        ">×</button>
      </div>
      <div id="obg-panel-body">
        <div id="obg-panel-stats" style="
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
          padding: 8px; background: #fff3e0; font-size: 11px; text-align: center;
        ">
          <div><strong id="obg-s-total">0</strong><br>Всего</div>
          <div><strong id="obg-s-viol" style="color:#ff3b30">0</strong><br>Наруш.</div>
          <div><strong id="obg-s-safe" style="color:#00cc44">0</strong><br>OK</div>
          <div><strong id="obg-s-sent" style="color:#e65100">0</strong><br>Жалоб</div>
        </div>
        <div id="obg-panel-log" style="
          max-height: 240px; overflow-y: auto; padding: 8px;
          font-size: 11px; font-family: 'SF Mono', Monaco, monospace;
          line-height: 1.6; color: #333;
        "></div>
        <div style="padding: 4px 8px; background: #f8f8f8; font-size: 10px; color: #999; text-align: right; border-top: 1px solid #eee;">
          by <a href="https://t.me/firayzer" target="_blank" style="color:#e65100;text-decoration:none;">firayzer</a>
        </div>
      </div>
    `;

    document.body.appendChild(panelEl);
    panelMinimized = false;

    makeDraggable(panelEl, panelEl.querySelector('#obg-panel-header'));

    panelEl.querySelector('#obg-btn-stop').addEventListener('click', () => stopProcess());
    panelEl.querySelector('#obg-btn-minimize').addEventListener('click', () => {
      const body = panelEl.querySelector('#obg-panel-body');
      const btn = panelEl.querySelector('#obg-btn-minimize');
      panelMinimized = !panelMinimized;
      body.style.display = panelMinimized ? 'none' : 'block';
      btn.textContent = panelMinimized ? '+' : '−';
    });
    panelEl.querySelector('#obg-btn-close').addEventListener('click', () => removePanel());
  }

  function makeDraggable(el, handle) {
    let isDragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      handle.style.cursor = 'grab';
    });
  }

  function removePanel() {
    const existing = document.getElementById('obg-float-panel');
    if (existing) existing.remove();
    panelEl = null;
  }

  function updatePanel() {
    if (!panelEl) return;
    const el = (id) => panelEl.querySelector('#' + id);
    if (el('obg-s-total')) el('obg-s-total').textContent = stats.total;
    if (el('obg-s-viol')) el('obg-s-viol').textContent = stats.violators;
    if (el('obg-s-safe')) el('obg-s-safe').textContent = stats.whitelisted;
    if (el('obg-s-sent')) el('obg-s-sent').textContent = stats.complained;

    const logContainer = el('obg-panel-log');
    if (logContainer) {
      logContainer.innerHTML = logLines.slice(-30)
        .map((l) => `<div style="padding:2px 0;border-bottom:1px solid #f0f0f0;${l.style || ''}">${l.time} ${l.text}</div>`)
        .join('');
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    const statusEl = el('obg-panel-status');
    if (statusEl) statusEl.textContent = isRunning ? 'Работает...' : 'Завершено';
  }

  // ── Logging ──
  function log(text, type) {
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let style = '';
    switch (type) {
      case 'success': style = 'color:#00802b;'; break;
      case 'error': case 'danger': style = 'color:#cc0000;'; break;
      case 'warning': style = 'color:#b36b00;'; break;
      case 'safe': style = 'color:#00cc44;'; break;
      default: style = ''; break;
    }
    logLines.push({ time, text, style });
    console.log(`[OBG-P] ${time} ${text}`);
    safeSend({ action: 'techLog', text: `[Товар] ${time} ${text}` });
    updatePanel();
    sendStats();
  }

  function sendStats() {
    safeSend({ action: 'updateProductStats', stats });
  }
})();
