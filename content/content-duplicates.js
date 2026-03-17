// OZON Brand Guard — Duplicate Detection Content Script v5.0.0
// Работает на www.ozon.ru/product/* страницах
// Парсит раздел "Другие продавцы" / "Есть дешевле" — находит ПРОДАВЦОВ на вашей карточке товара
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
    log('🔍 Начинаю парсинг страницы товара...');
    showPanel();

    const currentSku = skus[startIndex];
    if (!currentSku) {
      log('❌ SKU не указан');
      safeSend({ action: 'duplicatePageResult', sku: '', competitors: [], error: 'SKU не указан' });
      return;
    }

    log(`📦 Обработка SKU: ${currentSku} (${startIndex + 1}/${skus.length})`);
    updatePanelStatus(`SKU: ${currentSku} (${startIndex + 1}/${skus.length})`);

    await waitForPageLoad();
    if (shouldStop) return;

    const competitors = await collectOtherSellers(currentSku);
    if (shouldStop) return;

    log(`✅ Найдено ${competitors.length} других продавцов для SKU ${currentSku}`);

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
    for (let i = 0; i < 20; i++) {
      if (shouldStop) return;
      const hasProduct = document.querySelector('[data-widget="webProductHeading"]') ||
                         document.querySelector('[data-widget="webSale"]') ||
                         document.querySelector('h1') ||
                         document.querySelector('[data-widget="webPrice"]');
      if (hasProduct) {
        log('✓ Страница загружена');
        await sleep(1500);
        return;
      }
      await sleep(500);
    }
    log('⚠ Таймаут ожидания загрузки, продолжаю...');
  }

  // ══════════════════════════════════════════════════════════════
  // ══ GUARDS                                                   ══
  // ══════════════════════════════════════════════════════════════

  function isOwnOrTooWide(el) {
    if (!el) return true;
    if (el === document.body || el === document.documentElement) return true;
    const ownPanel = document.getElementById('obg-dup-panel');
    if (ownPanel && (ownPanel === el || ownPanel.contains(el) || el.contains(ownPanel))) return true;
    return false;
  }

  function hasSellerLinks(el) {
    if (!el) return false;
    const links = el.querySelectorAll('a[href*="/seller/"]');
    if (links.length === 0) return false;
    const ownPanel = document.getElementById('obg-dup-panel');
    if (!ownPanel) return true;
    for (const link of links) {
      if (!ownPanel.contains(link)) return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════
  // ══ CORE: Collect other sellers from product page            ══
  // ══ Searches for SELLERS (a[href*="/seller/"]) not products  ══
  // ══════════════════════════════════════════════════════════════

  async function collectOtherSellers(mySku) {
    const sellers = [];
    const seenSellers = new Set();

    // Get product page info
    const productUrl = window.location.href;
    const productName = getProductName();
    const productImage = getProductImage();
    log(`[DIAG] Товар: "${productName.substring(0, 60)}"`);

    // Identify main seller to exclude
    const mainSeller = getMainSeller();
    if (mainSeller) {
      seenSellers.add(mainSeller.toLowerCase());
      log(`[DIAG] Основной продавец: "${mainSeller}" (исключаем)`);
    }

    // Wait specifically for sellers section to appear (OZON lazy loads it)
    await waitForSellersSection();
    if (shouldStop) return sellers;

    // Strategy 1: Find "Другие продавцы" / "Есть дешевле" section
    log('[DIAG] Стратегия 1: Поиск секции "Другие продавцы"...');
    const section = findOtherSellersSection();
    if (section) {
      const offers = parseOffersFromSection(section, seenSellers);
      for (const offer of offers) {
        sellers.push(formatSellerResult(offer, mySku, productName, productUrl, productImage));
      }
      log(`[DIAG] Стратегия 1: найдено ${offers.length} продавцов`);
    }

    // Strategy 2: Try expanding the section
    if (sellers.length === 0) {
      log('[DIAG] Стратегия 2: Поиск кнопки "Все предложения"...');
      const expanded = await tryExpandAndParse(seenSellers);
      for (const offer of expanded) {
        sellers.push(formatSellerResult(offer, mySku, productName, productUrl, productImage));
      }
      if (expanded.length > 0) {
        log(`[DIAG] Стратегия 2: найдено ${expanded.length} продавцов`);
      }
    }

    // Strategy 3: Broad seller link search
    if (sellers.length === 0) {
      log('[DIAG] Стратегия 3: Широкий поиск ссылок на продавцов...');
      const broad = fallbackBroadSellerSearch(seenSellers);
      for (const offer of broad) {
        sellers.push(formatSellerResult(offer, mySku, productName, productUrl, productImage));
      }
      log(`[DIAG] Стратегия 3: найдено ${broad.length} продавцов`);
    }

    if (sellers.length === 0) {
      log('ℹ Других продавцов не найдено на этой карточке');
    }

    // Filter own seller by config name
    let filtered = sellers;
    const ownSellerName = config.ownSellerName || '';
    if (ownSellerName) {
      const ownLower = ownSellerName.toLowerCase().trim();
      const before = filtered.length;
      filtered = filtered.filter(c => {
        const sl = (c.seller || '').toLowerCase().trim();
        if (!sl) return true;
        return sl !== ownLower && !sl.includes(ownLower) && !ownLower.includes(sl);
      });
      if (filtered.length < before) {
        log(`[DIAG] Пропущен собственный магазин "${ownSellerName}": ${before - filtered.length}`);
      }
    }

    // Apply whitelist
    const final = applyWhitelist(filtered);
    if (final.length < filtered.length) {
      log(`🟢 Вайтлист: пропущено ${filtered.length - final.length}`);
    }

    return final;
  }

  // ══════════════════════════════════════════════════════════════
  // ══ PAGE INFO HELPERS                                        ══
  // ══════════════════════════════════════════════════════════════

  function getProductName() {
    const h1 = document.querySelector('[data-widget="webProductHeading"] h1') || document.querySelector('h1');
    return h1 ? h1.textContent.trim().substring(0, 200) : '';
  }

  function getProductImage() {
    const img = document.querySelector('[data-widget="webGallery"] img') ||
                document.querySelector('[data-widget="webProductImage"] img') ||
                document.querySelector('img[fetchpriority="high"]');
    return img ? (img.src || '') : '';
  }

  function getMainSeller() {
    // Main seller is typically near the "Buy" button / price area
    // Look for seller link in purchase-related widgets
    const sellerLinks = document.querySelectorAll('a[href*="/seller/"]');
    const ownPanel = document.getElementById('obg-dup-panel');

    for (const link of sellerLinks) {
      if (ownPanel && ownPanel.contains(link)) continue;
      if (link.closest('header') || link.closest('footer') || link.closest('nav')) continue;

      const widget = link.closest('[data-widget]');
      if (widget) {
        const wName = widget.getAttribute('data-widget') || '';
        // Purchase/price widgets typically contain the main seller
        if (wName.includes('Price') || wName.includes('Sale') || wName.includes('Cart') ||
            wName.includes('Buy') || wName.includes('webStickyProducts') ||
            wName === 'webSeller' || wName === 'webCurrentSeller') {
          const name = link.textContent.trim();
          if (name && name.length < 100) return name;
        }
      }
    }

    // Fallback: first seller link on the page that's not in a "Другие продавцы" section
    for (const link of sellerLinks) {
      if (ownPanel && ownPanel.contains(link)) continue;
      if (link.closest('header') || link.closest('footer') || link.closest('nav')) continue;
      const name = link.textContent.trim();
      if (name && name.length > 1 && name.length < 100) return name;
    }

    return '';
  }

  // ══════════════════════════════════════════════════════════════
  // ══ WAIT FOR SELLERS SECTION (lazy load)                     ══
  // ══════════════════════════════════════════════════════════════

  async function waitForSellersSection() {
    log('[DIAG] Ожидание секции продавцов...');
    for (let i = 0; i < 10; i++) {
      if (shouldStop) return;
      // Check if any seller section widget exists
      if (document.querySelector('[data-widget="webOtherSellers"]') ||
          document.querySelector('[data-widget="webSimilarOffer"]') ||
          document.querySelector('[data-widget*="OtherSeller"]') ||
          document.querySelector('[data-widget*="Cheaper"]')) {
        log('[DIAG] Секция продавцов найдена в DOM');
        return;
      }
      // Also check by text content (quick check)
      const allText = document.body.innerText.toLowerCase();
      if (allText.includes('другие продавцы') || allText.includes('есть дешевле') ||
          allText.includes('другие предложения')) {
        log('[DIAG] Текст секции продавцов найден');
        return;
      }
      await sleep(500);
    }
    log('[DIAG] Секция продавцов не появилась (таймаут 5с)');
  }

  // ══════════════════════════════════════════════════════════════
  // ══ SECTION FINDER (seller-focused)                          ══
  // ══════════════════════════════════════════════════════════════

  function findOtherSellersSection() {
    const ownPanel = document.getElementById('obg-dup-panel');

    // Method 1: data-widget selectors (most reliable)
    const widgetSelectors = [
      '[data-widget="webOtherSellers"]',
      '[data-widget="webSimilarOffer"]',
      '[data-widget*="OtherSeller"]',
      '[data-widget*="otherSeller"]',
      '[data-widget*="Cheaper"]',
      '[data-widget*="cheaper"]'
    ];

    for (const sel of widgetSelectors) {
      const el = document.querySelector(sel);
      if (el && !isOwnOrTooWide(el) && hasSellerLinks(el)) {
        log(`[DIAG] Найден виджет: ${el.getAttribute('data-widget')}`);
        return el;
      }
    }

    // Method 2: Search by heading text
    const keywords = [
      'другие продавцы', 'другие предложения', 'предложения других продавцов',
      'есть дешевле', 'ещё продавц', 'еще продавц'
    ];

    const allHeadings = document.querySelectorAll('h1, h2, h3, h4, span, div');
    for (const heading of allHeadings) {
      if (ownPanel && ownPanel.contains(heading)) continue;
      if (heading.children.length > 5) continue;
      const text = heading.textContent.toLowerCase().trim();
      if (text.length > 80) continue;

      for (const kw of keywords) {
        if (text.includes(kw)) {
          let container = heading.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!container || isOwnOrTooWide(container)) break;
            if (hasSellerLinks(container)) {
              log(`[DIAG] Найдена секция по тексту: "${text.substring(0, 50)}"`);
              return container;
            }
            container = container.parentElement;
          }
          break;
        }
      }
    }

    // Method 3: TreeWalker for text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (ownPanel && ownPanel.contains(node)) continue;
      const text = node.textContent.toLowerCase().trim();
      if (text.length > 60) continue;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          let container = node.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!container || isOwnOrTooWide(container)) break;
            if (hasSellerLinks(container)) return container;
            container = container.parentElement;
          }
        }
      }
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════════
  // ══ OFFER PARSERS (seller-focused)                           ══
  // ══════════════════════════════════════════════════════════════

  function parseOffersFromSection(section, seenSellers) {
    const offers = [];
    const ownPanel = document.getElementById('obg-dup-panel');

    // Find all seller links in the section
    const sellerLinks = section.querySelectorAll('a[href*="/seller/"]');
    log(`[DIAG] Ссылок на продавцов в секции: ${sellerLinks.length}`);

    for (const link of sellerLinks) {
      if (ownPanel && ownPanel.contains(link)) continue;

      const sellerName = link.textContent.trim();
      if (!sellerName || sellerName.length > 100) continue;

      const sellerKey = sellerName.toLowerCase();
      if (seenSellers.has(sellerKey)) continue;
      seenSellers.add(sellerKey);

      const href = link.getAttribute('href') || '';
      const sellerUrl = href.startsWith('http') ? href : (href ? 'https://www.ozon.ru' + href : '');
      const sellerId = extractSellerIdFromUrl(href);

      // Walk up to find the offer container (card/row with price)
      const offerContainer = findOfferContainer(link);

      const price = offerContainer ? extractPrice(offerContainer) : '';
      const delivery = offerContainer ? extractDeliveryInfo(offerContainer) : '';

      offers.push({
        seller: sellerName,
        sellerUrl,
        sellerId: sellerId || sellerKey,
        price,
        delivery
      });
    }

    return offers;
  }

  function findOfferContainer(link) {
    let el = link;
    for (let i = 0; i < 8; i++) {
      el = el.parentElement;
      if (!el || isOwnOrTooWide(el)) break;
      const hasPrice = el.textContent.match(/\d[\d\s]*₽/);
      const hasButton = el.querySelector('button');
      if (hasPrice && (hasButton || el.querySelectorAll('a[href*="/seller/"]').length <= 2)) {
        return el;
      }
    }
    return link.parentElement?.parentElement || link.parentElement;
  }

  function extractPrice(container) {
    const text = container.textContent;
    const prices = [];
    const priceRegex = /(\d[\d\s]*)\s*₽/g;
    let match;
    while ((match = priceRegex.exec(text)) !== null) {
      const num = parseInt(match[1].replace(/\s/g, ''), 10);
      if (num > 0 && num < 10000000) prices.push(num);
    }
    return prices.length > 0 ? String(prices[0]) : '';
  }

  function extractDeliveryInfo(container) {
    const text = container.textContent;
    const deliveryMatch = text.match(/(доставит[^\n,]{0,30})|(послезавтра|завтра|сегодня)/i);
    return deliveryMatch ? deliveryMatch[0].trim() : '';
  }

  function extractSellerIdFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/seller\/(?:.*?[-/])?(\d+)\/?/);
    return match ? match[1] : null;
  }

  // ══════════════════════════════════════════════════════════════
  // ══ STRATEGY 2: Expand + re-parse                            ══
  // ══════════════════════════════════════════════════════════════

  async function tryExpandAndParse(seenSellers) {
    const keywords = [
      'все предложения', 'показать все', 'все продавцы',
      'смотреть все', 'ещё продавц', 'еще продавц'
    ];
    const countPattern = /ещ[её]\s+\d+\s+продавц/;

    const allLinks = document.querySelectorAll('a, button, span[role="button"], div[role="button"]');
    let expandBtn = null;
    for (const el of allLinks) {
      const text = el.textContent.toLowerCase().trim();
      if (text.length > 60) continue;
      if (countPattern.test(text)) { expandBtn = el; break; }
      for (const kw of keywords) {
        if (text.includes(kw)) { expandBtn = el; break; }
      }
      if (expandBtn) break;
    }

    if (!expandBtn) return [];

    log('→ Нажимаю "Все предложения"...');
    simulateClick(expandBtn);
    await sleep(2500);

    const section = findOtherSellersSection();
    if (section) {
      return parseOffersFromSection(section, seenSellers);
    }
    return [];
  }

  // ══════════════════════════════════════════════════════════════
  // ══ STRATEGY 3: Broad seller link search                     ══
  // ══════════════════════════════════════════════════════════════

  function fallbackBroadSellerSearch(seenSellers) {
    const offers = [];
    const excludeSelectors = ['header', 'footer', 'nav', '[data-widget="breadCrumbs"]'];
    const excludeEls = new Set();
    for (const sel of excludeSelectors) {
      document.querySelectorAll(sel).forEach(el => excludeEls.add(el));
    }
    const ownPanel = document.getElementById('obg-dup-panel');
    if (ownPanel) excludeEls.add(ownPanel);

    const sellerLinks = document.querySelectorAll('a[href*="/seller/"]');
    for (const link of sellerLinks) {
      let isExcluded = false;
      for (const ex of excludeEls) {
        if (ex.contains(link)) { isExcluded = true; break; }
      }
      if (isExcluded) continue;

      const sellerName = link.textContent.trim();
      if (!sellerName || sellerName.length > 100) continue;

      const sellerKey = sellerName.toLowerCase();
      if (seenSellers.has(sellerKey)) continue;
      seenSellers.add(sellerKey);

      const href = link.getAttribute('href') || '';
      const sellerUrl = href.startsWith('http') ? href : (href ? 'https://www.ozon.ru' + href : '');
      const sellerId = extractSellerIdFromUrl(href);
      const offerContainer = findOfferContainer(link);
      const price = offerContainer ? extractPrice(offerContainer) : '';

      offers.push({
        seller: sellerName,
        sellerUrl,
        sellerId: sellerId || sellerKey,
        price,
        delivery: ''
      });
    }

    return offers;
  }

  // ══════════════════════════════════════════════════════════════
  // ══ FORMAT RESULT                                            ══
  // ══════════════════════════════════════════════════════════════

  function formatSellerResult(offer, mySku, productName, productUrl, productImage) {
    return {
      sku: offer.sellerId || offer.seller,
      name: productName,
      price: offer.price,
      seller: offer.seller,
      sellerUrl: offer.sellerUrl,
      url: productUrl,
      image: productImage,
      rating: '',
      reviews: '',
      delivery: offer.delivery || ''
    };
  }

  // ══════════════════════════════════════════════════════════════
  // ══ WHITELIST FILTER                                         ══
  // ══════════════════════════════════════════════════════════════

  function applyWhitelist(competitors) {
    if (!config.duplicateWhitelist || config.duplicateWhitelist.length === 0) return competitors;

    return competitors.filter(item => {
      for (const entry of config.duplicateWhitelist) {
        const val = (entry.value || '').toLowerCase().trim();
        if (!val) continue;

        switch (entry.type) {
          case 'sku':
            if (item.sku === val) return false;
            break;
          case 'seller': {
            const sellerLower = (item.seller || '').toLowerCase().trim();
            if (!sellerLower) break;
            if (sellerLower.includes(val) || val.includes(sellerLower)) return false;
            break;
          }
          case 'inn':
            break;
        }
      }
      return true;
    });
  }

  // ══════════════════════════════════════════════════════════════
  // ══ CLICK SIMULATION                                         ══
  // ══════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════
  // ══ FLOATING PANEL                                           ══
  // ══════════════════════════════════════════════════════════════

  function showPanel() {
    if (panelEl) { panelEl.style.display = 'block'; return; }

    panelEl = document.createElement('div');
    panelEl.id = 'obg-dup-panel';
    panelEl.innerHTML = `
      <div class="obg-dup-header" id="obg-dup-drag">
        <span>🔍 Brand Guard — Сканирование</span>
        <div class="obg-dup-header-btns">
          <button id="obg-dup-pause" title="Пауза">⏸</button>
          <button id="obg-dup-stop" title="Остановить">⏹</button>
          <button id="obg-dup-min" title="Свернуть">−</button>
          <button id="obg-dup-close" title="Закрыть">×</button>
        </div>
      </div>
      <div class="obg-dup-body" id="obg-dup-body">
        <div class="obg-dup-status" id="obg-dup-status">Инициализация...</div>
        <div class="obg-dup-log" id="obg-dup-log"></div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #obg-dup-panel {
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        width: 460px; max-width: calc(100vw - 40px);
        background: #1a1a2e; color: #e0e0e0;
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; overflow: hidden;
        resize: both; min-width: 320px; min-height: 120px;
      }
      .obg-dup-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: #005bff; color: #fff;
        cursor: grab; user-select: none; font-weight: 600; font-size: 12px;
      }
      .obg-dup-header-btns { display: flex; gap: 6px; flex-shrink: 0; }
      .obg-dup-header-btns button {
        background: rgba(255,255,255,0.2); border: none; color: #fff;
        width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
        font-size: 14px; display: flex; align-items: center; justify-content: center;
      }
      .obg-dup-header-btns button:hover { background: rgba(255,255,255,0.4); }
      #obg-dup-pause.obg-paused { background: #ffab40; color: #000; }
      .obg-dup-body {
        padding: 10px 14px;
        max-height: 350px; overflow-y: auto;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent;
      }
      .obg-dup-body::-webkit-scrollbar { width: 6px; }
      .obg-dup-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
      .obg-dup-status { padding: 6px 0; font-weight: 500; color: #80cbc4; word-wrap: break-word; }
      .obg-dup-log { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 11px; line-height: 1.6; }
      .obg-dup-log div {
        padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        word-wrap: break-word; overflow-wrap: break-word;
      }
      .obg-dup-log .ok { color: #00e676; }
      .obg-dup-log .err { color: #ff5252; }
      .obg-dup-log .warn { color: #ffab40; }
      .obg-dup-log .diag { color: #80cbc4; }
      .obg-dup-log .seller { color: #ff8a80; font-weight: 500; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panelEl);

    document.getElementById('obg-dup-min').addEventListener('click', () => {
      const body = document.getElementById('obg-dup-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('obg-dup-close').addEventListener('click', () => {
      panelEl.style.display = 'none';
    });

    let panelPaused = false;
    document.getElementById('obg-dup-pause').addEventListener('click', () => {
      panelPaused = !panelPaused;
      const btn = document.getElementById('obg-dup-pause');
      if (panelPaused) {
        btn.textContent = '▶';
        btn.title = 'Продолжить';
        btn.classList.add('obg-paused');
        safeSend({ action: 'pauseDuplicates' });
        log('⏸ Пауза запрошена');
      } else {
        btn.textContent = '⏸';
        btn.title = 'Пауза';
        btn.classList.remove('obg-paused');
        safeSend({ action: 'resumeDuplicates' });
        log('▶ Возобновление...');
      }
    });

    document.getElementById('obg-dup-stop').addEventListener('click', () => {
      safeSend({ action: 'stopDuplicates' });
      shouldStop = true;
      log('⏹ Остановлено из панели');
    });

    let isDragging = false, offsetX = 0, offsetY = 0;
    const dragHandle = document.getElementById('obg-dup-drag');
    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
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
    logLines.slice(-40).forEach(line => {
      const div = document.createElement('div');
      if (line.includes('✓') || line.includes('✅')) div.className = 'ok';
      else if (line.includes('❌') || line.includes('Ошибка')) div.className = 'err';
      else if (line.includes('⚠') || line.includes('⏹')) div.className = 'warn';
      else if (line.includes('[DIAG]')) div.className = 'diag';
      else if (line.includes('продавц') || line.includes('Продавец') || line.includes('seller')) div.className = 'seller';
      div.textContent = line;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  // ── Utilities ──
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('📋 Content script v5.0 — поиск других продавцов загружен');
})();
