// OZON Brand Guard — Batch Products SKU Collector v3.2.0
// Работает на seller.ozon.ru/app/products*
// Парсит таблицу товаров продавца и извлекает SKU для пакетного поиска дубликатов
// Фильтрует по статусу: пропускает «Не продается» (убранные из продажи)
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

  /* ────── Определение колонки статуса по заголовкам ────── */

  function getStatusColumnIndex() {
    const headers = document.querySelectorAll('table thead th');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].getAttribute('data-cell-name') === 'th-status') return i;
    }
    return -1;
  }

  /** Проверяет статус строки. Возвращает true если товар НЕ убран из продажи */
  function isRowActive(row, statusIdx) {
    if (statusIdx < 0) return true; // не нашли колонку — берём все
    const tds = row.querySelectorAll('td');
    if (statusIdx >= tds.length) return true;
    const text = tds[statusIdx].textContent.trim().toLowerCase();
    // «Не продается», «Не продаётся», «Убран из продажи», «Заблокирован»
    if (/не продаётся|не продается|убран из продажи|заблокирован/i.test(text)) return false;
    return true;
  }

  /* ────── Основной цикл сбора ────── */

  async function collectAllSkus() {
    isCollecting = true;
    log('Начинаю сбор SKU из таблицы товаров...');
    const allSkus = [];
    let totalSkipped = 0;
    let page = 1;

    try {
      while (true) {
        await waitForTableStable();
        const { skus, skipped } = parseCurrentPageSkus();
        totalSkipped += skipped;
        log(`Страница ${page}: ${skus.length} SKU собрано` + (skipped > 0 ? `, ${skipped} пропущено (не продаётся)` : ''));
        if (skus.length > 0) {
          log(`   SKU: ${skus.slice(0, 5).join(', ')}${skus.length > 5 ? '...' : ''}`);
        }
        allSkus.push(...skus);

        const hasNext = await goToNextPage();
        if (!hasNext) {
          log(`Последняя страница (${page}), пагинация завершена`);
          break;
        }
        page++;
      }

      const uniqueSkus = [...new Set(allSkus)];
      log(`Итого: ${uniqueSkus.length} SKU из ${page} стр.` + (totalSkipped > 0 ? `, пропущено ${totalSkipped} (не продаётся)` : ''));
      log('Отправляю SKU на обработку...');
      safeSend({ action: 'batchSkusCollected', skus: uniqueSkus });
    } catch (e) {
      log(`Ошибка сбора SKU: ${e.message}`);
      safeSend({ action: 'batchSkusCollected', skus: [...new Set(allSkus)] });
    } finally {
      isCollecting = false;
    }
  }

  /* ────── Парсинг строк таблицы с фильтрацией по статусу ────── */

  function parseCurrentPageSkus() {
    const skus = [];
    let skipped = 0;
    const statusIdx = getStatusColumnIndex();
    const rows = document.querySelectorAll('table tbody tr');

    for (const row of rows) {
      // Фильтр: пропускаем «Не продается» / «Убран из продажи»
      if (!isRowActive(row, statusIdx)) {
        skipped++;
        continue;
      }

      const sku = extractSkuFromRow(row);
      if (sku) skus.push(sku);
    }

    return { skus, skipped };
  }

  /** Извлекает SKU из одной строки таблицы (3 стратегии) */
  function extractSkuFromRow(row) {
    // Strategy 1: data-widget SKU span
    const skuSpan = row.querySelector('[data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
    if (skuSpan) {
      const m = skuSpan.textContent.trim().match(/SKU\s+(\d{5,})/);
      if (m) return m[1];
    }
    // Strategy 2: product title link
    const link = row.querySelector('a[data-widget="products-table-row-title-link"]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/\/product\/(\d{5,})/);
      if (m) return m[1];
    }
    // Strategy 3: barcode OZN+SKU
    const barcode = row.querySelector('[data-style="text"]');
    if (barcode) {
      const m = barcode.textContent.trim().match(/OZN(\d{5,})/);
      if (m) return m[1];
    }
    return null;
  }

  /* ────── Ожидание полной загрузки таблицы ────── */

  async function waitForTableStable() {
    let lastCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < 40; i++) {
      const rows = document.querySelectorAll('table tbody tr');
      if (rows.length > 0) {
        if (rows.length === lastCount) {
          stableRounds++;
          if (stableRounds >= 3) return; // кол-во строк не меняется 1.5с — загрузка завершена
        } else {
          stableRounds = 0;
          lastCount = rows.length;
        }
      }
      await sleep(500);
    }
    if (lastCount > 0) {
      log(`Таблица: ${lastCount} строк (ожидание стабилизации истекло, продолжаю)`);
    } else {
      log('Таблица не найдена');
    }
  }

  /* ────── Пагинация с ожиданием обновления данных ────── */

  async function goToNextPage() {
    // Запоминаем текущие SKU для детекции обновления
    const oldFirstSku = getFirstSkuOnPage();

    // Look for pagination buttons
    const paginationBtns = document.querySelectorAll('ul li button, nav button, [data-widget*="pagination"] button');
    let currentFound = false;
    let clicked = false;

    for (const btn of paginationBtns) {
      if (btn.getAttribute('data-selected') === 'true' || btn.getAttribute('aria-current') === 'true') {
        currentFound = true;
        continue;
      }
      if (currentFound && !btn.disabled) {
        const text = btn.textContent.trim();
        if (/^\d+$/.test(text) || text === '→' || text === '›') {
          btn.click();
          clicked = true;
          break;
        }
      }
    }

    // Try "next" arrow button
    if (!clicked) {
      const nextBtns = document.querySelectorAll('button[aria-label*="next"], button[aria-label*="следующ"]');
      for (const btn of nextBtns) {
        if (!btn.disabled) {
          btn.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) return false;

    // Ждём пока таблица обновится (новые данные отличаются от старых)
    await waitForTableUpdate(oldFirstSku);
    return true;
  }

  /** Возвращает SKU первой строки для детекции смены страницы */
  function getFirstSkuOnPage() {
    const span = document.querySelector('table tbody tr [data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
    if (span) {
      const m = span.textContent.trim().match(/SKU\s+(\d{5,})/);
      if (m) return m[1];
    }
    return null;
  }

  /** Ждём пока первый SKU на странице изменится (макс 10с) */
  async function waitForTableUpdate(oldFirstSku) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const newFirst = getFirstSkuOnPage();
      // Таблица обновилась если: первый SKU изменился, или таблица пуста (загружается)
      if (newFirst && newFirst !== oldFirstSku) return;
      if (!newFirst && i > 2) continue; // таблица временно пуста — ждём
    }
    // Таймаут — возможно мы на последней странице или данные не обновились
    log('Ожидание обновления таблицы истекло (10с)');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('Batch products collector загружен');
})();
