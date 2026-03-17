// OZON Brand Guard — Duplicate Detection Content Script v5.1.0
// Работает на www.ozon.ru/product/* страницах
// Гибридный подход: seller-ссылки (Другие продавцы) + product-ссылки (Похожие предложения)
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
                         document.querySelector('[data-widget="webPrice"]') ||
                         document.querySelector('[data-widget="webSoldOut"]') ||
                         document.querySelector('[data-widget="webOutOfStock"]') ||
                         document.body.innerText.includes('Этот товар закончился');
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

    // Strategy 4: Search "Похожие предложения" for product-link counterfeits
    if (sellers.length === 0) {
      log('[DIAG] Стратегия 4: Поиск в "Похожие предложения" (product-ссылки)...');
      const similar = findAndParseSimilarProducts(mySku, productName, productUrl, productImage);
      for (const item of similar) {
        sellers.push(item);
      }
      log(`[DIAG] Стратегия 4: найдено ${similar.length} похожих товаров`);
    }

    if (sellers.length === 0) {
      log('ℹ Других продавцов/похожих товаров не найдено на этой карточке');
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
    // 1. Standard h1
    const h1 = document.querySelector('[data-widget="webProductHeading"] h1') || document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim().substring(0, 200);

    // 2. og:title meta (works on sold-out pages)
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const content = (ogTitle.getAttribute('content') || '').trim();
      if (content) return content.substring(0, 200);
    }

    // 3. document.title (strip " — купить ...", " | OZON" suffix)
    const title = document.title || '';
    if (title) {
      const cleaned = title
        .replace(/\s*[—\-|].*?(OZON|ozon|озон).*$/i, '')
        .replace(/\s*купить.*$/i, '')
        .trim();
      if (cleaned.length > 3) return cleaned.substring(0, 200);
    }

    // 4. Breadcrumbs — last item is usually the product name
    const crumbs = document.querySelector('[data-widget="breadCrumbs"]');
    if (crumbs) {
      const items = crumbs.querySelectorAll('a, span');
      const last = items[items.length - 1];
      if (last) {
        const text = last.textContent.trim();
        if (text.length > 3 && text.length < 200) return text;
      }
    }

    return '';
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
      // Also check for "Похожие предложения" widgets (sold-out products)
      if (document.querySelector('[data-widget*="Similar"]') ||
          document.querySelector('[data-widget*="similar"]') ||
          document.querySelector('[data-widget="webRecommendationWidget"]')) {
        log('[DIAG] Секция похожих предложений найдена в DOM');
        return;
      }
      // Also check by text content (quick check)
      const allText = document.body.innerText.toLowerCase();
      if (allText.includes('другие продавцы') || allText.includes('есть дешевле') ||
          allText.includes('другие предложения') || allText.includes('похожие предложения') ||
          allText.includes('похожие товары') || allText.includes('аналогичные товары')) {
        log('[DIAG] Текст секции найден');
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
  // ══ STRATEGY 4: Similar products (product-link counterfeits) ══
  // ══ For sold-out pages: "Похожие предложения" section         ══
  // ══════════════════════════════════════════════════════════════

  function findAndParseSimilarProducts(mySku, productName, productUrl, productImage) {
    const results = [];
    const seenSkus = new Set();
    const ownPanel = document.getElementById('obg-dup-panel');

    // Current product SKU from URL — exclude it from results
    const currentProductSku = extractProductSkuFromUrl(productUrl);
    if (currentProductSku) seenSkus.add(currentProductSku);

    // Find the "Похожие предложения" / similar section
    const section = findSimilarSection();
    let productLinks;
    let isCuratedSection = false;

    if (section) {
      isCuratedSection = true;
      const widgetName = (section.getAttribute('data-widget') || '').trim();
      log(`[DIAG] Найдена секция: "${widgetName || 'по заголовку'}"`);
      productLinks = section.querySelectorAll('a[href*="/product/"]');
    } else {
      log('[DIAG] Секция не найдена, fallback — все product-ссылки на странице');
      productLinks = getAllProductLinksOutsideExcluded();
    }

    log(`[DIAG] Product-ссылок: ${productLinks.length}`);

    for (const link of productLinks) {
      if (ownPanel && ownPanel.contains(link)) continue;

      const href = link.getAttribute('href') || '';
      const sku = extractProductSkuFromUrl(href);
      if (!sku || seenSkus.has(sku)) continue;
      seenSkus.add(sku);

      const card = findProductCard(link);
      if (!card) continue;

      const itemName = extractProductName(card, link);
      const price = extractPrice(card);
      const seller = extractSellerFromCard(card);
      const image = extractImageFromCard(card);
      const fullUrl = href.startsWith('http') ? href : 'https://www.ozon.ru' + href.split('?')[0];

      results.push({
        sku: sku,
        name: itemName || productName,
        price: price,
        seller: seller,
        sellerUrl: '',
        url: fullUrl,
        image: image || productImage,
        rating: '',
        reviews: ''
      });
    }

    // Для курированной секции OZON ("Похожие предложения") — доверяем выдаче,
    // НЕ фильтруем по названию. Подделки часто имеют совершенно другие названия,
    // но копируют состав/описание — что невозможно проверить без перехода на страницу.
    // OZON сам подобрал эти товары как "похожие" — берём все.
    if (isCuratedSection) {
      log(`[DIAG] Секция OZON — берём все ${results.length} товаров (доверяем курации)`);
    }

    // Логируем первые 5
    for (const r of results.slice(0, 5)) {
      log(`[DIAG] 📎 "${(r.name || '').substring(0, 55)}" — ${r.price || '?'}₽`);
    }
    if (results.length > 5) {
      log(`[DIAG] ... и ещё ${results.length - 5}`);
    }

    return results;
  }

  /** Get all product links outside excluded areas (for fallback) */
  function getAllProductLinksOutsideExcluded() {
    const excludeSelectors = ['header', 'footer', 'nav', '[data-widget="breadCrumbs"]',
                              '[data-widget="webProductHeading"]'];
    const excludeEls = new Set();
    for (const sel of excludeSelectors) {
      document.querySelectorAll(sel).forEach(el => excludeEls.add(el));
    }
    const ownPanel = document.getElementById('obg-dup-panel');
    if (ownPanel) excludeEls.add(ownPanel);

    const all = document.querySelectorAll('a[href*="/product/"]');
    return [...all].filter(link => {
      for (const ex of excludeEls) {
        if (ex.contains(link)) return false;
      }
      return true;
    });
  }

  function findSimilarSection() {
    const ownPanel = document.getElementById('obg-dup-panel');

    // Method 1: Widget selectors for similar/recommendation sections
    const widgetSelectors = [
      '[data-widget="webSimilarOffer"]',
      '[data-widget*="Similar"]',
      '[data-widget*="similar"]',
      '[data-widget="webRecommendationWidget"]',
      '[data-widget*="Recommendation"]',
      '[data-widget*="recommendation"]',
      '[data-widget*="Analog"]',
      '[data-widget*="analog"]'
    ];

    for (const sel of widgetSelectors) {
      const el = document.querySelector(sel);
      if (el && !isOwnOrTooWide(el)) {
        // Must have product links inside
        const pLinks = el.querySelectorAll('a[href*="/product/"]');
        const realLinks = ownPanel ? [...pLinks].filter(l => !ownPanel.contains(l)) : [...pLinks];
        if (realLinks.length > 0) return el;
      }
    }

    // Method 2: Search by heading text for "Похожие предложения" etc.
    const keywords = [
      'похожие предложения', 'похожие товары', 'аналогичные товары',
      'похожие', 'рекомендуем также', 'вам может понравиться',
      'аналоги', 'с этим товаром покупают'
    ];

    const allHeadings = document.querySelectorAll('h1, h2, h3, h4, span, div');
    for (const heading of allHeadings) {
      if (ownPanel && ownPanel.contains(heading)) continue;
      if (heading.children.length > 5) continue;
      const text = heading.textContent.toLowerCase().trim();
      if (text.length > 80) continue;

      for (const kw of keywords) {
        if (text.includes(kw)) {
          // Walk up to find container with product links
          let container = heading.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!container || isOwnOrTooWide(container)) break;
            const pLinks = container.querySelectorAll('a[href*="/product/"]');
            const realLinks = ownPanel ? [...pLinks].filter(l => !ownPanel.contains(l)) : [...pLinks];
            if (realLinks.length >= 2) {
              return container;
            }
            container = container.parentElement;
          }
          break;
        }
      }
    }

    return null;
  }

  function extractProductSkuFromUrl(url) {
    if (!url) return null;
    // /product/some-name-123456789/ → "123456789"
    const match = url.match(/\/product\/[^/]*?-(\d{5,15})\/?/);
    if (match) return match[1];
    // /product/123456789/ (just ID)
    const match2 = url.match(/\/product\/(\d{5,15})\/?/);
    return match2 ? match2[1] : null;
  }

  function findProductCard(link) {
    let el = link;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el || isOwnOrTooWide(el)) return null;
      // Card usually has an image + price + product link
      const hasImg = el.querySelector('img');
      const hasPrice = el.textContent.match(/\d[\d\s]*₽/);
      if (hasImg && hasPrice) return el;
    }
    // Fallback: just the parent container
    return link.parentElement?.parentElement || link.parentElement;
  }

  function extractProductName(card, link) {
    // Try link text first (often the product name)
    const linkText = link.textContent.trim();
    if (linkText.length > 5 && linkText.length < 300) return linkText;
    // Try finding a title-like element inside the card
    const title = card.querySelector('[class*="title"]') || card.querySelector('[class*="name"]');
    if (title) {
      const t = title.textContent.trim();
      if (t.length > 5 && t.length < 300) return t;
    }
    return '';
  }

  function extractSellerFromCard(card) {
    // Look for seller link or text inside a product card
    const sellerLink = card.querySelector('a[href*="/seller/"]');
    if (sellerLink) return sellerLink.textContent.trim();
    // Look for text hints
    const spans = card.querySelectorAll('span, div');
    for (const span of spans) {
      if (span.children.length > 2) continue;
      const text = span.textContent.trim();
      if (text.length > 2 && text.length < 60) {
        if (text.includes('Продавец') || text.includes('продавец')) {
          return text.replace(/продавец[:\s]*/i, '').trim();
        }
      }
    }
    return '';
  }

  function extractImageFromCard(card) {
    const img = card.querySelector('img');
    return img ? (img.src || '') : '';
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

  log('📋 Content script v5.1 — гибридный поиск (продавцы + похожие товары) загружен');
})();
