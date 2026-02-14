// OZON Brand Guard — Content Script
// Автор: firayzer (https://t.me/firayzer)
// Работает на: https://seller.ozon.ru/app/brand/sellers*

(function () {
  'use strict';

  // Guard: prevent duplicate injection
  if (window.__obgContentLoaded) return;
  window.__obgContentLoaded = true;

  // ── State ──
  let config = null;
  let isRunning = false;
  let shouldStop = false;
  let stats = { total: 0, violators: 0, whitelisted: 0, complained: 0, skipped: 0 };
  let panelEl = null;
  let logLines = [];

  // Safe message sender — won't throw if popup/background is not listening
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  // ── Simulate real click — full event cycle for React 17+ compatibility ──
  // React 17+ uses PointerEvents for event delegation, not just MouseEvents
  function simulateRealClick(element) {
    if (!element) return;

    // Ensure element is visible and scrolled into view
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

    // Focus the element first
    try { element.focus(); } catch (e) { /* ignore */ }

    // Pointer events (React 17+ uses these)
    element.dispatchEvent(new PointerEvent('pointerover', evtOpts));
    element.dispatchEvent(new PointerEvent('pointerenter', { ...evtOpts, bubbles: false }));
    element.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
    element.dispatchEvent(new PointerEvent('pointerup', evtOpts));

    // Mouse events (older React and non-React handlers)
    element.dispatchEvent(new MouseEvent('mouseover', evtOpts));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...evtOpts, bubbles: false }));
    element.dispatchEvent(new MouseEvent('mousedown', evtOpts));
    element.dispatchEvent(new MouseEvent('mouseup', evtOpts));
    element.dispatchEvent(new MouseEvent('click', evtOpts));

    // Also try native click as ultimate fallback
    try { element.click(); } catch (e) { /* ignore */ }
  }

  // ── Deep querySelector — traverses shadow DOM and same-origin iframes ──
  function deepQuerySelector(selector, root) {
    root = root || document;
    // Try normal query first
    const result = root.querySelector(selector);
    if (result) return result;

    // Search inside shadow roots
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        const found = deepQuerySelector(selector, el.shadowRoot);
        if (found) return found;
      }
    }

    // Search inside same-origin iframes
    const iframes = root.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          const found = deepQuerySelector(selector, iframe.contentDocument);
          if (found) return found;
        }
      } catch (e) { /* cross-origin, skip */ }
    }

    return null;
  }

  function deepQuerySelectorAll(selector, root) {
    root = root || document;
    let results = Array.from(root.querySelectorAll(selector));

    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        results = results.concat(deepQuerySelectorAll(selector, el.shadowRoot));
      }
    }

    const iframes = root.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          results = results.concat(deepQuerySelectorAll(selector, iframe.contentDocument));
        }
      } catch (e) { /* cross-origin */ }
    }

    return results;
  }

  // ── Message handling ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'start':
        config = msg.config;
        startProcess();
        break;
      case 'stop':
        stopProcess();
        break;
      case 'scanBrands':
        scanBrandsOnPage();
        break;
    }
  });

  // ── Brand scanning (auto-discovery) ──
  async function scanBrandsOnPage() {
    console.log('[OBG] === Brand scan started ===');
    const brandMap = {};

    try {
      // Wait for any content to load
      await sleep(1000);

      // Dump page structure for debugging
      console.log('[OBG] Page URL:', location.href);
      console.log('[OBG] Tables found:', document.querySelectorAll('table').length);
      console.log('[OBG] TRs found:', document.querySelectorAll('tr').length);
      console.log('[OBG] TDs found:', document.querySelectorAll('td').length);
      console.log('[OBG] [role=row]:', document.querySelectorAll('[role="row"]').length);
      console.log('[OBG] [role=cell]:', document.querySelectorAll('[role="cell"]').length);

      // ── Strategy 1: Find "Бренд" header and get column index ──
      console.log('[OBG] Strategy 1: Looking for "Бренд" header...');
      const brandColIndex = findColumnByHeader(['Бренд', 'Brand', 'бренд']);
      console.log('[OBG] Brand column index:', brandColIndex);

      if (brandColIndex >= 0) {
        const rows = getDataRows();
        console.log('[OBG] Data rows found:', rows.length);
        rows.forEach((row) => {
          const cells = getRowCells(row);
          if (cells.length > brandColIndex) {
            const brandText = cells[brandColIndex].textContent.trim();
            if (isValidBrand(brandText)) {
              brandMap[brandText] = (brandMap[brandText] || 0) + 1;
            }
          }
        });
      }

      // ── Strategy 2: Scan every element for country codes, extract sibling brand ──
      if (Object.keys(brandMap).length === 0) {
        console.log('[OBG] Strategy 2: Scanning for country codes in all elements...');
        const walker = document.createTreeWalker(
          document.body, NodeFilter.SHOW_TEXT, null, false
        );
        const countryNodes = [];
        let node;
        while ((node = walker.nextNode())) {
          if (/^(CN|RU|TR|KR|IN|US|DE|GB)$/.test(node.textContent.trim())) {
            countryNodes.push(node.parentElement);
          }
        }
        console.log('[OBG] Country code elements found:', countryNodes.length);

        countryNodes.forEach((el) => {
          // Walk up to find the row-level container
          let rowEl = el;
          for (let i = 0; i < 5; i++) {
            if (!rowEl.parentElement) break;
            rowEl = rowEl.parentElement;
            if (rowEl.tagName === 'TR' || rowEl.getAttribute('role') === 'row') break;
            const children = rowEl.children;
            if (children.length >= 4) break;
          }

          // Extract all direct text-bearing children
          const textParts = extractTextParts(rowEl);
          console.log('[OBG] Row text parts:', textParts);

          // Brand is typically a short lowercase/mixed-case name
          // It appears after the seller name and before numbers/country
          textParts.forEach((part) => {
            if (isValidBrand(part) && !isSellerMeta(part)) {
              brandMap[part] = (brandMap[part] || 0) + 1;
            }
          });
        });
      }

      // ── Strategy 3: Look for repeated short strings that appear multiple times ──
      if (Object.keys(brandMap).length === 0) {
        console.log('[OBG] Strategy 3: Scanning all visible text for repeated strings...');
        const allText = document.body.innerText;
        const words = new Set();

        // Find all unique "word" sequences that could be brand names
        const matches = allText.match(/[A-Za-zА-Яа-яёЁ][A-Za-zА-Яа-яёЁ0-9\s-]{1,40}/g) || [];
        matches.forEach((m) => {
          const t = m.trim();
          if (t.length >= 2 && t.length <= 40) words.add(t);
        });

        // Count occurrences
        const wordCounts = {};
        words.forEach((w) => {
          const regex = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          const count = (allText.match(regex) || []).length;
          if (count >= 2 && isValidBrand(w)) {
            wordCounts[w] = count;
          }
        });

        // Filter: keep only words that appear in the table area
        const pageContent = document.querySelector('table, [class*="table"], [class*="Table"], main, [role="main"]');
        if (pageContent) {
          const tableText = pageContent.innerText;
          Object.entries(wordCounts).forEach(([word, count]) => {
            if (tableText.includes(word) && count >= 2) {
              brandMap[word] = count;
            }
          });
        }
      }

      // ── Strategy 4: Direct DOM scan — find any element containing known "brand header" nearby ──
      if (Object.keys(brandMap).length === 0) {
        console.log('[OBG] Strategy 4: Deep DOM scan...');
        // Find all elements on page and look for the pattern
        const allElements = document.querySelectorAll('*');
        allElements.forEach((el) => {
          // Only leaf elements with short text
          if (el.children.length === 0) {
            const text = el.textContent.trim();
            if (isValidBrand(text) && el.offsetParent !== null) {
              // Check if this element is in a grid/table-like layout
              const parent = el.parentElement;
              const siblings = parent ? parent.children.length : 0;
              if (siblings >= 3) {
                brandMap[text] = (brandMap[text] || 0) + 1;
              }
            }
          }
        });

        // Filter brands that appear only once (noise)
        Object.keys(brandMap).forEach((key) => {
          if (brandMap[key] < 2) delete brandMap[key];
        });
      }

    } catch (err) {
      console.error('[OBG] Brand scan error:', err);
    }

    // Clean up and deduplicate
    // Remove entries that are clearly not brands (numbers, dates, common UI text)
    const noisyWords = ['все', 'новые', 'фильтры', 'строк', 'страница', 'одобрены',
      'не подключено', 'выключено', 'подключено', 'включено', 'ozon', 'продавцы бренда',
      'название', 'продавца', 'товары', 'продаже', 'страна', 'документы', 'продвижение',
      'отображение', 'витрине', 'бренда', 'бренд', 'метки', 'юрлицо'];

    Object.keys(brandMap).forEach((key) => {
      const lower = key.toLowerCase();
      if (noisyWords.some((w) => lower === w || lower.includes(w))) {
        delete brandMap[key];
      }
    });

    const brands = Object.entries(brandMap)
      .map(([name, count]) => ({ name, sellersCount: count }))
      .sort((a, b) => b.sellersCount - a.sellersCount);

    console.log('[OBG] === Brand scan result ===', brands);
    console.log('[OBG] Total unique brands found:', brands.length);

    // Get current page info for the user
    const pageInfo = getCurrentPageInfo();
    safeSend({
      action: 'scanBrandsResult',
      brands,
      pageInfo
    });
  }

  // ── Brand scan helpers ──
  function findColumnByHeader(headerNames) {
    // Look for header cells containing "Бренд"
    const headerCells = document.querySelectorAll('th, thead td, [role="columnheader"]');

    for (let i = 0; i < headerCells.length; i++) {
      const text = headerCells[i].textContent.trim().toLowerCase();
      if (headerNames.some((h) => text.includes(h.toLowerCase()))) {
        return i;
      }
    }

    // Fallback: scan first row that looks like a header
    const firstRow = document.querySelector('tr, [role="row"]');
    if (firstRow) {
      const cells = getRowCells(firstRow);
      for (let i = 0; i < cells.length; i++) {
        const text = cells[i].textContent.trim().toLowerCase();
        if (headerNames.some((h) => text.includes(h.toLowerCase()))) {
          return i;
        }
      }
    }

    // Deep scan: find any element with text "Бренд" and determine its column position
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length === 0 && el.textContent.trim().toLowerCase() === 'бренд') {
        // Found "Бренд" label — determine its index among siblings
        const parent = el.closest('tr') || el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const idx = siblings.indexOf(el.closest('td, th, [role="cell"], [role="columnheader"]') || el);
          if (idx >= 0) return idx;
        }
      }
    }

    return -1;
  }

  function getDataRows() {
    // Get all data rows (not header)
    let rows = Array.from(document.querySelectorAll('table tbody tr, tbody tr'));
    if (rows.length > 0) return rows;

    rows = Array.from(document.querySelectorAll('tr'));
    // Skip first row (likely header)
    if (rows.length > 1) return rows.slice(1);

    rows = Array.from(document.querySelectorAll('[role="row"]'));
    if (rows.length > 1) return rows.slice(1);

    return [];
  }

  function getRowCells(row) {
    let cells = row.querySelectorAll('td, [role="cell"]');
    if (cells.length > 0) return Array.from(cells);
    cells = row.querySelectorAll('th, [role="columnheader"]');
    if (cells.length > 0) return Array.from(cells);
    // Fallback: direct children
    return Array.from(row.children);
  }

  function extractTextParts(el) {
    const parts = [];
    const children = el.querySelectorAll('*');
    children.forEach((child) => {
      if (child.children.length === 0 && child.offsetParent !== null) {
        const text = child.textContent.trim();
        if (text && text.length > 0 && text.length < 100) {
          parts.push(text);
        }
      }
    });
    return [...new Set(parts)];
  }

  function isValidBrand(text) {
    if (!text || text.length < 2 || text.length > 50) return false;
    if (/^\d+$/.test(text)) return false;
    if (/^\d[\d\s,.]+$/.test(text)) return false;
    if (/^(CN|RU|TR|KR|IN|US|DE|GB|\u2013|\u2014|—|–)$/.test(text)) return false;
    if (/^\d{2}[./]\d{2}[./]\d{2,4}/.test(text)) return false;
    return true;
  }

  function isSellerMeta(text) {
    // Filter out INN-like numbers, long addresses, etc.
    if (/^\d{10,}/.test(text)) return true;
    if (text.includes(',') && text.length > 30) return true;
    return false;
  }

  function getCurrentPageInfo() {
    // Try to find pagination info like "1-10 из 40"
    const allText = document.body.innerText;
    const match = allText.match(/(\d+)\s*[-–]\s*(\d+)\s+из\s+(\d+)/);
    if (match) {
      return { from: +match[1], to: +match[2], total: +match[3] };
    }
    return null;
  }

  // ── Main process ──
  async function startProcess() {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;
    stats = { total: 0, violators: 0, whitelisted: 0, complained: 0, skipped: 0 };
    logLines = [];

    safeSend({ action: 'setRunning', running: true });
    showPanel();
    log('Запуск сканирования...');

    try {
      await processAllPages();
      log(`Готово! Жалоб отправлено: ${stats.complained}`, 'success');

      if (config.notificationsEnabled) {
        safeSend({
          action: 'showNotification',
          title: 'OZON Brand Guard — Готово',
          message: `Нарушителей: ${stats.violators}, Жалоб: ${stats.complained}`
        });
      }
    } catch (err) {
      log('Ошибка: ' + err.message, 'error');
    } finally {
      isRunning = false;
      safeSend({ action: 'setRunning', running: false });
      safeSend({ action: 'done' });
      sendStats();
    }
  }

  function stopProcess() {
    shouldStop = true;
    isRunning = false;
    log('Остановлено пользователем', 'warning');
    safeSend({ action: 'setRunning', running: false });
    safeSend({ action: 'done' });
    // Close any open modals/menus
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

      const sellers = parseSellersTable();
      stats.total += sellers.length;

      log(`Найдено продавцов на странице: ${sellers.length}`);

      for (const seller of sellers) {
        if (shouldStop) break;

        const isWhitelisted = checkWhitelist(seller);
        const isBannedCountry = config.useCountryFilter && config.bannedCountries.includes(seller.country);

        if (isWhitelisted) {
          stats.whitelisted++;
          highlightRow(seller.rowElement, 'safe');
          log(`✓ ${seller.name} — в whitelist`, 'safe');
          continue;
        }

        // Seller is a violator if: not in whitelist AND (banned country OR just not whitelisted depending on mode)
        if (isBannedCountry || !config.useCountryFilter) {
          stats.violators++;
          highlightRow(seller.rowElement, 'violator');
          log(`✗ ${seller.name} (${seller.country}) — бренд: ${seller.brand}`, 'danger');

          if (config.mode === 'complain' && !config.dryRun) {
            await fileComplaint(seller);
          }
        } else {
          stats.skipped++;
          log(`~ ${seller.name} (${seller.country}) — пропущен (страна не в фильтре)`);
        }

        sendStats();
      }

      // Check for next page
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
  // Real OZON structure (from live HTML):
  // <tr> with 9 <td> cells:
  //   td[0]=checkbox, td[1]=name+INN, td[2]=brand, td[3]=count,
  //   td[4]=country, td[5]=docs, td[6]=promotion, td[7]=toggle, td[8]=menu(⋮)
  function parseSellersTable() {
    const sellers = [];

    // OZON uses standard <table> with <tr>/<td>
    let rows = Array.from(document.querySelectorAll('table tbody tr'));
    if (rows.length === 0) {
      rows = Array.from(document.querySelectorAll('table tr'));
    }

    // Filter: only rows with enough cells (skip header/noise)
    rows = rows.filter((row) => row.querySelectorAll('td').length >= 5);

    if (rows.length === 0) {
      console.log('[OBG] No table rows found, trying fallback...');
      return parseSellersFallback();
    }

    rows.forEach((row) => {
      const seller = extractSellerFromRow(row);
      if (seller) {
        sellers.push(seller);
      }
    });

    return sellers;
  }

  function parseSellersFallback() {
    const sellers = [];

    // Fallback: find <td> cells containing country codes, walk up to <tr>
    const allTds = document.querySelectorAll('td');
    const countryCells = Array.from(allTds).filter((td) => {
      const text = td.textContent.trim();
      return /^(CN|RU|TR|KR|IN|US|DE|GB)$/.test(text);
    });

    countryCells.forEach((countryCell) => {
      const row = countryCell.closest('tr');
      if (!row) return;

      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 5) return;

      // Find country cell index to determine name/brand positions
      const countryIdx = cells.indexOf(countryCell);
      const nameCell = cells[Math.max(0, countryIdx - 3)];
      const brandCell = cells[Math.max(0, countryIdx - 2)];
      const country = countryCell.textContent.trim();

      const { name, inn } = parseNameCell(nameCell);

      sellers.push({
        name,
        inn,
        brand: brandCell ? brandCell.textContent.trim() : '',
        country,
        rowElement: row,
        menuButton: findMenuButton(row)
      });
    });

    return sellers;
  }

  function extractSellerFromRow(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 5) return null;

    // OZON fixed structure: td[0]=checkbox, td[1]=name, td[2]=brand, td[3]=count, td[4]=country
    // Primary: use fixed indices
    if (cells.length >= 5) {
      const countryText = cells[4].textContent.trim();
      if (/^(CN|RU|TR|KR|IN|US|DE|GB)$/.test(countryText)) {
        const { name, inn } = parseNameCell(cells[1]);
        return {
          name,
          inn,
          brand: cells[2].textContent.trim(),
          country: countryText,
          rowElement: row,
          menuButton: findMenuButton(row)
        };
      }
    }

    // Fallback: scan all cells for country code and calculate offsets
    for (let i = 0; i < cells.length; i++) {
      const text = cells[i].textContent.trim();
      if (/^(CN|RU|TR|KR|IN|US|DE|GB)$/.test(text)) {
        const nameCell = cells[Math.max(0, i - 3)];
        const brandCell = cells[Math.max(0, i - 2)];
        const { name, inn } = parseNameCell(nameCell);
        return {
          name,
          inn,
          brand: brandCell ? brandCell.textContent.trim() : '',
          country: text,
          rowElement: row,
          menuButton: findMenuButton(row)
        };
      }
    }

    return null;
  }

  // Parse seller name cell — extract name and INN from child elements
  // Real OZON HTML: <td><div><div class="md5-bu7">Name</div><div class="md5-ub7">INN, Company</div></div></td>
  function parseNameCell(cell) {
    // Strategy 1: OZON-specific classes (most reliable when available)
    const nameEl = cell.querySelector('[class*="bu7"], [class*="bu-7"]');
    const innEl = cell.querySelector('[class*="ub7"], [class*="ub-7"]');
    if (nameEl && innEl) {
      return { name: nameEl.textContent.trim(), inn: innEl.textContent.trim() };
    }

    // Strategy 2: Find leaf-level divs inside the cell (works even if classes change)
    const leafDivs = Array.from(cell.querySelectorAll('div, span, p, a'))
      .filter((el) => el.children.length === 0);
    const uniqueTexts = [];
    const seen = new Set();
    for (const el of leafDivs) {
      const t = el.textContent.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        uniqueTexts.push(t);
      }
    }
    if (uniqueTexts.length >= 2) {
      return { name: uniqueTexts[0], inn: uniqueTexts.slice(1).join(', ') };
    }

    // Strategy 3: Fallback — split by INN pattern (10-15 digit/letter sequences)
    const raw = cell.textContent.trim();
    const innMatch = raw.match(/(\d{10,15})/);
    if (innMatch) {
      const innIndex = raw.indexOf(innMatch[1]);
      const namePart = raw.substring(0, innIndex).trim();
      const innPart = raw.substring(innIndex).trim();
      return { name: namePart || raw, inn: innPart };
    }

    // Final fallback: split by newline
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    return { name: lines[0] || raw, inn: lines[1] || '' };
  }

  function findMenuButton(row) {
    // OZON structure: menu button (⋮) is in the LAST <td>,
    // it's a <button> containing only an SVG (three dots icon)
    const tds = row.querySelectorAll('td');
    if (tds.length > 0) {
      const lastTd = tds[tds.length - 1];
      const btn = lastTd.querySelector('button');
      if (btn) return btn;
    }

    // Fallback: find button with SVG-only content (no text) in the row
    const allButtons = row.querySelectorAll('button');
    for (const btn of allButtons) {
      const svg = btn.querySelector('svg');
      const text = btn.textContent.trim();
      if (svg && !text) {
        return btn;
      }
    }

    // Last resort: last button in row
    if (allButtons.length > 0) {
      return allButtons[allButtons.length - 1];
    }

    return null;
  }

  // ── Whitelist check ──
  function checkWhitelist(seller) {
    for (const entry of config.whitelist) {
      if (entry.type === 'inn' && seller.inn.includes(entry.value)) {
        return true;
      }
      if (entry.type === 'name' && seller.name.toLowerCase().includes(entry.value.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  // ── Complaint automation ──
  // Minimum cooldown between any complaint attempts (success or fail)
  const MIN_COOLDOWN_MS = 10000; // 10 seconds

  async function fileComplaint(seller) {
    if (shouldStop) return;
    log(`Подаём жалобу на: ${seller.name}...`);

    const startTime = Date.now();
    let success = false;

    try {
      // Step 1: Click the menu button (three dots)
      if (!seller.menuButton) {
        log(`  Кнопка меню не найдена для ${seller.name}`, 'error');
        stats.skipped++;
        return;
      }

      // Scroll row into view
      seller.rowElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(1000);
      if (shouldStop) return;

      simulateRealClick(seller.menuButton);
      log(`  Клик на меню (⋮)...`);
      await sleep(3000); // Wait 3s for menu to open
      if (shouldStop) return;

      // Step 2: Find and click "Пожаловаться на продавца" with retries
      const complainButton = await findComplainButtonWithRetry();
      if (shouldStop) return;
      if (!complainButton) {
        log(`  Кнопка "Пожаловаться" не найдена для ${seller.name}`, 'error');
        log(`  Закрываем меню...`);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(500);
        stats.skipped++;
        return;
      }

      // Log what we're clicking for debugging
      const btnTag = complainButton.tagName.toLowerCase();
      const btnText = complainButton.textContent.trim().substring(0, 40);
      const btnClass = (complainButton.className || '').substring(0, 50);
      const btnRole = complainButton.getAttribute('role') || '';
      const btnParent = complainButton.parentElement;
      const parentTag = btnParent ? btnParent.tagName.toLowerCase() : 'none';
      const parentClass = btnParent ? (btnParent.className || '').substring(0, 50) : '';
      log(`  Клик: <${btnTag} role="${btnRole}" class="${btnClass}"> "${btnText}"`);
      log(`  Parent: <${parentTag} class="${parentClass}">`);

      simulateRealClick(complainButton);
      log(`  Открываем форму жалобы...`);
      await sleep(5000); // Wait 5s for sidebar to open and render form
      if (shouldStop) return;

      // Step 3: Fill complaint text
      const complaintText = getComplaintText(seller.brand);
      const textarea = await findTextareaInModal();
      if (shouldStop) return;

      if (!textarea) {
        log(`  Поле текста жалобы не найдено для ${seller.name}`, 'error');
        closeModal();
        stats.skipped++;
        return;
      }

      // Simulate typing — use appropriate method based on element type
      setInputValueSmart(textarea, complaintText);
      log(`  Текст жалобы заполнен`);
      await sleep(2000);
      if (shouldStop) return;

      // Step 4: Attach trademark file
      const brand = config.brands.find(
        (b) => b.name.toLowerCase() === seller.brand.toLowerCase()
      );

      if (brand && brand.fileData) {
        await attachFile(brand);
        log(`  ⏳ Ожидание загрузки файла (8с)...`);
        await sleep(8000);
        if (shouldStop) return;
      }

      // Step 5: Click submit
      const submitButton = findSubmitButton();
      if (!submitButton) {
        log(`  Кнопка "Отправить" не найдена для ${seller.name}`, 'error');
        closeModal();
        stats.skipped++;
        return;
      }

      simulateRealClick(submitButton);
      log(`  Отправляем жалобу...`);
      await sleep(3000);

      // Log success
      stats.complained++;
      success = true;
      log(`  ✓ Жалоба отправлена на ${seller.name}`, 'success');

      safeSend({
        action: 'logComplaint',
        entry: {
          date: new Date().toISOString(),
          seller: seller.name,
          inn: seller.inn,
          brand: seller.brand,
          country: seller.country,
          success: true
        }
      });

    } catch (err) {
      log(`  Ошибка при жалобе на ${seller.name}: ${err.message}`, 'error');

      safeSend({
        action: 'logComplaint',
        entry: {
          date: new Date().toISOString(),
          seller: seller.name,
          inn: seller.inn,
          brand: seller.brand,
          country: seller.country,
          success: false,
          error: err.message
        }
      });

      closeModal();
    }

    // ALWAYS wait cooldown between complaints (success or fail)
    await waitCooldown(startTime);
  }

  async function waitCooldown(startTime) {
    if (shouldStop) return;
    const elapsed = Date.now() - startTime;
    const delay = Math.max(config.delaySeconds * 1000, MIN_COOLDOWN_MS);
    const jitter = Math.floor(Math.random() * 5000); // 0-5s random jitter
    const remaining = delay + jitter - elapsed;
    if (remaining > 0) {
      log(`  ⏳ Ожидание ${Math.round(remaining / 1000)}с перед следующей жалобой...`, 'warning');
      await sleep(remaining);
    }
  }

  function getComplaintText(brandName) {
    const brand = config.brands.find(
      (b) => b.name.toLowerCase() === brandName.toLowerCase()
    );

    let text = '';
    if (brand && brand.complaint) {
      text = brand.complaint;
    } else {
      text = config.defaultComplaint || 'Продажа подделок на мой бренд';
    }

    // Strip URLs from complaint text (safety measure)
    text = text.replace(/https?:\/\/[^\s]+/gi, '').replace(/\s{2,}/g, ' ').trim();

    return text;
  }

  async function findComplainButtonWithRetry() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (shouldStop) return null;
      log(`  Поиск кнопки "Пожаловаться" (попытка ${attempt}/5)...`);

      const btn = findComplainButtonInDOM();
      if (btn) {
        log(`  Кнопка найдена!`, 'success');
        return btn;
      }

      if (attempt < 5) {
        await sleep(2000);
      }
    }

    // Log what IS visible for debugging
    const allVisible = document.querySelectorAll(
      '[role="menuitem"], [role="option"], [class*="menu"] *, [class*="dropdown"] *, [class*="popover"] *'
    );
    const visibleTexts = Array.from(allVisible)
      .map((el) => el.textContent.trim())
      .filter((t) => t.length > 0 && t.length < 60);
    console.log('[OBG] Visible menu items:', [...new Set(visibleTexts)]);

    return null;
  }

  function findComplainButtonInDOM() {
    // IMPORTANT: exclude our own floating panel from search!
    const ourPanel = document.getElementById('obg-float-panel');

    // Search broadly in the DOM
    const allClickable = document.querySelectorAll(
      'button, [role="menuitem"], [role="option"], a, li, span, div'
    );

    let bestMatch = null;
    let bestSpecificity = 0; // higher = more specific match

    for (const el of allClickable) {
      // Skip elements inside our own panel
      if (ourPanel && ourPanel.contains(el)) continue;

      // Skip elements inside our panel by ID check
      if (el.closest('#obg-float-panel')) continue;

      const ownText = getOwnText(el).toLowerCase();
      const fullText = el.textContent.trim().toLowerCase();

      // Match "Пожаловаться" specifically (NOT broad "жалоба")
      let specificity = 0;
      if (ownText.includes('пожаловаться на продавца')) {
        specificity = 10; // best: exact own text
      } else if (ownText.includes('пожаловаться')) {
        specificity = 8;
      } else if (fullText === 'пожаловаться на продавца') {
        specificity = 6;
      } else if (fullText.includes('пожаловаться') && fullText.length < 50) {
        specificity = 4; // short element containing the word
      } else if (ownText.includes('report seller') || ownText.includes('complain')) {
        specificity = 3;
      } else {
        continue; // no match
      }

      // Prefer leaf elements (no children = most specific)
      if (el.children.length === 0) specificity += 2;
      // Prefer menuitem role
      if (el.getAttribute('role') === 'menuitem') specificity += 1;

      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        bestMatch = el;
      }
    }

    // If we found a match, try to return the best clickable ancestor
    if (bestMatch) {
      const menuItem = bestMatch.closest('[role="menuitem"]');
      if (menuItem && !menuItem.closest('#obg-float-panel')) return menuItem;
      const btn = bestMatch.closest('button');
      if (btn && !btn.closest('#obg-float-panel')) return btn;
      const li = bestMatch.closest('li');
      if (li && !li.closest('#obg-float-panel')) return li;
      return bestMatch;
    }

    return null;
  }

  // Get element's own direct text (not children's text)
  function getOwnText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim();
  }

  function findSubmitButton() {
    // Real OZON structure: <form> contains <button type="submit"> with <span>Отправить</span>
    // Note: the back-arrow button is ALSO type="submit", so we must match by text

    // Strategy 1: Find inside complaint sidebar form
    const sidebar = findComplaintSidebar();
    if (sidebar) {
      const formButtons = sidebar.querySelectorAll('form button[type="submit"]');
      for (const btn of formButtons) {
        if (btn.textContent.trim() === 'Отправить') {
          return btn;
        }
      }
    }

    // Strategy 2: Any button with text "Отправить" inside a form
    const allFormBtns = document.querySelectorAll('form button');
    for (const btn of allFormBtns) {
      if (btn.textContent.trim() === 'Отправить') {
        return btn;
      }
    }

    // Strategy 3: Any button with text "Отправить" on the page
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'отправить' || text === 'отправить жалобу') {
        return btn;
      }
    }

    return null;
  }

  async function attachFile(brand) {
    if (!brand.fileData) return;

    try {
      // Real OZON structure: <input type="file" accept=".jpg,.png,.jpeg,.pdf" multiple>
      // First try inside complaint sidebar, then fallback to any file input
      let fileInput = null;

      const sidebar = findComplaintSidebar();
      if (sidebar) {
        fileInput = sidebar.querySelector('input[type="file"]');
      }
      if (!fileInput) {
        fileInput = document.querySelector('form input[type="file"]');
      }
      if (!fileInput) {
        fileInput = await waitForElement('input[type="file"]', 3000);
      }

      if (!fileInput) {
        log('  Поле загрузки файла не найдено', 'warning');
        return;
      }

      // Convert base64 data URL to File object
      const response = await fetch(brand.fileData);
      const blob = await response.blob();
      const file = new File([blob], brand.fileName || 'trademark.pdf', { type: blob.type });

      // Create a DataTransfer to set files on input
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Trigger change event
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

      log(`  Файл прикреплён: ${brand.fileName}`);
      await sleep(500);
    } catch (err) {
      log(`  Ошибка загрузки файла: ${err.message}`, 'warning');
    }
  }

  // ── Find textarea inside complaint sidebar ──
  // Known OZON textarea: <textarea id="baseInput___*" class="r8c110-a2 ...">
  // It may be in regular DOM, Shadow DOM, or iframe
  async function findTextareaInModal() {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (shouldStop) return null;
      log(`  Поиск поля ввода (попытка ${attempt}/8)...`);

      // Diagnostics on first and last attempt
      if (attempt === 1 || attempt === 8) {
        logDOMDiagnostics();
      }

      // Strategy 1: Direct querySelector (regular DOM)
      const formTextarea = document.querySelector('form textarea') || document.querySelector('textarea');
      if (formTextarea) {
        log(`  ✓ Поле найдено: textarea в DOM`, 'success');
        return formTextarea;
      }

      // Strategy 2: Search by OZON-specific ID pattern and class
      const byId = document.querySelector('textarea[id^="baseInput"]');
      if (byId) {
        log(`  ✓ Поле найдено по ID baseInput*`, 'success');
        return byId;
      }
      const byClass = document.querySelector('textarea[class*="r8c110"]') || document.querySelector('[class*="r8c110"]');
      if (byClass && (byClass.tagName === 'TEXTAREA' || byClass.getAttribute('contenteditable'))) {
        log(`  ✓ Поле найдено по классу r8c110`, 'success');
        return byClass;
      }

      // Strategy 3: Deep search — Shadow DOM and iframes
      const deepTextarea = deepQuerySelector('textarea');
      if (deepTextarea) {
        log(`  ✓ Textarea найден через deep search (Shadow DOM / iframe)`, 'success');
        return deepTextarea;
      }
      const deepById = deepQuerySelector('textarea[id^="baseInput"]');
      if (deepById) {
        log(`  ✓ Textarea baseInput* найден через deep search`, 'success');
        return deepById;
      }

      // Strategy 4: Find complaint sidebar and look inside
      const sidebar = findComplaintSidebar();
      if (sidebar) {
        log(`  Sidebar найден, ищем textarea внутри...`);
        const ta = sidebar.querySelector('textarea');
        if (ta) {
          log(`  ✓ Поле найдено в sidebar`, 'success');
          return ta;
        }
        const editable = sidebar.querySelector('[role="textbox"], [contenteditable="true"], [contenteditable=""]');
        if (editable) {
          log(`  ✓ Editable элемент найден в sidebar`, 'success');
          return editable;
        }
        // Multi-step wizard handling
        if (attempt <= 3) {
          const handled = await handleComplaintReasonStep(sidebar);
          if (handled) {
            log(`  Выбрана причина жалобы, ожидаем textarea...`);
            await sleep(3000);
            const taAfter = document.querySelector('textarea') || deepQuerySelector('textarea');
            if (taAfter) {
              log(`  ✓ Textarea появился после выбора причины`, 'success');
              return taAfter;
            }
          }
        }
      } else {
        log(`  Sidebar не найден`);
      }

      // Strategy 5: Any editable element
      const anyEditable = document.querySelector('[role="textbox"], [contenteditable="true"]');
      if (anyEditable) {
        log(`  ✓ Editable элемент найден`, 'success');
        return anyEditable;
      }

      if (attempt < 8 && !shouldStop) {
        await sleep(2500);
      }
    }

    if (shouldStop) return null;

    // Final diagnostics
    log(`  ❌ Textarea не найден после 8 попыток`, 'error');
    logDOMDiagnostics();

    return null;
  }

  // Log DOM diagnostics visible to user for debugging
  function logDOMDiagnostics() {
    const forms = document.querySelectorAll('form');
    const textareas = document.querySelectorAll('textarea');
    const inputs = document.querySelectorAll('input:not([type="hidden"])');
    const editables = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
    const sidebar = findComplaintSidebar();

    // Count shadow roots and iframes
    const shadowRoots = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).length;
    const iframes = document.querySelectorAll('iframe').length;
    const deepTextareas = deepQuerySelectorAll('textarea');

    log(`  [DIAG] Forms: ${forms.length}, Textareas: ${textareas.length}, DeepTextareas: ${deepTextareas.length}, Inputs: ${inputs.length}, Editables: ${editables.length}`);
    log(`  [DIAG] ShadowRoots: ${shadowRoots}, Iframes: ${iframes}`);
    log(`  [DIAG] Sidebar найден: ${sidebar ? 'ДА' : 'НЕТ'}`);

    // If deep search found textareas but regular didn't, log details
    if (deepTextareas.length > 0 && textareas.length === 0) {
      log(`  [DIAG] ⚠️ Textarea найден ТОЛЬКО через deep search!`);
      deepTextareas.forEach((ta, i) => {
        log(`  [DIAG]   deep[${i}]: id="${ta.id}" class="${ta.className.substring(0, 60)}"`);
      });
    }

    if (sidebar) {
      const sidebarText = sidebar.textContent.substring(0, 200).replace(/\s+/g, ' ').trim();
      log(`  [DIAG] Sidebar текст: ${sidebarText}`);
      const sidebarInputs = sidebar.querySelectorAll('input, textarea, select, [role="textbox"], [contenteditable]');
      log(`  [DIAG] Sidebar поля ввода: ${sidebarInputs.length}`);
      sidebarInputs.forEach((el, i) => {
        log(`  [DIAG]   ${i}: <${el.tagName.toLowerCase()} type="${el.type || ''}" role="${el.getAttribute('role') || ''}" class="${el.className.substring(0, 50)}">`);
      });
      // Log radio buttons, checkboxes, selects (multi-step indicators)
      const radios = sidebar.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      const selects = sidebar.querySelectorAll('select');
      const labels = sidebar.querySelectorAll('label');
      if (radios.length > 0) log(`  [DIAG] Radio/Checkbox в sidebar: ${radios.length}`);
      if (selects.length > 0) log(`  [DIAG] Select в sidebar: ${selects.length}`);
      if (labels.length > 0) {
        const labelTexts = Array.from(labels).map(l => l.textContent.trim()).filter(Boolean).slice(0, 5);
        log(`  [DIAG] Labels: ${labelTexts.join(', ')}`);
      }
    }

    // Check for any overlay/drawer that might be the sidebar
    const overlays = document.querySelectorAll('[class*="sidebar"], [class*="Sidebar"], [class*="drawer"], [class*="Drawer"], [class*="overlay"], [class*="Overlay"], [class*="modal"], [class*="Modal"], [class*="panel"], [class*="Panel"]');
    if (overlays.length > 0) {
      log(`  [DIAG] Overlay/sidebar элементы: ${overlays.length}`);
      overlays.forEach((el, i) => {
        if (i < 3) {
          const cls = el.className.substring(0, 80);
          const text = el.textContent.substring(0, 100).replace(/\s+/g, ' ').trim();
          log(`  [DIAG]   ${i}: class="${cls}" text="${text}"`);
        }
      });
    }

    console.log('[OBG] Full DOM diagnostics:');
    console.log('[OBG] Forms:', forms.length);
    forms.forEach((f, i) => {
      console.log(`[OBG] Form ${i}:`, f.innerHTML.substring(0, 500));
    });
    if (sidebar) {
      console.log('[OBG] Sidebar innerHTML:', sidebar.innerHTML.substring(0, 1000));
    }
  }

  // Handle multi-step complaint wizard: select complaint reason if radio/select/checkbox found
  async function handleComplaintReasonStep(sidebar) {
    // Look for radio buttons (OZON may show complaint reason options)
    const radios = sidebar.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      // Click the first radio option (usually generic complaint)
      const firstRadio = radios[0];
      firstRadio.click();
      firstRadio.dispatchEvent(new Event('change', { bubbles: true }));
      log(`  Выбран radio: ${firstRadio.closest('label')?.textContent?.trim() || 'option 1'}`);
      return true;
    }

    // Look for clickable list items (complaint reason cards)
    const listItems = sidebar.querySelectorAll('li, [role="option"], [role="listitem"], [class*="item"], [class*="Item"]');
    for (const item of listItems) {
      const text = item.textContent.trim().toLowerCase();
      // Look for items that indicate a complaint reason
      if (
        text.includes('подделк') || text.includes('фальсиф') ||
        text.includes('контрафакт') || text.includes('торговый знак') ||
        text.includes('товарный знак') || text.includes('бренд') ||
        text.includes('интеллектуальн') || text.includes('нарушен') ||
        text.includes('другое') || text.includes('прочее') || text.includes('иное')
      ) {
        item.click();
        log(`  Выбрана причина: ${text.substring(0, 50)}`);
        return true;
      }
    }

    // Look for select dropdown
    const selects = sidebar.querySelectorAll('select');
    if (selects.length > 0) {
      const select = selects[0];
      // Select last option (often "Другое" / "Other")
      if (select.options.length > 1) {
        select.selectedIndex = select.options.length - 1;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        log(`  Выбран select: ${select.options[select.selectedIndex]?.text}`);
        return true;
      }
    }

    // Look for clickable buttons/links that might be step navigation
    const btns = sidebar.querySelectorAll('button, a');
    for (const btn of btns) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'далее' || text === 'продолжить' || text === 'next' || text === 'выбрать') {
        btn.click();
        log(`  Клик: ${btn.textContent.trim()}`);
        return true;
      }
    }

    return false;
  }

  // Find the complaint sidebar container
  function findComplaintSidebar() {
    // Strategy 1: Look for elements with "Жалоба" text and walk up to form
    const allElements = document.querySelectorAll('div, h1, h2, h3, h4, h5, span, p');
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (el.children.length === 0 && (text.startsWith('Жалоба на') || text.startsWith('Жалоба'))) {
        // Walk up to find the sidebar container
        let container = el;
        for (let i = 0; i < 15; i++) {
          container = container.parentElement;
          if (!container || container === document.body) break;
          // Check if this looks like a sidebar/overlay (large, has form or inputs)
          if (container.querySelector('form')) return container;
          if (container.querySelector('textarea')) return container;
          if (container.querySelector('input[type="file"]')) return container;
          // Check by size — sidebar is typically a large overlay panel
          const rect = container.getBoundingClientRect();
          if (rect.width > 300 && rect.height > 400 && container.querySelectorAll('button').length >= 2) {
            return container;
          }
        }
      }
    }

    // Strategy 2: Look for any recently appeared large overlay/sidebar
    const candidates = document.querySelectorAll(
      '[class*="sidebar"], [class*="Sidebar"], [class*="drawer"], [class*="Drawer"], ' +
      '[class*="SlidePanel"], [class*="slidePanel"], [class*="slide-panel"], ' +
      '[class*="overlay"] > div, [class*="Overlay"] > div, ' +
      '[role="dialog"], [role="complementary"], [aria-modal="true"]'
    );
    for (const el of candidates) {
      const text = el.textContent || '';
      if (text.includes('Жалоба') || text.includes('жалоб') || text.includes('Отправить')) {
        return el;
      }
    }

    // Strategy 3: Find any container with both a form/textarea and complaint-related text
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      const text = form.textContent || '';
      if (text.includes('Жалоба') || text.includes('жалоб') || text.includes('Отправить')) {
        // Return form's parent as the sidebar container
        return form.parentElement || form;
      }
    }

    return null;
  }

  // ── Input helpers (React-compatible) ──
  function setInputValueSmart(element, value) {
    const tag = element.tagName.toLowerCase();
    const isContentEditable = element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === '';
    const isTextbox = element.getAttribute('role') === 'textbox';

    if (isContentEditable || isTextbox) {
      // For contenteditable / role=textbox elements
      element.focus();
      element.textContent = value;
      element.innerHTML = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      // Also try execCommand for React compatibility
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
      } catch (e) { /* ignore */ }
    } else {
      // For standard textarea/input elements
      setInputValue(element, value);
    }
  }

  function setInputValue(element, value) {
    // For React-controlled inputs, we need to use native setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function closeModal() {
    // Real OZON structure: sidebar close button is <button type="button"> with an SVG (X icon)
    // at the end of the sidebar container, sibling to the main content div

    // Strategy 1: Find close button inside complaint sidebar
    const sidebar = findComplaintSidebar();
    if (sidebar) {
      // The close button is button[type="button"] containing only SVG
      const buttons = sidebar.querySelectorAll('button[type="button"]');
      for (const btn of buttons) {
        const svg = btn.querySelector('svg');
        const text = btn.textContent.trim();
        if (svg && !text) {
          btn.click();
          return;
        }
      }
    }

    // Strategy 2: Click the back arrow button in the sidebar header
    if (sidebar) {
      const backBtn = sidebar.querySelector('button[type="submit"]');
      if (backBtn && backBtn.querySelector('svg') && !backBtn.textContent.trim()) {
        backBtn.click();
        return;
      }
    }

    // Strategy 3: Press Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // ── Pagination ──
  // Real OZON structure:
  // <ul class="t0c110-a">
  //   <li><button data-selected="true" disabled class="...t0c110-a3">1</button></li>
  //   <li><button class="...">2</button></li>
  //   ...
  // </ul>
  // <div class="md5-u9b">1-10 из 40</div>
  async function goToNextPage() {
    // Strategy 1: Find pagination <ul> and use data-selected to find current page
    const paginationButtons = document.querySelectorAll('ul li button');
    const pageBtns = Array.from(paginationButtons).filter((btn) => /^\d+$/.test(btn.textContent.trim()));

    if (pageBtns.length > 0) {
      let currentIndex = -1;

      for (let i = 0; i < pageBtns.length; i++) {
        const btn = pageBtns[i];
        // OZON marks current page with data-selected="true" and disabled
        if (btn.getAttribute('data-selected') === 'true' || btn.disabled) {
          currentIndex = i;
          break;
        }
      }

      if (currentIndex >= 0 && currentIndex < pageBtns.length - 1) {
        const nextBtn = pageBtns[currentIndex + 1];
        log(`  Переход на страницу ${nextBtn.textContent.trim()}...`);
        nextBtn.click();
        await sleep(3000);
        return true;
      }

      // If no data-selected found, try clicking page 2 if we're likely on page 1
      if (currentIndex === -1 && pageBtns.length >= 2) {
        // Check if first button looks selected (disabled or different style)
        if (pageBtns[0].disabled || pageBtns[0].getAttribute('data-selected')) {
          pageBtns[1].click();
          await sleep(3000);
          return true;
        }
      }
    }

    // Strategy 2: Fallback — look for any "next" controls
    const allButtons = document.querySelectorAll('button, a');
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes('след') || text.includes('next') || text === '→' || text === '›') {
        if (!btn.disabled) {
          btn.click();
          await sleep(3000);
          return true;
        }
      }
    }

    return false;
  }

  // ── DOM helpers ──
  async function waitForTable(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const table = document.querySelector(
        'table, [class*="Table"], [class*="table"], [role="table"], [class*="sellers"]'
      );
      if (table) return table;
      await sleep(500);
    }
    throw new Error('Таблица продавцов не найдена');
  }

  async function waitForElement(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Row highlighting ──
  function highlightRow(row, type) {
    if (!row) return;
    row.classList.remove('obg-violator-row', 'obg-whitelisted-row');

    if (type === 'violator') {
      row.classList.add('obg-violator-row');
    } else if (type === 'safe') {
      row.classList.add('obg-whitelisted-row');
    }
  }

  // ── Floating panel UI ──
  let panelMinimized = false;

  function showPanel() {
    removePanel();

    panelEl = document.createElement('div');
    panelEl.id = 'obg-float-panel';
    panelEl.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 380px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      resize: both;
      min-width: 300px;
      min-height: 60px;
    `;

    panelEl.innerHTML = `
      <div id="obg-panel-header" style="
        padding: 10px 12px;
        background: #005bff;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: grab;
        user-select: none;
      ">
        <span style="font-weight: 600; font-size: 13px; flex:1;">Brand Guard</span>
        <span id="obg-panel-status" style="
          font-size: 11px;
          background: rgba(255,255,255,0.2);
          padding: 2px 8px;
          border-radius: 8px;
        ">Работает...</span>
        <button id="obg-btn-stop" title="Остановить" style="
          background: #ff3b30; border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 12px; display: flex;
          align-items: center; justify-content: center;
        ">■</button>
        <button id="obg-btn-minimize" title="Свернуть" style="
          background: rgba(255,255,255,0.25); border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 14px; display: flex;
          align-items: center; justify-content: center;
        ">−</button>
        <button id="obg-btn-close" title="Закрыть панель" style="
          background: rgba(255,255,255,0.25); border: none; color: #fff; width: 24px; height: 24px;
          border-radius: 4px; cursor: pointer; font-size: 14px; display: flex;
          align-items: center; justify-content: center;
        ">×</button>
      </div>
      <div id="obg-panel-body">
        <div id="obg-panel-stats" style="
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 4px;
          padding: 8px;
          background: #f8f9ff;
          font-size: 11px;
          text-align: center;
        ">
          <div><strong id="obg-s-total">0</strong><br>Всего</div>
          <div><strong id="obg-s-viol" style="color:#ff3b30">0</strong><br>Наруш.</div>
          <div><strong id="obg-s-safe" style="color:#00cc44">0</strong><br>OK</div>
          <div><strong id="obg-s-sent" style="color:#005bff">0</strong><br>Жалоб</div>
        </div>
        <div id="obg-panel-log" style="
          max-height: 240px;
          overflow-y: auto;
          padding: 8px;
          font-size: 11px;
          font-family: 'SF Mono', Monaco, monospace;
          line-height: 1.6;
          color: #333;
        "></div>
        <div style="
          padding: 4px 8px;
          background: #f8f8f8;
          font-size: 10px;
          color: #999;
          text-align: right;
          border-top: 1px solid #eee;
        ">by <a href="https://t.me/firayzer" target="_blank" style="color:#005bff;text-decoration:none;">firayzer</a></div>
      </div>
    `;

    document.body.appendChild(panelEl);
    panelMinimized = false;

    // Drag functionality
    makeDraggable(panelEl, panelEl.querySelector('#obg-panel-header'));

    // Stop button
    panelEl.querySelector('#obg-btn-stop').addEventListener('click', () => {
      stopProcess();
    });

    // Minimize button
    panelEl.querySelector('#obg-btn-minimize').addEventListener('click', () => {
      const body = panelEl.querySelector('#obg-panel-body');
      const btn = panelEl.querySelector('#obg-btn-minimize');
      panelMinimized = !panelMinimized;
      body.style.display = panelMinimized ? 'none' : 'block';
      btn.textContent = panelMinimized ? '+' : '−';
      btn.title = panelMinimized ? 'Развернуть' : 'Свернуть';
    });

    // Close button
    panelEl.querySelector('#obg-btn-close').addEventListener('click', () => {
      removePanel();
    });
  }

  function makeDraggable(el, handle) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

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
      logContainer.innerHTML = logLines
        .slice(-30)
        .map((l) => `<div style="padding:2px 0;border-bottom:1px solid #f0f0f0;${l.style || ''}">${l.time} ${l.text}</div>`)
        .join('');
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    const statusEl = el('obg-panel-status');
    if (statusEl) {
      statusEl.textContent = isRunning ? 'Работает...' : 'Завершено';
    }
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
    console.log(`[OBG] ${time} ${text}`);
    safeSend({ action: 'techLog', text: `${time} ${text}` });
    updatePanel();
    sendStats();
  }

  function sendStats() {
    safeSend({ action: 'updateStats', stats });
  }
})();
