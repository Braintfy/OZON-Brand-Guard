// OZON Brand Guard — Batch Products SKU Collector v3.6.0
// Работает на seller.ozon.ru/app/products*
// Парсит таблицу товаров продавца и извлекает SKU для пакетного поиска дубликатов
// Поддерживает виртуальный скроллинг: прокручивает СТРАНИЦУ (window.scrollTo)
// Фильтрует по статусу: пропускает «Не продается», «Убран из продажи», «Заблокирован»
// Автор: firayzer (https://t.me/firayzer)

(function () {
  'use strict';

  // Тройная защита от двойной инъекции
  if (window.__obgBatchLoaded) {
    if (document.getElementById('__obg-batch-guard')) return;
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
      isCollecting = true;
      collectAllSkus();
    }
  });

  /* ════════════════════════════════════════════════════════════════
     ДИАГНОСТИКА: Информация со вкладок и таблицы
     ════════════════════════════════════════════════════════════════ */

  /**
   * Считывает ожидаемое количество товаров из вкладки «Все» (или активной вкладки).
   * Вкладки: button[data-widget="@products/tabs/products-list-filter-tab"]
   * Внутри: div.rc8110-a0 содержит число (напр. "72")
   */
  function getExpectedCountFromTabs() {
    // Ищем активную вкладку (data-active="true") или первую вкладку ("Все")
    const tabs = document.querySelectorAll('button[data-widget="@products/tabs/products-list-filter-tab"]');
    for (const tab of tabs) {
      const isActive = tab.getAttribute('data-active') === 'true';
      const text = tab.textContent || '';
      // Первая вкладка обычно "Все" с общим количеством
      if (isActive || /^\s*все\s/i.test(text)) {
        const countEl = tab.querySelector('.rc8110-a0') || tab.querySelector('[class*="rc8110"]');
        if (countEl) {
          const num = parseInt(countEl.textContent.trim());
          if (num > 0) return num;
        }
        // Фоллбэк: ищем число в тексте вкладки
        const m = text.match(/(\d+)/);
        if (m) return parseInt(m[1]);
      }
    }
    return -1; // неизвестно
  }

  /**
   * Определяет колонку статуса по заголовку th[data-cell-name="th-status"]
   */
  function getStatusColumnIndex() {
    const headers = document.querySelectorAll('table thead th');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].getAttribute('data-cell-name') === 'th-status') return i;
    }
    for (let i = 0; i < headers.length; i++) {
      if (/статус/i.test(headers[i].textContent.trim())) return i;
    }
    return -1;
  }

  /**
   * Проверяет статус строки. true = товар активен.
   * Статусы «Не продается», «Убран из продажи», «Заблокирован», «Сняты с продажи» → false.
   */
  function isRowActive(row, statusIdx) {
    if (statusIdx < 0) return true;
    const tds = row.querySelectorAll('td');
    if (statusIdx >= tds.length) return true;
    const text = tds[statusIdx].textContent.trim().toLowerCase();
    if (/не продаётся|не продается|убран из продажи|заблокирован|снят[аоы]? с продажи/i.test(text)) return false;
    return true;
  }

  /* ════════════════════════════════════════════════════════════════
     ГЛАВНЫЙ ЦИКЛ СБОРА
     ════════════════════════════════════════════════════════════════ */

  async function collectAllSkus() {
    log('Начинаю сбор SKU из таблицы товаров...');

    const expectedTotal = getExpectedCountFromTabs();
    log(`Ожидаемое кол-во (из вкладки): ${expectedTotal > 0 ? expectedTotal : 'неизвестно'}`);

    const allSkus = new Set();
    let totalSkipped = 0;
    let page = 1;

    try {
      while (true) {
        await waitForTableReady();

        const { skus, skipped } = await scrollPageAndCollect();
        totalSkipped += skipped;
        const newSkus = skus.filter(s => !allSkus.has(s));
        newSkus.forEach(s => allSkus.add(s));

        log(`Стр. ${page}: +${newSkus.length} SKU` + (skipped > 0 ? `, ${skipped} пропущено` : '') + ` (всего: ${allSkus.size})`);
        if (newSkus.length > 0) {
          log(`  Примеры: ${newSkus.slice(0, 5).join(', ')}${newSkus.length > 5 ? '...' : ''}`);
        }

        // Проверяем: набрали ли уже все?
        if (expectedTotal > 0 && allSkus.size + totalSkipped >= expectedTotal) {
          log(`Собрано ${allSkus.size} + пропущено ${totalSkipped} = ${allSkus.size + totalSkipped} ≥ ${expectedTotal}, завершаю`);
          break;
        }

        const hasNext = await goToNextPage();
        if (!hasNext) {
          log(`Последняя страница (${page}), пагинация завершена`);
          break;
        }
        page++;
      }

      const uniqueSkus = [...allSkus];
      log(`✓ Итого: ${uniqueSkus.length} SKU из ${page} стр.` + (totalSkipped > 0 ? `, пропущено ${totalSkipped}` : ''));
      safeSend({ action: 'batchSkusCollected', skus: uniqueSkus });
    } catch (e) {
      log(`❌ Ошибка: ${e.message}`);
      safeSend({ action: 'batchSkusCollected', skus: [...allSkus], error: e.message });
    } finally {
      isCollecting = false;
    }
  }

  /* ════════════════════════════════════════════════════════════════
     ПРОКРУТКА СТРАНИЦЫ + СБОР
     Ключевой принцип: прокручиваем window (не контейнер),
     потому что виртуальный скроллинг OZON привязан к скроллу страницы.
     ════════════════════════════════════════════════════════════════ */

  async function scrollPageAndCollect() {
    const seenSkus = new Set();
    const skus = [];
    let skipped = 0;
    const statusIdx = getStatusColumnIndex();

    // Фаза 1: Простой сбор — может все строки уже в DOM
    const directResult = collectVisibleSkus(statusIdx, seenSkus);
    skus.push(...directResult.skus);
    skipped += directResult.skipped;

    log(`[DIAG] Фаза 1 (direct query): ${seenSkus.size} SKU, ${skipped} пропущено, строк в DOM: ${document.querySelectorAll('table tbody tr').length}`);

    // Фаза 2: Прокрутка window для рендеринга виртуальных строк
    const table = document.querySelector('table');
    if (!table) return { skus, skipped };

    // Находим прокручиваемый элемент
    const scrollEl = findScrollableElement(table);
    const isWindow = scrollEl === null;
    const scrollName = isWindow ? 'window' : scrollEl.tagName + '.' + (scrollEl.className || '').split(' ')[0];

    const getScrollTop = () => isWindow ? window.scrollY : scrollEl.scrollTop;
    const getScrollHeight = () => isWindow ? document.documentElement.scrollHeight : scrollEl.scrollHeight;
    const getViewHeight = () => isWindow ? window.innerHeight : scrollEl.clientHeight;
    const doScroll = (y) => isWindow ? window.scrollTo({ top: y, behavior: 'instant' }) : (scrollEl.scrollTop = y);

    log(`[DIAG] Скроллинг через: ${scrollName}, scrollHeight=${getScrollHeight()}, viewHeight=${getViewHeight()}`);

    // Скроллим в начало
    doScroll(0);
    await sleep(300);

    // Собираем после скролла в начало
    const afterTop = collectVisibleSkus(statusIdx, seenSkus);
    skus.push(...afterTop.skus);
    skipped += afterTop.skipped;

    // Инкрементальная прокрутка
    const viewH = getViewHeight();
    const step = Math.max(200, Math.floor(viewH * 0.7));
    let noNewCount = 0;
    let prevTotal = seenSkus.size + skipped;
    const maxScroll = getScrollHeight();

    for (let y = step; y <= maxScroll + step; y += step) {
      doScroll(y);
      await sleep(350);

      const batch = collectVisibleSkus(statusIdx, seenSkus);
      skus.push(...batch.skus);
      skipped += batch.skipped;

      const newTotal = seenSkus.size + skipped;
      if (newTotal === prevTotal) {
        noNewCount++;
        if (noNewCount >= 6) {
          log(`[DIAG] 6 шагов без новых строк, прерываю (y=${y})`);
          break;
        }
      } else {
        noNewCount = 0;
        prevTotal = newTotal;
      }

      // Дошли до конца?
      const curTop = getScrollTop();
      if (curTop + getViewHeight() >= getScrollHeight() - 20) {
        await sleep(300);
        const last = collectVisibleSkus(statusIdx, seenSkus);
        skus.push(...last.skus);
        skipped += last.skipped;
        break;
      }
    }

    // Возвращаем скролл наверх
    doScroll(0);

    log(`[DIAG] Фаза 2 итого: ${skus.length} SKU, ${skipped} пропущено`);
    return { skus, skipped };
  }

  /**
   * Ищет ближайший прокручиваемый контейнер таблицы.
   * Возвращает DOM-элемент или null (если скроллится window).
   */
  function findScrollableElement(table) {
    let el = table.parentElement;
    while (el && el !== document.documentElement && el !== document.body) {
      const style = getComputedStyle(el);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 100) {
        return el;
      }
      el = el.parentElement;
    }
    // Нет контейнера — скроллить window
    return null;
  }

  /* ════════════════════════════════════════════════════════════════
     ИЗВЛЕЧЕНИЕ SKU ИЗ ВИДИМЫХ СТРОК
     ════════════════════════════════════════════════════════════════ */

  /**
   * Собирает SKU из всех текущих строк таблицы.
   * Дедупликация через seenSkus (Set).
   */
  function collectVisibleSkus(statusIdx, seenSkus) {
    const skus = [];
    let skipped = 0;
    const rows = document.querySelectorAll('table tbody tr');

    for (const row of rows) {
      const sku = extractSkuFromRow(row);
      if (!sku) continue;
      if (seenSkus.has(sku)) continue;

      if (!isRowActive(row, statusIdx)) {
        seenSkus.add(sku); // Добавляем в seen чтобы не проверять повторно
        skipped++;
        continue;
      }

      seenSkus.add(sku);
      skus.push(sku);
    }

    return { skus, skipped };
  }

  /**
   * Извлекает SKU из одной строки таблицы.
   * Приоритет селекторов основан на анализе DOM:
   * 1. span[data-widget="@products/list-ods/table/cell/sku-fbs/span"] → "SKU  3553435313"
   * 2. a[data-widget="products-table-row-title-link"] → href "/product/3553435313"
   * 3. span[data-style="text"] → "OZN3553435313"
   * 4. Любой текст "SKU XXXXX" в строке
   */
  function extractSkuFromRow(row) {
    // Strategy 1: data-widget SKU span (самый надёжный)
    const skuSpan = row.querySelector('[data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
    if (skuSpan) {
      const m = skuSpan.textContent.trim().match(/(\d{5,})/);
      if (m) return m[1];
    }
    // Strategy 2: product title link href
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
    // Strategy 4: fallback — любой "SKU XXXX" в строке
    const m = row.textContent.match(/SKU\s+(\d{5,})/);
    if (m) return m[1];

    return null;
  }

  /* ════════════════════════════════════════════════════════════════
     ОЖИДАНИЕ ЗАГРУЗКИ ТАБЛИЦЫ
     ════════════════════════════════════════════════════════════════ */

  /**
   * Ждёт появления таблицы с хотя бы одной строкой.
   * Проверяет стабилизацию количества строк (3 одинаковых чтения по 500мс).
   */
  async function waitForTableReady() {
    let lastCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < 30; i++) {
      const rows = document.querySelectorAll('table tbody tr');
      const skuSpans = document.querySelectorAll('[data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
      const count = Math.max(rows.length, skuSpans.length);

      if (count > 0) {
        if (count === lastCount) {
          stableRounds++;
          if (stableRounds >= 3) return;
        } else {
          stableRounds = 0;
          lastCount = count;
        }
      }
      await sleep(500);
    }

    if (lastCount > 0) {
      log(`Таблица: ${lastCount} строк (стабилизация по таймауту)`);
    } else {
      log('⚠ Таблица не найдена после 15с ожидания');
    }
  }

  /* ════════════════════════════════════════════════════════════════
     ПАГИНАЦИЯ
     ════════════════════════════════════════════════════════════════ */

  /**
   * Определяет текущую активную страницу из кнопок-цифр пагинации.
   */
  function findCurrentPageButton(numBtns) {
    if (numBtns.length === 0) return null;

    // 1. Атрибуты data-selected/aria-current/aria-pressed
    for (const btn of numBtns) {
      if (btn.getAttribute('data-selected') === 'true') return btn;
      if (btn.getAttribute('aria-current') === 'true' || btn.getAttribute('aria-current') === 'page') return btn;
      if (btn.getAttribute('aria-pressed') === 'true') return btn;
    }

    // 2. CSS-класс с active/selected/current
    for (const btn of numBtns) {
      const cls = btn.className || '';
      if (/active|selected|current/i.test(cls) && !/inactive|unselected/i.test(cls)) return btn;
    }

    // 3. Computed style: bold или уникальный фон
    const styles = numBtns.map(btn => {
      const cs = getComputedStyle(btn);
      return { btn, weight: parseInt(cs.fontWeight) || 400, bg: cs.backgroundColor };
    });

    const boldBtns = styles.filter(s => s.weight >= 600);
    if (boldBtns.length === 1) return boldBtns[0].btn;

    const bgCounts = {};
    styles.forEach(s => { bgCounts[s.bg] = (bgCounts[s.bg] || 0) + 1; });
    const uniqueBg = styles.filter(s => bgCounts[s.bg] === 1 && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent');
    if (uniqueBg.length === 1) return uniqueBg[0].btn;

    // 4. disabled
    for (const btn of numBtns) {
      if (btn.disabled) return btn;
    }

    return numBtns[0];
  }

  /**
   * Переход на следующую страницу. Возвращает true если удалось.
   * Сначала скроллит страницу вниз до пагинации, чтобы кнопки были в DOM.
   */
  async function goToNextPage() {
    const oldFirstSku = getFirstSkuOnPage();

    // Скроллим до конца страницы чтобы пагинация была видна
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await sleep(500);

    // Собираем кнопки пагинации
    const table = document.querySelector('table');
    if (!table) return false;

    const tableRect = table.getBoundingClientRect();

    // Все кликабельные элементы ниже таблицы (в viewport)
    const allClickable = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > tableRect.bottom - 50 && r.height > 0 && r.width > 0 && r.top < window.innerHeight + 100;
    });

    if (allClickable.length === 0) {
      log('Кнопки пагинации не найдены');
      return false;
    }

    // Кнопки с цифрами
    const numBtns = allClickable.filter(b => /^\d+$/.test(b.textContent.trim()));
    const currentBtn = findCurrentPageButton(numBtns);
    const currentPage = currentBtn ? parseInt(currentBtn.textContent.trim()) : 0;

    log(`Пагинация: ${numBtns.length} кнопок-цифр, текущая стр. ${currentPage}`);

    let clicked = false;

    // A: Кнопка currentPage + 1
    if (!clicked && currentPage > 0) {
      const nextBtn = numBtns.find(b => parseInt(b.textContent.trim()) === currentPage + 1 && !b.disabled);
      if (nextBtn) {
        log(`Клик: стр. ${currentPage + 1}`);
        nextBtn.click();
        clicked = true;
      }
    }

    // B: aria-label next/следующая
    if (!clicked) {
      const nextArrow = allClickable.find(b =>
        !b.disabled && /next|следующ|вперед|вперёд/i.test(b.getAttribute('aria-label') || '')
      );
      if (nextArrow) {
        log('Клик: стрелка (aria-label)');
        nextArrow.click();
        clicked = true;
      }
    }

    // C: Текстовая стрелка › »
    if (!clicked) {
      const arrowBtn = allClickable.find(b =>
        !b.disabled && /^[→›»>]$/.test(b.textContent.trim())
      );
      if (arrowBtn) {
        log('Клик: текстовая стрелка');
        arrowBtn.click();
        clicked = true;
      }
    }

    // D: SVG-кнопка правее последней цифры
    if (!clicked && numBtns.length > 0) {
      const lastRect = numBtns[numBtns.length - 1].getBoundingClientRect();
      const svgBtn = allClickable.find(b => {
        if (b.disabled || numBtns.includes(b)) return false;
        const r = b.getBoundingClientRect();
        return r.left >= lastRect.right - 10 && b.querySelector('svg');
      });
      if (svgBtn) {
        log('Клик: SVG-стрелка');
        svgBtn.click();
        clicked = true;
      }
    }

    // E: Следующая цифра в DOM-порядке
    if (!clicked && currentBtn) {
      const idx = numBtns.indexOf(currentBtn);
      if (idx >= 0 && idx < numBtns.length - 1 && !numBtns[idx + 1].disabled) {
        log(`Клик: цифра ${numBtns[idx + 1].textContent.trim()}`);
        numBtns[idx + 1].click();
        clicked = true;
      }
    }

    if (!clicked) {
      log('Не удалось найти кнопку следующей страницы');
      return false;
    }

    // Скроллим наверх и ждём обновления
    window.scrollTo({ top: 0, behavior: 'instant' });
    await waitForTableUpdate(oldFirstSku);
    return true;
  }

  /**
   * SKU первой строки — для детекции смены страницы.
   */
  function getFirstSkuOnPage() {
    const span = document.querySelector('[data-widget="@products/list-ods/table/cell/sku-fbs/span"]');
    if (span) {
      const m = span.textContent.trim().match(/(\d{5,})/);
      if (m) return m[1];
    }
    const link = document.querySelector('a[data-widget="products-table-row-title-link"]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/\/product\/(\d{5,})/);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Ждём пока таблица обновится после клика пагинации (новый первый SKU).
   */
  async function waitForTableUpdate(oldFirstSku) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const newFirst = getFirstSkuOnPage();
      if (newFirst && newFirst !== oldFirstSku) return;
    }
    log('Ожидание обновления таблицы истекло (10с)');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  log('Batch collector v3.6 загружен');
})();
