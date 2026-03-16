// OZON Brand Guard — Batch Products SKU Collector v3.5.0
// Работает на seller.ozon.ru/app/products*
// Парсит таблицу товаров продавца и извлекает SKU для пакетного поиска дубликатов
// Поддерживает виртуальный скроллинг: прокручивает таблицу для сбора всех строк
// Фильтрует по статусу: пропускает «Не продается» (убранные из продажи)
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  // Тройная защита от двойной инъекции
  if (window.__obgBatchLoaded) {
    // Если SPA-навигация удалила guard но флаг остался — скрипт ещё живой
    if (document.getElementById('__obg-batch-guard')) return;
    // Guard удалён — SPA перешёл на другую страницу и вернулся, нужна переинъекция
  }
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
      isCollecting = true; // Ставим флаг СРАЗУ, до async вызова
      collectAllSkus();
    }
  });

  /* ────── Определение колонки статуса по заголовкам ────── */

  function getStatusColumnIndex() {
    const headers = document.querySelectorAll('table thead th');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].getAttribute('data-cell-name') === 'th-status') return i;
    }
    // Фоллбэк: ищем заголовок с текстом "Статус"
    for (let i = 0; i < headers.length; i++) {
      if (/статус/i.test(headers[i].textContent.trim())) return i;
    }
    return -1;
  }

  /** Проверяет статус строки. Возвращает true если товар НЕ убран из продажи */
  function isRowActive(row, statusIdx) {
    if (statusIdx < 0) return true;
    const tds = row.querySelectorAll('td');
    if (statusIdx >= tds.length) return true;
    const text = tds[statusIdx].textContent.trim().toLowerCase();
    if (/не продаётся|не продается|убран из продажи|заблокирован/i.test(text)) return false;
    return true;
  }

  /* ────── Основной цикл сбора ────── */

  async function collectAllSkus() {
    log('Начинаю сбор SKU из таблицы товаров...');
    const allSkus = new Set();
    let totalSkipped = 0;
    let page = 1;

    try {
      while (true) {
        await waitForTableStable();

        // Прокручиваем таблицу для сбора ВСЕХ строк (виртуальный скроллинг)
        const { skus, skipped } = await scrollAndCollectPageSkus();
        totalSkipped += skipped;
        const newSkus = skus.filter(s => !allSkus.has(s));
        newSkus.forEach(s => allSkus.add(s));

        log(`Страница ${page}: ${newSkus.length} SKU собрано` + (skipped > 0 ? `, ${skipped} пропущено (не продаётся)` : ''));
        if (newSkus.length > 0) {
          log(`   SKU: ${newSkus.slice(0, 5).join(', ')}${newSkus.length > 5 ? '...' : ''}`);
        }

        const hasNext = await goToNextPage();
        if (!hasNext) {
          log(`Последняя страница (${page}), пагинация завершена`);
          break;
        }
        page++;
      }

      const uniqueSkus = [...allSkus];
      log(`Итого: ${uniqueSkus.length} SKU из ${page} стр.` + (totalSkipped > 0 ? `, пропущено ${totalSkipped} (не продаётся)` : ''));
      log('Отправляю SKU на обработку...');
      safeSend({ action: 'batchSkusCollected', skus: uniqueSkus });
    } catch (e) {
      log(`Ошибка сбора SKU: ${e.message}`);
      safeSend({ action: 'batchSkusCollected', skus: [...allSkus] });
    } finally {
      isCollecting = false;
    }
  }

  /* ────── Прокрутка + сбор всех строк со страницы ────── */

  async function scrollAndCollectPageSkus() {
    const seenSkus = new Set();
    const seenRowKeys = new Set();
    const skus = [];
    let skipped = 0;
    const statusIdx = getStatusColumnIndex();

    // Находим прокручиваемый контейнер
    const scrollTarget = findScrollContainer();
    log(`Скролл-контейнер: ${scrollTarget ? scrollTarget.tagName + ' (scrollHeight=' + scrollTarget.scrollHeight + ', clientHeight=' + scrollTarget.clientHeight + ')' : 'не найден'}`);

    // Шаг 1: Прокрутим вверх для начала
    if (scrollTarget) {
      scrollTarget.scrollTop = 0;
      await sleep(300);
    }

    // Шаг 2: Собираем видимые строки
    const initial = parseVisibleRows(statusIdx, seenSkus, seenRowKeys);
    skus.push(...initial.skus);
    skipped += initial.skipped;

    // Шаг 3: Если есть куда скроллить — прокручиваем и собираем
    if (scrollTarget && scrollTarget.scrollHeight > scrollTarget.clientHeight + 50) {
      const scrollStep = Math.max(200, Math.floor(scrollTarget.clientHeight * 0.6));
      let noNewRounds = 0;
      let prevSize = seenSkus.size + skipped;

      for (let pos = scrollStep; pos < scrollTarget.scrollHeight + scrollStep * 2; pos += scrollStep) {
        scrollTarget.scrollTop = pos;
        await sleep(400);

        const batch = parseVisibleRows(statusIdx, seenSkus, seenRowKeys);
        skus.push(...batch.skus);
        skipped += batch.skipped;

        const currentSize = seenSkus.size + skipped;
        if (currentSize === prevSize) {
          noNewRounds++;
          if (noNewRounds >= 4) break;
        } else {
          noNewRounds = 0;
          prevSize = currentSize;
        }

        // Проверяем дошли ли до конца
        if (scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 10) {
          // Дошли до конца, ждём и делаем ещё одну попытку
          await sleep(300);
          const extra = parseVisibleRows(statusIdx, seenSkus, seenRowKeys);
          skus.push(...extra.skus);
          skipped += extra.skipped;
          break;
        }
      }

      // Возвращаем скролл наверх
      scrollTarget.scrollTop = 0;
      await sleep(200);
    }

    log(`Прокрутка страницы: ${skus.length} SKU, ${skipped} пропущено, ${seenRowKeys.size} строк обработано`);
    return { skus, skipped };
  }

  /** Находит прокручиваемый контейнер таблицы */
  function findScrollContainer() {
    const table = document.querySelector('table');
    if (!table) return null;

    // Ищем ближайший родительский элемент с overflow scroll/auto
    let el = table.parentElement;
    while (el && el !== document.documentElement && el !== document.body) {
      const style = getComputedStyle(el);
      const oy = style.overflowY || style.overflow;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
        return el;
      }
      el = el.parentElement;
    }

    // Фоллбэк: сам document.documentElement (прокрутка всей страницы)
    if (document.documentElement.scrollHeight > window.innerHeight + 100) {
      return document.documentElement;
    }

    return null;
  }

  /** Парсит текущие видимые строки таблицы, пропуская уже обработанные */
  function parseVisibleRows(statusIdx, seenSkus, seenRowKeys) {
    const skus = [];
    let skipped = 0;
    const rows = document.querySelectorAll('table tbody tr');

    for (const row of rows) {
      // Уникальный ключ строки для дедупликации
      const sku = extractSkuFromRow(row);
      const rowKey = sku || row.querySelector('td:nth-child(2)')?.textContent?.trim()?.substring(0, 50) || '';
      if (!rowKey || seenRowKeys.has(rowKey)) continue;
      seenRowKeys.add(rowKey);

      if (!isRowActive(row, statusIdx)) {
        skipped++;
        continue;
      }

      if (sku && !seenSkus.has(sku)) {
        seenSkus.add(sku);
        skus.push(sku);
      }
    }

    return { skus, skipped };
  }

  /* ────── Парсинг строк таблицы (legacy, для совместимости) ────── */

  function parseCurrentPageSkus() {
    const skus = [];
    let skipped = 0;
    const statusIdx = getStatusColumnIndex();
    const rows = document.querySelectorAll('table tbody tr');

    for (const row of rows) {
      if (!isRowActive(row, statusIdx)) {
        skipped++;
        continue;
      }
      const sku = extractSkuFromRow(row);
      if (sku) skus.push(sku);
    }

    return { skus, skipped };
  }

  /** Извлекает SKU из одной строки таблицы (4 стратегии) */
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
    // Strategy 4: Текст "SKU XXXXXXX" в любом элементе строки
    const allText = row.textContent;
    const skuMatch = allText.match(/SKU\s+(\d{5,})/);
    if (skuMatch) return skuMatch[1];

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
          if (stableRounds >= 5) return;
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
   * Определяет текущую активную страницу среди кнопок-цифр.
   * Мульти-стратегия: атрибуты, CSS-классы, computed styles, disabled.
   */
  function findCurrentPageButton(numBtns) {
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

    // Стратегия 3: computed styles — fontWeight bold или уникальный background
    const styles = numBtns.map(btn => ({
      btn,
      weight: parseInt(getComputedStyle(btn).fontWeight) || 400,
      bg: getComputedStyle(btn).backgroundColor,
      color: getComputedStyle(btn).color
    }));

    const boldBtns = styles.filter(s => s.weight >= 600);
    const normalBtns = styles.filter(s => s.weight < 600);
    if (boldBtns.length === 1 && normalBtns.length > 0) return boldBtns[0].btn;

    const bgCounts = {};
    styles.forEach(s => { bgCounts[s.bg] = (bgCounts[s.bg] || 0) + 1; });
    const uniqueBg = styles.filter(s => bgCounts[s.bg] === 1 && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent');
    if (uniqueBg.length === 1) return uniqueBg[0].btn;

    // Стратегия 4: disabled = текущая страница
    for (const btn of numBtns) {
      if (btn.disabled || btn.getAttribute('disabled') !== null) return btn;
    }

    return numBtns[0]; // фоллбэк
  }

  async function goToNextPage() {
    const oldFirstSku = getFirstSkuOnPage();
    const table = document.querySelector('table');
    if (!table) return false;
    const tableBottom = table.getBoundingClientRect().bottom;

    // Собираем ВСЕ кликабельные элементы НИЖЕ таблицы (пагинация)
    const allClickable = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > tableBottom - 30 && r.height > 0 && r.width > 0;
    });

    if (allClickable.length === 0) {
      log('Кнопки пагинации не найдены под таблицей');
      return false;
    }

    // Кнопки-цифры
    const numBtns = allClickable.filter(b => /^\d+$/.test(b.textContent.trim()));
    const currentBtn = findCurrentPageButton(numBtns);
    const currentPage = currentBtn ? parseInt(currentBtn.textContent.trim()) : 0;

    log(`Пагинация: ${numBtns.length} кнопок-цифр, ${allClickable.length} всего под таблицей, текущая стр. ${currentPage}`);

    let clicked = false;

    // Стратегия A: Кнопка с номером currentPage + 1
    if (!clicked && currentPage > 0) {
      const nextBtn = numBtns.find(b => parseInt(b.textContent.trim()) === currentPage + 1 && !b.disabled);
      if (nextBtn) {
        log(`Клик: страница ${currentPage + 1}`);
        nextBtn.click();
        clicked = true;
      }
    }

    // Стратегия B: Кнопка-стрелка по aria-label
    if (!clicked) {
      const nextArrow = allClickable.find(b =>
        !b.disabled && /next|следующ|вперед|вперёд/i.test(b.getAttribute('aria-label') || '')
      );
      if (nextArrow) {
        log('Клик: стрелка «следующая» (aria-label)');
        nextArrow.click();
        clicked = true;
      }
    }

    // Стратегия C: Текстовая стрелка (→ › » >)
    if (!clicked) {
      const arrowBtn = allClickable.find(b =>
        !b.disabled && ['→', '›', '»', '>'].includes(b.textContent.trim())
      );
      if (arrowBtn) {
        log('Клик: текстовая стрелка');
        arrowBtn.click();
        clicked = true;
      }
    }

    // Стратегия D: SVG-стрелка справа от последней цифры
    if (!clicked && numBtns.length > 0) {
      const lastNum = numBtns[numBtns.length - 1];
      const lastRect = lastNum.getBoundingClientRect();
      const svgBtn = allClickable.find(b => {
        if (b.disabled || numBtns.includes(b)) return false;
        const r = b.getBoundingClientRect();
        return r.left >= lastRect.right - 5 && b.querySelector('svg');
      });
      if (svgBtn) {
        log('Клик: SVG-стрелка вперёд');
        svgBtn.click();
        clicked = true;
      }
    }

    // Стратегия E: Следующая кнопка-цифра в DOM-порядке
    if (!clicked && currentBtn) {
      const idx = numBtns.indexOf(currentBtn);
      if (idx >= 0 && idx < numBtns.length - 1 && !numBtns[idx + 1].disabled) {
        log(`Клик: следующая цифра ${numBtns[idx + 1].textContent.trim()}`);
        numBtns[idx + 1].click();
        clicked = true;
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
    // Фоллбэк: текст первой ячейки
    const firstTd = document.querySelector('table tbody tr td:nth-child(2)');
    if (firstTd) return firstTd.textContent.trim().substring(0, 30);
    return null;
  }

  /** Ждём пока первый SKU на странице изменится (макс 10с) */
  async function waitForTableUpdate(oldFirstSku) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const newFirst = getFirstSkuOnPage();
      if (newFirst && newFirst !== oldFirstSku) return;
      if (!newFirst && i > 2) continue;
    }
    log('Ожидание обновления таблицы истекло (10с)');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('Batch products collector загружен');
})();
