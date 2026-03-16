# OZON Brand Guard — Project Map

> Обновляется после каждого изменения вместе с CHANGELOG.md
> Последнее обновление: 2026-03-16 | Версия: 3.5.0

## Архитектура

```
Chrome Extension (Manifest V3)
├── popup/          — UI расширения (5 вкладок: Дубликаты, Отчёт, Настройки, Бренды, Инфо)
├── content/        — Content scripts (4 скрипта: duplicates, batch-products, sellers, products)
├── background/     — Service Worker (планировщик, логи, relay, навигация дубликатов)
├── libs/           — Библиотеки (xlsx-reader.js — парсер XLSX для импорта SKU)
├── options/        — Страница расширенных настроек (статичная)
├── assets/         — Иконки (SVG щит + PNG 16/48/128 + generate-icons.html)
└── _locales/       — Локализация (ru, en)
```

## Файлы и их роли

### manifest.json
- **Manifest V3**, version `3.5.0`
- Permissions: `storage`, `alarms`, `notifications`, `activeTab`, `scripting`, `tabs`
- Host: `https://seller.ozon.ru/*`, `https://www.ozon.ru/*`
- Content scripts инжектятся программно через `chrome.scripting.executeScript`
- Popup: `popup/popup.html`
- Background: `background/service-worker.js`
- Options: `options/options.html`

### background/service-worker.js (~732 строк)
- **Message hub** — принимает сообщения от content и popup, relay между ними
- **Actions**: `getStatus`, `setRunning`, `updateSchedule`, `logComplaint`, `showNotification`, `getConfig`
- **Duplicate Actions**: `launchDuplicates`, `stopDuplicates`, `pauseDuplicates`, `resumeDuplicates`, `resumeFromSaved`, `getPausedSession`, `duplicatePageResult`, `duplicateScanStopped`, `updateDuplicateStats`, `launchCurrentPage`, `launchBatchProducts`, `batchSkusCollected`
- **History Actions**: `getHistory`, `clearHistory`
- **Relay actions**: `scanBrandsResult`, `updateStats`, `done`, `logUpdate`, `techLog`, `doneDuplicates`, `duplicatePageDone`, `duplicateScanPaused`, `duplicateScanResumed`
- **duplicateScanState**: `{ skus, currentIndex, results, config, tabId, isPaused }` — состояние последовательного обхода SKU
- **Paused session persistence**: `savePausedSession()`, `clearPausedSession()`, `loadPausedSession()` — сохранение в `obgPausedSession`
- **Scheduling**: `chrome.alarms` для автозапуска (ALARM_SELLERS, ALARM_PRODUCTS)
- **Logging**: `addLogEntry()` — сохраняет в `chrome.storage.local`, лимит **5000** записей
- **History**: `saveDuplicateSession()` — до 10 сессий в `obgDupHistory`

#### Ключевые функции service-worker.js

| Функция | Описание |
|---------|----------|
| `navigateInjectStart(url, script, action, config)` | Найти/создать вкладку → инжект скрипта → отправить сообщение |
| `injectAndStart(tabId, scriptFile, action, config)` | `executeScript(allFrames: false)` + CSS |
| `waitForTabComplete(tabId)` | Ожидание загрузки вкладки (15с таймаут) |
| `switchToBrandCabinet(tabId)` | MAIN world скрипт — клик по «Кабинет бренда» в дропдауне |
| `launchDuplicateSearch(skus, config, strategy)` | Точка входа: установить состояние, запустить цикл |
| `processDuplicateSku(index)` | Основной цикл: открыть страницу → инжект → ждать результатов |
| `handleDuplicatePageResult(msg)` | Сохранить результаты, проверить isPaused, поставить следующий SKU |
| `pauseDuplicateSearch()` | Установить isPaused + сохранить в storage |
| `resumeDuplicateSearch()` | Снять isPaused + продолжить с текущего индекса |
| `resumeFromSavedSession()` | Восстановить duplicateScanState из obgPausedSession |
| `stopDuplicateSearch()` | Прервать текущий скан, сохранить в историю |
| `saveDuplicateSession(status)` | Сохранить в obgDupHistory (до 10 сессий) |
| `savePausedSession()` | Snapshot сессии → obgPausedSession |
| `clearPausedSession()` | Очистить obgPausedSession |
| `launchCurrentPageScan()` | Извлечь SKU из URL активной вкладки: `/product/.*?(\d{5,})/` |
| `launchBatchFromProducts(config)` | Открыть страницу товаров, инжектировать batch collector |
| `updateSchedule(config)` | Настройка Chrome alarms для продавцов |
| `updateProductSchedule(config)` | Настройка Chrome alarms для товаров |
| `addLogEntry(entry)` | Сохранить в storage (макс. 5000 записей) |

### content/content-duplicates.js (~641 строк) — МОДУЛЬ ДУБЛИКАТОВ
Работает на `www.ozon.ru/product/*`. IIFE с guard `#__obg-duplicates-guard`.

#### Основные функции

| Функция | Описание |
|---------|----------|
| `startScan(skus, startIndex)` | Точка входа: ожидание загрузки → сбор конкурентов → отправка результатов |
| `waitForPageLoad()` | Ожидание рендера SPA (20 попыток, ищет `data-widget` элементы) |
| `collectCompetitors(mySku)` | 4 стратегии сбора + фильтрация по whitelist |
| `findCompetitorSections()` | Поиск секций: data-widget, текст заголовков, TreeWalker |
| `parseProductCards(container, seenSkus, mySku)` | Парсинг карточек → SKU, название, цена, продавец, URL, изображение, рейтинг |
| `findExpandButton()` | Поиск и клик «Показать все» |
| `parseAllProductLinks(seenSkus, mySku)` | Резервный поиск — все `a[href*="/product/"]` кроме nav/header/footer |
| `parseOzonWidgets(seenSkus, mySku)` | Последний резерв — виджеты с `data-widget` Similar/Offer/Seller/Cheaper |
| `extractSkuFromUrl(url)` | Regex: `/product/.*?(\d{5,})/` → SKU |
| `extractCardData(container, sku, href)` | Извлечение: name, price (минимальная), seller, image, rating, reviews |
| `applyWhitelist(competitors)` | Фильтрация по `duplicateWhitelist` (sku/seller/inn) |
| `showPanel()` | Drag-панель на странице OZON (синяя тема, ⏸ ⏹ − × кнопки) |

#### 4 стратегии сбора (по порядку):
1. **data-widget секции** — `[data-widget*="Similar/Seller/Offer/Cheaper"]` (самый надёжный)
2. **Текстовые секции** — поиск заголовков «есть дешевле», «другие продавцы»
3. **Широкий поиск ссылок** — все product-ссылки кроме nav/header/footer
4. **Виджет-парсинг** — финальный резерв через атрибуты `data-widget`

#### Протокол сообщений:
- **Принимает:** `startDuplicateScan { skus[], currentIndex, config }` + `stopDuplicates` + `pauseDuplicates` + `resumeDuplicates`
- **Отправляет:** `duplicatePageResult { sku, competitors[], error?, pageIndex, totalSkus }` + `techLog`

### content/content-batch-products.js (~473 строк) — BATCH КОЛЛЕКТОР SKU (v3.5.0 rewrite)
Работает на `seller.ozon.ru/app/products`. IIFE с тройной защитой от повторной инъекции.

#### Защита от двойной инъекции:
1. `window.__obgBatchLoaded` — глобальный флаг
2. `#__obg-batch-guard` — DOM-элемент
3. `isCollecting = true` — устанавливается немедленно в обработчике сообщений

#### Основные функции

| Функция | Описание |
|---------|----------|
| `collectAllSkus()` | Главный цикл: scroll+collect по страницам → пагинация → отправка |
| `scrollAndCollectPageSkus()` | **Инкрементальная прокрутка** контейнера: 300мс между шагами, сбор строк на каждой позиции |
| `findScrollContainer()` | Поиск прокручиваемого контейнера вверх по DOM (overflow-y: auto/scroll) |
| `parseVisibleRows(statusIdx, seenSkus, seenRowKeys)` | Парсинг видимых строк с дедупликацией по SKU + текстовому ключу |
| `getStatusColumnIndex()` | Поиск колонки «Статус» в заголовке таблицы |
| `isRowActive(row, statusIdx)` | Фильтрация: пропускает «Не продается», «Убран из продажи», «Заблокирован» |
| `goToNextPage(tableRect)` | 5 стратегий пагинации без зависимости от контейнера |
| `waitForTableStable()` | Ожидание стабилизации DOM (5 раундов по 500мс) |
| `waitForTableUpdate(oldFirstSku)` | Ожидание обновления таблицы после клика пагинации |

#### 4 стратегии извлечения SKU из строки:
1. **data-widget spans** — `[data-widget="@products/list-ods/table/cell/sku-fbs/span"]` → regex `SKU\s+(\d{5,})`
2. **Product links** — `a[data-widget="products-table-row-title-link"]` → href `/product/(\d{5,})`
3. **Barcode cells** — `[data-style="text"]` → regex `OZN(\d{5,})`
4. **Full text** — `textContent.match(/SKU\s+(\d{5,})/)` (вся строка)

#### 5 стратегий пагинации (goToNextPage):
1. **Нумерованная кнопка** currentPage+1
2. **aria-label** содержащий «next»/«вперёд»/«следующ»
3. **Текстовые стрелки** `›` или `»`
4. **SVG-стрелка** правее последней нумерованной кнопки
5. **Следующая по DOM** нумерованная кнопка после текущей

#### Виртуальный скроллинг:
Таблица OZON рендерит ~36 строк на страницу, но в DOM одновременно видны ~9-10. `scrollAndCollectPageSkus()` прокручивает контейнер инкрементально (шаг = высота контейнера - 50px) и собирает строки на каждой позиции скролла, дедуплицируя по SKU и текстовому ключу.

#### Протокол сообщений:
- **Принимает:** `collectProductSkus`
- **Отправляет:** `batchSkusCollected { skus[], error? }` + `techLog`

### libs/xlsx-reader.js (~237 строк) — XLSX ПАРСЕР (NEW v3.5.0)
Минимальный парсер XLSX-файлов для Chrome Extension. Используется для импорта SKU из файла «Цены товаров» (seller.ozon.ru → Шаблоны → Цены товаров).

#### Основные функции

| Функция | Описание |
|---------|----------|
| `readXlsxSkus(buffer)` | Главная точка входа: ArrayBuffer → `{skus[], total, filtered}` |
| `unzipFiles(buffer)` | Парсинг ZIP-архива: local file headers, deflate через DecompressionStream |
| `inflateData(compressedBytes)` | Декомпрессия через `DecompressionStream('deflate-raw')` |
| `parseSharedStrings(xml)` | Парсинг `xl/sharedStrings.xml` → массив строк |
| `parseSheetSkus(xml, sharedStrings)` | Поиск колонки SKU, извлечение данных, фильтрация по статусу |
| `getCellValue(cell, sharedStrings)` | Получение значения ячейки (с учётом shared strings) |

#### Структура XLSX «Цены товаров»:
- Sheet1 — инструкция «Как работать с шаблоном»
- Sheet2 — данные: Row1=категории заголовков, Row2=заголовки (A=Артикул, B=SKU, D=Статус), Row3=подзаголовки, Row4=пустая, Row5+=данные
- Колонка B содержит числовые SKU (10-значные)
- Колонка D содержит статус: «Продается», «Готов к продаже», «Не продается»

### content/content.js (~1743 строк) — LEGACY: МОДУЛЬ ПРОДАВЦОВ
Работает на `seller.ozon.ru/app/brand/sellers*`. IIFE с guard `#__obg-sellers-guard`.

#### Основные функции

| Функция | Описание |
|---------|----------|
| `startProcess()` | Главная точка входа: stats reset, showPanel, processAllPages |
| `stopProcess()` | Немедленная остановка всех процессов |
| `processAllPages()` | Цикл: парсинг → whitelist check → fileComplaint → next page |
| `parseSellersTable()` | Парсинг таблицы OZON (5 колонок: checkbox, name, brand, count, country) |
| `fileComplaint()` | 5 шагов: menu → пожаловаться → textarea → file → submit |
| `scanBrandsOnPage()` | Автопоиск брендов (4 стратегии) |
| `simulateRealClick()` | PointerEvents + MouseEvents + native click для React 17+ |
| `showPanel()` | Плавающая панель: stats, log, drag, minimize, stop |

### content/content-products.js (~879 строк) — LEGACY: МОДУЛЬ ТОВАРОВ
Работает на `seller.ozon.ru/app/brand-products/*`. IIFE с guard `#__obg-products-guard`.

#### Основные функции

| Функция | Описание |
|---------|----------|
| `parseProductsTable()` | Парсинг таблицы товаров (7 колонок) |
| `fileProductComplaint()` | Полный цикл: menu → Пожаловаться → textarea → file → submit |
| `checkWhitelist(sellerName)` | Проверка продавца по whitelist (name only) |

### content/content.css (~191 строк)
- `.obg-overlay`, `.obg-panel` — стили плавающей панели (drag)
- `.obg-panel--orange` — оранжевая тема для товаров
- `.obg-violator-row` / `.obg-whitelisted-row` — подсветка строк
- `.obg-badge--violator` / `.obg-badge--safe` — бейджи

### popup/popup.html (~534 строк)
5 вкладок: Дубликаты | Отчёт | Настройки | Бренды (legacy) | Инфо
- **Дубликаты**: 4 стратегии сбора (ручной ввод, текущая страница, batch, **проверка из таблицы XLSX**), прогресс-бар, быстрые результаты, копирование SKU + Excel, карточка возобновления паузы
- **Отчёт**: таблица дубликатов (с кнопками 📋 копирования SKU) + группировка по продавцам + export Excel/CSV + история поисков + техлог
- **Настройки**: вайтлист (SKU/продавец/ИНН), экспорт/импорт данных
- **Бренды (legacy)**: deprecated notice + полный старый функционал
- **Инфо**: 3 шага поиска дубликатов + советы + совместимость
- Footer: `v3.5.0 by firayzer`
- Scripts: `libs/xlsx-reader.js` + `popup.js`

### popup/popup.js (~1244 строк)
- `DEFAULT_CONFIG`: brands[], whitelist[], duplicateWhitelist[], duplicateDelay:3, lastDuplicateResults[], savedSkuInput
- `MAX_LOG_ENTRIES = 5000`
- **4 стратегии**: `manual`, `current`, `batch`, `file` — переключение через `mode-switch[data-name="dupStrategy"]`
- **XLSX импорт**: `xlsxParsedSkus[]` — локальная переменная, заполняется при выборе файла через `readXlsxSkus()`
- **Пауза/Продолжение**: `scanPaused` флаг, `checkPausedSession()` при init
- **Карточка возобновления**: `#dupResumeCard` с `btnResumeSaved`/`btnDiscardSaved`
- **Копирование SKU**: `.btn-copy-sku` кнопки с обработчиками в таблице и быстрых результатах
- **История**: `renderHistory()` с кнопками «Загрузить» и «📥 SKU»
- `stratLabel`: `{ manual: 'Ручной', current: 'Страница', batch: 'Пакетный', file: 'Из таблицы' }`
- Message listener: `batchSkusCollected`, `updateDuplicateStats`, `duplicatePageDone`, `duplicateScanPaused`, `duplicateScanResumed`, `doneDuplicates`, `updateStats`, `done`, `logUpdate`, `techLog`, `updateProductStats`, `doneProducts`, `scanBrandsResult`

### popup/popup.css (~1237 строк)
Ключевые блоки: tabs, cards, inputs, brand-item, file-upload, stats, log-header, sub-tabs, log-table, log-export, tech-log-list, dup-progress, dup-quick-list, dup-group, btn-copy-sku, scrollbar, footer, notice--deprecated, notice--info

### options/options.html (78 строк)
Статичная страница: инструкция, совместимость, технические детали

## Config (chrome.storage.local → obgConfig)

```js
{
  // Поиск дубликатов (v3.0+)
  duplicateWhitelist: [{ value, type: 'sku'|'seller'|'inn' }],
  duplicateDelay: 3,                  // задержка между SKU (секунды)
  lastDuplicateResults: [{            // сохранённые результаты
    sourceSku, sku, name, price, seller, sellerUrl, url, image, rating, reviews
  }],
  savedSkuInput: '',                  // сохранённый текст из textarea SKU

  // Legacy: Защита брендов
  brands: [{ id, name, complaint, fileData (base64), fileName }],
  whitelist: [{ value, type: 'name'|'inn' }],
  bannedCountries: ['CN'],
  useCountryFilter: true,
  defaultComplaint: 'Продажа подделок на мой бренд',
  productComplaintText: '',
  productFileData: null,
  productFileName: '',
  skipProductFile: false,
  delaySeconds: 15,
  productMode: 'scan' | 'complain',
  mode: 'scan' | 'complain',
  dryRun: false,
  scheduleEnabled: false,
  scheduleInterval: 6,
  productScheduleEnabled: false,
  productScheduleInterval: 6,
  notificationsEnabled: true,
  log: [{ date, seller, inn, brand, country, success, error? }]  // до 5000 записей
}
```

**Storage keys:**
- `obgConfig` — основная конфигурация
- `obgTechLog` — технические логи (до 500 записей)
- `obgDupHistory` — история поисков дубликатов (до 10 сессий)
- `obgPausedSession` — сохранённая приостановленная сессия

## Поток сообщений

```
popup.js → chrome.tabs.sendMessage → content.js (start/stop/scanBrands)
content.js → chrome.runtime.sendMessage → service-worker.js (logComplaint/setRunning/techLog/updateStats)
service-worker.js → chrome.runtime.sendMessage → popup.js (relay: techLog/updateStats/done/scanBrandsResult)

popup.js → chrome.runtime.sendMessage → service-worker.js (launchDuplicates/stopDuplicates/pauseDuplicates/resumeDuplicates/resumeFromSaved/getPausedSession/launchCurrentPage/launchBatchProducts)
service-worker.js → chrome.tabs.sendMessage → content-duplicates.js (startDuplicateScan/stopDuplicates/pauseDuplicates/resumeDuplicates)
content-duplicates.js → chrome.runtime.sendMessage → service-worker.js (duplicatePageResult)
service-worker.js → chrome.runtime.sendMessage → popup.js (relay: duplicatePageDone/doneDuplicates/updateDuplicateStats/duplicateScanPaused/duplicateScanResumed)

service-worker.js → chrome.tabs.sendMessage → content-batch-products.js (collectProductSkus)
content-batch-products.js → chrome.runtime.sendMessage → service-worker.js (batchSkusCollected)
```

## Архитектура поиска дубликатов (v3.5.0)

```
[Popup] 4 стратегии запуска:
  ├── Ручной ввод SKU → launchDuplicates
  ├── Текущая страница → launchCurrentPage → background извлекает SKU из URL
  ├── Batch с товаров → launchBatchProducts
  │    └── background открывает seller.ozon.ru/app/products
  │        → инжектирует content-batch-products.js
  │        → scroll+collect виртуально-скроллируемой таблицы
  │        → получает batchSkusCollected
  │        → запускает launchDuplicates
  └── Проверка из таблицы (NEW v3.5.0)
       └── popup парсит XLSX локально через libs/xlsx-reader.js
           → извлекает SKU из колонки B
           → фильтрует по статусу
           → запускает launchDuplicates

[Service Worker] processDuplicateSku(index) цикл:
  ├── Проверить isPaused → если да, ждать
  ├── Открыть/переиспользовать вкладку www.ozon.ru/product/{SKU}
  ├── Инжектировать content-duplicates.js
  ├── Отправить startDuplicateScan
  ├── Ждать duplicatePageResult
  └── Задержка → следующий SKU

[Content Duplicates] 4 стратегии:
  1. data-widget секции (Similar/Seller/Offer/Cheaper)
  2. Текстовые секции (есть дешевле/другие продавцы)
  3. Все product-ссылки (кроме навигации)
  4. Поиск по виджетам
```

## Счётчики строк (актуально для v3.5.0)

| Файл | Строк |
|------|-------|
| content/content.js | ~1743 |
| popup/popup.css | ~1237 |
| popup/popup.js | ~1244 |
| content/content-products.js | ~879 |
| background/service-worker.js | ~732 |
| content/content-duplicates.js | ~641 |
| popup/popup.html | ~534 |
| content/content-batch-products.js | ~473 |
| libs/xlsx-reader.js | ~237 |
| content/content.css | ~191 |
| options/options.html | 78 |
| **Итого** | **~7989** |

## Известные особенности

- React 17+ на OZON — нужны PointerEvents для кликов (simulateRealClick)
- Textarea может быть в Shadow DOM (deepQuerySelector)
- Multi-step wizard жалобы — handleComplaintReasonStep
- MIN_COOLDOWN_MS = 10с, jitter 0-5с
- Файл загружается через DataTransfer API, ожидание 8с
- Плавающая панель исключается из поиска кнопок (#obg-float-panel)
- Content scripts инжектятся программно, `allFrames: false` (не через matches в manifest)
- switchToBrandCabinet() требует MAIN world для доступа к DOM
- Batch collection: тройная защита от двойной инъекции (window flag + DOM guard + isCollecting)
- Tech logs: отдельный ключ `obgTechLog`, лимит 500 записей
- Виртуальный скроллинг: таблица товаров рендерит ~9-10 строк из ~36 в DOM одновременно
- XLSX парсер: использует DecompressionStream API (Chrome 80+), парсит ZIP + XML локально
