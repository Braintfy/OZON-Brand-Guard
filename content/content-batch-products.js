// OZON Brand Guard — Batch Products SKU Collector v3.4.0
// Работает на seller.ozon.ru/app/products*
// Парсит таблицу товаров продавца и извлекает SKU для пакетного поиска дубликатов
// Фильтрует по статусу: пропускает «Не продается» (убранные из продажи)
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  // Двойная защита: DOM-guard + window-flag
  if (window.__obgBatchLoaded) return;
  window.__obgBatchLoaded = true;
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
          if (stableRounds >= 5) return; // кол-во строк не меняется 2.5с — загрузка завершена
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

  /**
   * Находит контейнер пагинации — ищем элемент ПОД таблицей,
   * чтобы не путать с табами «Все / В продаже / ...» над таблицей.
   */
  function findPaginationContainer() {
    const table = document.querySelector('table');
    if (!table) return null;
    const tableRect = table.getBoundingClientRect();

    // Ищем все контейнеры с кнопками-цифрами ниже таблицы
    const candidates = document.querySelectorAll('ul, nav, div[class*="pagination"], div[class*="Pagination"], div[class*="pager"]');
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      // Контейнер должен быть ниже таблицы (или на уровне её нижнего края)
      if (rect.top < tableRect.bottom - 20) continue;
      // Должен содержать хотя бы 2 кнопки с цифрами
      const numBtns = [...el.querySelectorAll('button, a')].filter(b => /^\d+$/.test(b.textContent.trim()));
      if (numBtns.length >= 2) return el;
    }

    // Фоллбэк: ищем любой элемент с кнопками-цифрами ниже таблицы
    const allButtons = [...document.querySelectorAll('button, a')];
    const numberedBtns = allButtons.filter(b => {
      const t = b.textContent.trim();
      if (!/^\d+$/.test(t)) return false;
      const rect = b.getBoundingClientRect();
      return rect.top > tableRect.bottom - 20;
    });
    if (numberedBtns.length >= 2) {
      return numberedBtns[0].closest('ul') || numberedBtns[0].closest('nav') || numberedBtns[0].parentElement;
    }

    return null;
  }

  /**
   * Определяет текущую активную страницу среди кнопок-цифр.
   * Использует несколько стратегий: атрибуты, CSS-классы, computed styles.
   */
  function findCurrentPageButton(container) {
    if (!container) return null;
    const numBtns = [...container.querySelectorAll('button, a')].filter(b => /^\d+$/.test(b.textContent.trim()));
    if (numBtns.length === 0) return null;

    // Стратегия 1: data-selected, aria-current, aria-pressed
    for (const btn of numBtns) {
      if (btn.getAttribute('data-selected') === 'true') return btn;
      if (btn.getAttribute('aria-current') === 'true' || btn.getAttribute('aria-current') === 'page') return btn;
      if (btn.getAttribute('aria-pressed') === 'true') return btn;
    }

    // Стратегия 2: CSS-классы с active/selected/current
    for (const btn of numBtns) {
      const cls = btn.className || '';
      if (/active|selected|current/i.test(cls) && !/inactive|unselected/i.test(cls)) return btn;
    }

    // Стратегия 3: computed styles — fontWeight bold или другой background
    const styles = numBtns.map(btn => ({
      btn,
      weight: parseInt(getComputedStyle(btn).fontWeight) || 400,
      bg: getComputedStyle(btn).backgroundColor,
      color: getComputedStyle(btn).color
    }));

    // Ищем кнопку с жирным шрифтом (700+), если остальные обычные
    const boldBtns = styles.filter(s => s.weight >= 600);
    const normalBtns = styles.filter(s => s.weight < 600);
    if (boldBtns.length === 1 && normalBtns.length > 0) return boldBtns[0].btn;

    // Ищем кнопку с уникальным background-color
    const bgCounts = {};
    styles.forEach(s => { bgCounts[s.bg] = (bgCounts[s.bg] || 0) + 1; });
    const uniqueBg = styles.filter(s => bgCounts[s.bg] === 1 && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent');
    if (uniqueBg.length === 1) return uniqueBg[0].btn;

    // Стратегия 4: disabled кнопка = текущая страница (некоторые UI-библиотеки)
    for (const btn of numBtns) {
      if (btn.disabled || btn.getAttribute('disabled') !== null) return btn;
    }

    // Фоллбэк: считаем что первая кнопка = текущая (для первой загрузки)
    log('⚠ Не удалось определить активную страницу, пробую первую кнопку');
    return numBtns[0];
  }

  async function goToNextPage() {
    const oldFirstSku = getFirstSkuOnPage();
    const container = findPaginationContainer();

    if (!container) {
      log('Пагинация не найдена — возможно все товары на одной странице');
      return false;
    }

    const numBtns = [...container.querySelectorAll('button, a')].filter(b => /^\d+$/.test(b.textContent.trim()));
    const currentBtn = findCurrentPageButton(container);
    const currentPage = currentBtn ? parseInt(currentBtn.textContent.trim()) : 0;

    log(`Пагинация: ${numBtns.length} кнопок, текущая стр. ${currentPage}`);

    let clicked = false;

    // Стратегия A: Кнопка с номером currentPage + 1
    if (currentPage > 0) {
      const nextPageNum = currentPage + 1;
      const nextBtn = numBtns.find(b => parseInt(b.textContent.trim()) === nextPageNum);
      if (nextBtn && !nextBtn.disabled) {
        log(`Клик по кнопке страницы ${nextPageNum}`);
        nextBtn.click();
        clicked = true;
      }
    }

    // Стратегия B: Кнопка-стрелка «→» / «›» / SVG arrow / aria-label next
    if (!clicked) {
      const allBtns = [...container.querySelectorAll('button, a')];
      for (const btn of allBtns) {
        if (btn.disabled) continue;
        const text = btn.textContent.trim();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();

        // Текстовые стрелки
        if (['→', '›', '»', '>', 'next', 'далее'].includes(text.toLowerCase()) || /next|следующ|вперед|вперёд/i.test(label)) {
          btn.click();
          clicked = true;
          log('Клик по кнопке-стрелке «вперёд»');
          break;
        }

        // SVG-стрелка (кнопка без текста, содержит SVG)
        if (!text && btn.querySelector('svg') && !label.includes('prev') && !label.includes('назад')) {
          // Определяем направление: правая стрелка обычно ПОСЛЕ последней цифры
          const btnRect = btn.getBoundingClientRect();
          const lastNum = numBtns[numBtns.length - 1];
          if (lastNum && btnRect.left > lastNum.getBoundingClientRect().left) {
            btn.click();
            clicked = true;
            log('Клик по SVG-стрелке вперёд');
            break;
          }
        }
      }
    }

    // Стратегия C: Следующая кнопка-цифра после текущей в DOM-порядке
    if (!clicked && currentBtn) {
      const currentIdx = numBtns.indexOf(currentBtn);
      if (currentIdx >= 0 && currentIdx < numBtns.length - 1) {
        const nextBtn = numBtns[currentIdx + 1];
        if (!nextBtn.disabled) {
          log(`Клик по следующей кнопке: страница ${nextBtn.textContent.trim()}`);
          nextBtn.click();
          clicked = true;
        }
      }
    }

    if (!clicked) return false;

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
