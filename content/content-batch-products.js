// OZON Brand Guard — Batch Products SKU Collector v3.1.0
// Работает на seller.ozon.ru/app/products*
// Парсит таблицу товаров продавца и извлекает SKU для пакетного поиска дубликатов
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  if (document.getElementById('__obg-batch-guard')) return;
  const guard = document.createElement('div');
  guard.id = '__obg-batch-guard';
  guard.style.display = 'none';
  document.body.appendChild(guard);

  let isCollecting = false;

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg, () => { if (chrome.runtime.lastError) { /* ignore */ } }); }
    catch (e) { /* */ }
  }

  function log(text) {
    console.log('[OBG-Batch]', text);
    safeSend({ action: 'techLog', text: `[Пакетный] ${text}` });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'collectProductSkus') {
      if (isCollecting) {
        log('⚠ Сбор уже запущен, пропускаю повторный вызов');
        return;
      }
      collectAllSkus();
    }
  });

  async function collectAllSkus() {
    isCollecting = true;
    log('🔍 Начинаю сбор SKU из таблицы товаров...');
    const allSkus = [];
    let page = 1;

    try {
      while (true) {
        await waitForTable();
        const skus = parseCurrentPageSkus();
        log(`📄 Страница ${page}: найдено ${skus.length} SKU`);
        if (skus.length > 0) {
          log(`   SKU: ${skus.slice(0, 5).join(', ')}${skus.length > 5 ? '...' : ''}`);
        }
        allSkus.push(...skus);

        const hasNext = await goToNextPage();
        if (!hasNext) {
          log(`📄 Последняя страница (${page}), пагинация завершена`);
          break;
        }
        page++;
        await sleep(2000);
      }

      const uniqueSkus = [...new Set(allSkus)];
      log(`✅ Всего собрано ${uniqueSkus.length} уникальных SKU из ${page} страниц`);
      log(`🚀 Отправляю SKU на обработку...`);
      safeSend({ action: 'batchSkusCollected', skus: uniqueSkus });
    } catch (e) {
      log(`❌ Ошибка сбора SKU: ${e.message}`);
      safeSend({ action: 'batchSkusCollected', skus: [...new Set(allSkus)] });
    } finally {
      isCollecting = false;
    }
  }

  function parseCurrentPageSkus() {
    const skus = [];
    // Strategy 1: data-widget SKU spans — most reliable
    const skuSpans = document.querySelectorAll('[data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
    for (const span of skuSpans) {
      const text = span.textContent.trim();
      const match = text.match(/SKU\s+(\d{5,})/);
      if (match) skus.push(match[1]);
    }

    // Strategy 2: product title links with href containing SKU
    if (skus.length === 0) {
      const links = document.querySelectorAll('a[data-widget="products-table-row-title-link"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/product\/(\d{5,})/);
        if (match) skus.push(match[1]);
      }
    }

    // Strategy 3: barcode cells contain OZN+SKU
    if (skus.length === 0) {
      const barcodeCells = document.querySelectorAll('[data-style="text"]');
      for (const cell of barcodeCells) {
        const text = cell.textContent.trim();
        const match = text.match(/OZN(\d{5,})/);
        if (match) skus.push(match[1]);
      }
    }

    return skus;
  }

  async function waitForTable() {
    for (let i = 0; i < 30; i++) {
      const table = document.querySelector('table tbody tr');
      if (table) return;
      await sleep(500);
    }
    log('⚠ Таблица не найдена');
  }

  async function goToNextPage() {
    // Look for pagination buttons
    const paginationBtns = document.querySelectorAll('ul li button, nav button, [data-widget*="pagination"] button');
    let currentFound = false;
    for (const btn of paginationBtns) {
      if (btn.getAttribute('data-selected') === 'true' || btn.getAttribute('aria-current') === 'true') {
        currentFound = true;
        continue;
      }
      if (currentFound && !btn.disabled) {
        const text = btn.textContent.trim();
        if (/^\d+$/.test(text) || text === '→' || text === '›') {
          btn.click();
          await sleep(2000);
          return true;
        }
      }
    }
    // Try "next" arrow button
    const nextBtns = document.querySelectorAll('button[aria-label*="next"], button[aria-label*="следующ"]');
    for (const btn of nextBtns) {
      if (!btn.disabled) {
        btn.click();
        await sleep(2000);
        return true;
      }
    }
    return false;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('📋 Batch products collector загружен');
})();
