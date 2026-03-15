// OZON Brand Guard — Duplicate Detection Content Script v3.0.0
// Работает на www.ozon.ru/product/* страницах
// Парсит секции "Есть дешевле" / "Другие продавцы" для поиска подделок
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  // Guard: prevent double injection
  if (document.getElementById('__obg-duplicates-guard')) return;
  const guard = document.createElement('div');
  guard.id = '__obg-duplicates-guard';
  guard.style.display = 'none';
  document.body.appendChild(guard);

  let config = {};
  let shouldStop = false;
  let panelEl = null;
  let logLines = [];

  // ── Safe messaging ──
  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg, () => { if (chrome.runtime.lastError) { /* ignore */ } }); }
    catch (e) { /* extension context invalidated */ }
  }

  // ── Logging ──
  function log(text) {
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = `[${ts}] ${text}`;
    logLines.push(line);
    console.log('[OBG-D]', text);
    safeSend({ action: 'techLog', text: `[Дубликаты] ${line}` });
    updatePanelLog();
  }

  // ── Message listener ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startDuplicateScan') {
      config = msg.config || {};
      shouldStop = false;
      startScan(msg.skus || [], msg.currentIndex || 0);
    }
    if (msg.action === 'stopDuplicates') {
      shouldStop = true;
      log('⏹ Остановлено пользователем');
      safeSend({ action: 'duplicateScanStopped' });
    }
  });

  // ── Main scan function ──
  async function startScan(skus, startIndex) {
    log(`🔍 Начинаю парсинг страницы товара...`);
    showPanel();

    const currentSku = skus[startIndex];
    if (!currentSku) {
      log('❌ SKU не указан');
      safeSend({ action: 'duplicatePageResult', sku: '', competitors: [], error: 'SKU не указан' });
      return;
    }

    log(`📦 Обработка SKU: ${currentSku} (${startIndex + 1}/${skus.length})`);
    updatePanelStatus(`SKU: ${currentSku} (${startIndex + 1}/${skus.length})`);

    // Wait for page to fully load
    await waitForPageLoad();

    if (shouldStop) return;

    // Collect competitors from the page
    const competitors = await collectCompetitors(currentSku);

    if (shouldStop) return;

    log(`✅ Найдено ${competitors.length} конкурентов для SKU ${currentSku}`);

    // Send results back
    safeSend({
      action: 'duplicatePageResult',
      sku: currentSku,
      competitors: competitors,
      pageIndex: startIndex,
      totalSkus: skus.length
    });
  }

  // ── Wait for page content to load ──
  async function waitForPageLoad() {
    log('⏳ Ожидание загрузки страницы...');
    // Wait for main product content
    for (let i = 0; i < 20; i++) {
      if (shouldStop) return;
      // Check for product page markers
      const hasProduct = document.querySelector('[data-widget="webProductHeading"]') ||
                         document.querySelector('[data-widget="webSale"]') ||
                         document.querySelector('h1') ||
                         document.querySelector('[data-widget="webPrice"]');
      if (hasProduct) {
        log('✓ Страница загружена');
        await sleep(1500); // Extra wait for dynamic content
        return;
      }
      await sleep(500);
    }
    log('⚠ Таймаут ожидания загрузки, продолжаю...');
  }

  // ── Collect competitors from page ──
  async function collectCompetitors(mySku) {
    const competitors = [];
    const seenSkus = new Set();
    seenSkus.add(mySku); // Don't include own SKU

    // Strategy 1: Find "Есть дешевле" / "Другие продавцы" / "Предложения других продавцов" sections
    log('[DIAG] Стратегия 1: Поиск секций по ключевым словам...');
    const sections = findCompetitorSections();

    if (sections.length > 0) {
      for (const section of sections) {
        const items = parseProductCards(section, seenSkus, mySku);
        competitors.push(...items);
      }
      log(`[DIAG] Стратегия 1: найдено ${competitors.length} конкурентов в ${sections.length} секциях`);
    }

    // Strategy 2: Find "Все предложения" / "Показать все" links and try to expand
    if (competitors.length === 0 || sections.length === 0) {
      log('[DIAG] Стратегия 2: Поиск кнопки "Показать все"...');
      const expandBtn = findExpandButton();
      if (expandBtn) {
        log('→ Нажимаю "Показать все предложения"...');
        simulateClick(expandBtn);
        await sleep(2000);
        const newSections = findCompetitorSections();
        for (const section of newSections) {
          const items = parseProductCards(section, seenSkus, mySku);
          competitors.push(...items);
        }
        log(`[DIAG] Стратегия 2: найдено ${competitors.length} конкурентов`);
      }
    }

    // Strategy 3: Parse all product links on the page (broader search)
    if (competitors.length === 0) {
      log('[DIAG] Стратегия 3: Широкий поиск ссылок на товары...');
      const allItems = parseAllProductLinks(seenSkus, mySku);
      competitors.push(...allItems);
      log(`[DIAG] Стратегия 3: найдено ${competitors.length} ссылок`);
    }

    // Strategy 4: Look for "webSimilarOffer" / "webOtherSellers" widgets
    if (competitors.length === 0) {
      log('[DIAG] Стратегия 4: Поиск виджетов OZON...');
      const widgetItems = parseOzonWidgets(seenSkus, mySku);
      competitors.push(...widgetItems);
      log(`[DIAG] Стратегия 4: найдено ${competitors.length} товаров`);
    }

    // Apply whitelist filtering
    const filtered = applyWhitelist(competitors);
    if (filtered.length < competitors.length) {
      log(`🟢 Отфильтровано по вайтлисту: ${competitors.length - filtered.length} товаров`);
    }

    return filtered;
  }

  // ── Find sections containing competitor products ──
  function findCompetitorSections() {
    const keywords = [
      'есть дешевле', 'другие продавцы', 'другие предложения',
      'предложения других продавцов', 'похожие предложения',
      'другие товары', 'аналогичные товары'
    ];

    const sections = [];
    const visited = new Set();

    // Method 1: data-widget attributes
    const widgetSelectors = [
      '[data-widget="webSimilarOffer"]',
      '[data-widget="webOtherSellers"]',
      '[data-widget="webCompetitorProducts"]',
      '[data-widget*="Similar"]',
      '[data-widget*="Seller"]',
      '[data-widget*="Offer"]',
      '[data-widget*="Cheaper"]',
      '[data-widget="webHorizontalProductCarousel"]'
    ];

    for (const sel of widgetSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (!visited.has(el) && hasProductLinks(el)) {
          sections.push(el);
          visited.add(el);
        }
      }
    }

    // Method 2: Search by text content in headings
    const allHeadings = document.querySelectorAll('h2, h3, h4, [class*="heading"], [class*="title"]');
    for (const heading of allHeadings) {
      const text = heading.textContent.toLowerCase().trim();
      for (const kw of keywords) {
        if (text.includes(kw)) {
          // Walk up to find the section container
          let container = heading.parentElement;
          for (let i = 0; i < 5; i++) {
            if (container && hasProductLinks(container)) break;
            container = container?.parentElement;
          }
          if (container && !visited.has(container) && hasProductLinks(container)) {
            sections.push(container);
            visited.add(container);
            log(`[DIAG] Найдена секция: "${heading.textContent.trim().substring(0, 50)}"`);
          }
          break;
        }
      }
    }

    // Method 3: Search by TreeWalker for text nodes
    if (sections.length === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.toLowerCase().trim();
        for (const kw of keywords) {
          if (text === kw || (text.length < 40 && text.includes(kw))) {
            let container = node.parentElement;
            for (let i = 0; i < 6; i++) {
              if (container && hasProductLinks(container)) break;
              container = container?.parentElement;
            }
            if (container && !visited.has(container) && hasProductLinks(container)) {
              sections.push(container);
              visited.add(container);
              break;
            }
          }
        }
      }
    }

    return sections;
  }

  // ── Check if element contains product links ──
  function hasProductLinks(el) {
    if (!el) return false;
    const links = el.querySelectorAll('a[href*="/product/"]');
    return links.length > 0;
  }

  // ── Find "Show all" / expand button ──
  function findExpandButton() {
    const keywords = ['все предложения', 'показать все', 'все продавцы', 'смотреть все', 'ещё'];
    const allLinks = document.querySelectorAll('a, button, span[role="button"]');
    for (const el of allLinks) {
      const text = el.textContent.toLowerCase().trim();
      for (const kw of keywords) {
        if (text.includes(kw)) return el;
      }
    }
    return null;
  }

  // ── Parse product cards within a section ──
  function parseProductCards(container, seenSkus, mySku) {
    const items = [];
    const links = container.querySelectorAll('a[href*="/product/"]');

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const sku = extractSkuFromUrl(href);
      if (!sku || seenSkus.has(sku)) continue;
      seenSkus.add(sku);

      // Find the product card container (walk up from link)
      const card = findCardContainer(link);
      const data = extractCardData(card || link, sku, href);
      items.push(data);
    }

    return items;
  }

  // ── Parse all product links on page (broad) ──
  function parseAllProductLinks(seenSkus, mySku) {
    const items = [];

    // Exclude navigation, header, footer, breadcrumbs
    const excludeSelectors = ['header', 'footer', 'nav', '[data-widget="breadCrumbs"]', '[data-widget="webListReviews"]'];
    const excludeEls = new Set();
    for (const sel of excludeSelectors) {
      document.querySelectorAll(sel).forEach(el => excludeEls.add(el));
    }

    const links = document.querySelectorAll('a[href*="/product/"]');
    for (const link of links) {
      // Skip if inside excluded section
      let isExcluded = false;
      for (const ex of excludeEls) {
        if (ex.contains(link)) { isExcluded = true; break; }
      }
      if (isExcluded) continue;

      const href = link.getAttribute('href') || '';
      const sku = extractSkuFromUrl(href);
      if (!sku || seenSkus.has(sku)) continue;

      // Skip if this is the main product link (same SKU)
      if (sku === mySku) continue;

      seenSkus.add(sku);
      const card = findCardContainer(link);
      const data = extractCardData(card || link, sku, href);
      items.push(data);
    }

    return items;
  }

  // ── Parse OZON widgets ──
  function parseOzonWidgets(seenSkus, mySku) {
    const items = [];
    const widgets = document.querySelectorAll('[data-widget]');
    for (const widget of widgets) {
      const name = widget.getAttribute('data-widget') || '';
      // Target widgets that typically contain competitor/similar products
      if (name.includes('Similar') || name.includes('Offer') || name.includes('Seller') ||
          name.includes('Cheaper') || name.includes('Carousel') || name.includes('Recommend')) {
        const links = widget.querySelectorAll('a[href*="/product/"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const sku = extractSkuFromUrl(href);
          if (!sku || seenSkus.has(sku) || sku === mySku) continue;
          seenSkus.add(sku);
          const card = findCardContainer(link);
          items.push(extractCardData(card || link, sku, href));
        }
      }
    }
    return items;
  }

  // ── Extract SKU from OZON product URL ──
  function extractSkuFromUrl(url) {
    if (!url) return null;
    // Pattern: /product/name-NUMBERS/ or /product/NUMBERS/
    const match = url.match(/\/product\/(?:.*?[-/])?(\d{5,})(?:\/|$|\?|#)/);
    return match ? match[1] : null;
  }

  // ── Find the product card container ──
  function findCardContainer(link) {
    let el = link;
    for (let i = 0; i < 8; i++) {
      el = el.parentElement;
      if (!el) break;
      // Look for card-like container (has image + text + price)
      const hasImage = el.querySelector('img');
      const hasPrice = el.textContent.match(/\d[\d\s]*₽/);
      if (hasImage && hasPrice) return el;
    }
    return null;
  }

  // ── Extract data from a product card ──
  function extractCardData(container, sku, href) {
    const fullUrl = href.startsWith('http') ? href : 'https://www.ozon.ru' + href;

    // Extract product name
    let name = '';
    const titleEl = container.querySelector('[title]') || container.querySelector('span[class]');
    if (titleEl) {
      name = titleEl.getAttribute('title') || titleEl.textContent.trim();
    }
    if (!name) {
      // Try to get text from links
      const linkText = container.querySelector('a[href*="/product/"]');
      if (linkText) name = linkText.textContent.trim();
    }
    // Clean up name (max 150 chars)
    name = name.replace(/\s+/g, ' ').trim().substring(0, 150);

    // Extract price
    let price = '';
    const priceMatch = container.textContent.match(/(\d[\d\s]*)\s*₽/);
    if (priceMatch) {
      price = priceMatch[1].replace(/\s/g, '').trim();
    }

    // Extract seller name and seller URL
    let seller = '';
    let sellerUrl = '';
    // Look for seller link or text
    const sellerLink = container.querySelector('a[href*="/seller/"]');
    if (sellerLink) {
      seller = sellerLink.textContent.trim();
      const sHref = sellerLink.getAttribute('href') || '';
      sellerUrl = sHref.startsWith('http') ? sHref : (sHref ? 'https://www.ozon.ru' + sHref : '');
    }
    if (!seller) {
      // Look for small text that might be seller name
      const smallTexts = container.querySelectorAll('span, div');
      for (const st of smallTexts) {
        const t = st.textContent.trim();
        if (t.length > 2 && t.length < 50 && !t.includes('₽') && !t.includes('отзыв') &&
            !t.match(/^\d/) && st.children.length === 0) {
          if (st.parentElement && st.parentElement.querySelector('a[href*="/seller/"]')) {
            seller = t;
            const pLink = st.parentElement.querySelector('a[href*="/seller/"]');
            if (pLink) {
              const ph = pLink.getAttribute('href') || '';
              sellerUrl = ph.startsWith('http') ? ph : (ph ? 'https://www.ozon.ru' + ph : '');
            }
            break;
          }
        }
      }
    }

    // Extract image URL
    let image = '';
    const img = container.querySelector('img[src*="cdn"]') || container.querySelector('img');
    if (img) image = img.src || img.getAttribute('srcset')?.split(' ')[0] || '';

    // Extract rating
    let rating = '';
    const ratingMatch = container.textContent.match(/(\d[.,]\d)\s*(?:★|звезд)/i);
    if (ratingMatch) rating = ratingMatch[1];

    // Extract reviews count
    let reviews = '';
    const reviewMatch = container.textContent.match(/(\d+)\s*отзыв/i);
    if (reviewMatch) reviews = reviewMatch[1];

    return {
      sku,
      name: name || `Товар ${sku}`,
      price,
      seller,
      sellerUrl,
      url: fullUrl,
      image,
      rating,
      reviews
    };
  }

  // ── Apply whitelist filtering ──
  function applyWhitelist(competitors) {
    if (!config.duplicateWhitelist || config.duplicateWhitelist.length === 0) return competitors;

    return competitors.filter(item => {
      for (const entry of config.duplicateWhitelist) {
        const val = (entry.value || '').toLowerCase();
        if (!val) continue;

        switch (entry.type) {
          case 'sku':
            if (item.sku === val) return false;
            break;
          case 'seller':
            if (item.seller.toLowerCase().includes(val) || val.includes(item.seller.toLowerCase())) return false;
            break;
          case 'inn':
            // INN matching would require additional data from seller page
            break;
        }
      }
      return true;
    });
  }

  // ── Click simulation ──
  function simulateClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    try { el.click(); } catch (e) { /* ignore */ }
  }

  // ── Floating panel ──
  function showPanel() {
    if (panelEl) { panelEl.style.display = 'block'; return; }

    panelEl = document.createElement('div');
    panelEl.id = 'obg-dup-panel';
    panelEl.innerHTML = `
      <div class="obg-dup-header" id="obg-dup-drag">
        <span>🔍 Brand Guard — Поиск дубликатов</span>
        <div class="obg-dup-header-btns">
          <button id="obg-dup-min" title="Свернуть">−</button>
          <button id="obg-dup-close" title="Закрыть">×</button>
        </div>
      </div>
      <div class="obg-dup-body" id="obg-dup-body">
        <div class="obg-dup-status" id="obg-dup-status">Инициализация...</div>
        <div class="obg-dup-log" id="obg-dup-log"></div>
      </div>
    `;

    // Styles
    const style = document.createElement('style');
    style.textContent = `
      #obg-dup-panel {
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        width: 360px; background: #1a1a2e; color: #e0e0e0;
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; overflow: hidden;
      }
      .obg-dup-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: #005bff; color: #fff;
        cursor: grab; user-select: none; font-weight: 600; font-size: 12px;
      }
      .obg-dup-header-btns { display: flex; gap: 6px; }
      .obg-dup-header-btns button {
        background: rgba(255,255,255,0.2); border: none; color: #fff;
        width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
        font-size: 14px; display: flex; align-items: center; justify-content: center;
      }
      .obg-dup-header-btns button:hover { background: rgba(255,255,255,0.4); }
      .obg-dup-body { padding: 10px 14px; max-height: 250px; overflow-y: auto; }
      .obg-dup-status { padding: 6px 0; font-weight: 500; color: #80cbc4; }
      .obg-dup-log { font-family: monospace; font-size: 11px; line-height: 1.5; }
      .obg-dup-log div { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,0.05); word-break: break-all; }
      .obg-dup-log .ok { color: #00e676; }
      .obg-dup-log .err { color: #ff5252; }
      .obg-dup-log .warn { color: #ffab40; }
      .obg-dup-log .diag { color: #80cbc4; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panelEl);

    // Minimize
    document.getElementById('obg-dup-min').addEventListener('click', () => {
      const body = document.getElementById('obg-dup-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    // Close
    document.getElementById('obg-dup-close').addEventListener('click', () => {
      panelEl.style.display = 'none';
    });

    // Drag
    let isDragging = false, offsetX = 0, offsetY = 0;
    const dragHandle = document.getElementById('obg-dup-drag');
    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - panelEl.getBoundingClientRect().left;
      offsetY = e.clientY - panelEl.getBoundingClientRect().top;
      dragHandle.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panelEl.style.left = (e.clientX - offsetX) + 'px';
      panelEl.style.top = (e.clientY - offsetY) + 'px';
      panelEl.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      isDragging = false;
      dragHandle.style.cursor = 'grab';
    });
  }

  function updatePanelStatus(text) {
    const el = document.getElementById('obg-dup-status');
    if (el) el.textContent = text;
  }

  function updatePanelLog() {
    const el = document.getElementById('obg-dup-log');
    if (!el) return;
    el.innerHTML = '';
    logLines.slice(-30).forEach(line => {
      const div = document.createElement('div');
      if (line.includes('✓') || line.includes('✅')) div.className = 'ok';
      else if (line.includes('❌') || line.includes('Ошибка')) div.className = 'err';
      else if (line.includes('⚠') || line.includes('⏹')) div.className = 'warn';
      else if (line.includes('[DIAG]')) div.className = 'diag';
      div.textContent = line;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  // ── Utilities ──
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('📋 Content script для поиска дубликатов загружен');
})();
