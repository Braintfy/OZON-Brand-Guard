# OZON Brand Guard — Project Map

> Обновляется после каждого изменения вместе с CHANGELOG.md
> Последнее обновление: 2026-03-15 | Версия: 3.1.1

## Архитектура

```
Chrome Extension (Manifest V3)
├── popup/          — UI расширения (5 вкладок: Дубликаты, Отчёт, Настройки, Бренды, Инфо)
├── content/        — Content scripts (4 скрипта: duplicates, batch-products, sellers, products)
├── background/     — Service Worker (планировщик, логи, relay, навигация дубликатов)
├── options/        — Страница расширенных настроек (статичная)
├── assets/         — Иконки (SVG щит + PNG 16/48/128 + generate-icons.html)
└── _locales/       — Локализация (ru, en)
```

## Файлы и их роли

### manifest.json
- **Manifest V3**, version `3.1.1`
- Permissions: `storage`, `alarms`, `notifications`, `activeTab`, `scripting`, `tabs`
- Host: `https://seller.ozon.ru/*`, `https://www.ozon.ru/*`
- Content scripts инжектятся программно через `chrome.scripting.executeScript`
- Popup: `popup/popup.html`
- Background: `background/service-worker.js`
- Options: `options/options.html`

### background/service-worker.js (~584 строк)
- **Message hub** — принимает сообщения от content и popup, relay между ними
- **Actions**: `getStatus`, `setRunning`, `updateSchedule`, `logComplaint`, `showNotification`, `getConfig`
- **Duplicate Actions**: `launchDuplicates`, `stopDuplicates`, `duplicatePageResult`, `duplicateScanStopped`, `updateDuplicateStats`, `launchCurrentPage`, `launchBatchProducts`, `batchSkusCollected`
- **Relay actions**: `scanBrandsResult`, `updateStats`, `done`, `logUpdate`, `techLog`, `doneDuplicates`, `duplicatePageDone`
- **duplicateScanState**: `{ skus, currentIndex, results, config, tabId }` — состояние последовательного обхода SKU
- **Scheduling**: `chrome.alarms` для автозапуска (ALARM_SELLERS, ALARM_PRODUCTS)
- **Logging**: `addLogEntry()` — сохраняет в `chrome.storage.local`, лимит **5000** записей

#### Ключевые функции service-worker.js

| Функция | Описание |
|---------|----------|
| `navigateInjectStart(url, script, action, config)` | Найти/создать вкладку → инжект скрипта → отправить сообщение |
| `injectAndStart(tabId, scriptFile, action, config)` | Выполнить скрипт + CSS |
| `waitForTabComplete(tabId)` | Ожидание загрузки вкладки (15с таймаут) |
| `switchToBrandCabinet(tabId)` | MAIN world скрипт — клик по «Кабинет бренда» в дропдауне |
| `launchDuplicateSearch(skus, config)` | Точка входа: установить состояние, запустить цикл |
| `processDuplicateSku(index)` | Основной цикл: открыть страницу → инжект → ждать результатов |
| `handleDuplicatePageResult(msg)` | Сохранить результаты, обновить статистику, поставить следующий SKU |
| `stopDuplicateSearch()` | Прервать текущий скан |
| `launchCurrentPageScan()` | Извлечь SKU из URL активной вкладки: `/product/.*?(\d{5,})/` |
| `launchBatchFromProducts(config)` | Открыть страницу товаров, инжектировать batch collector |
| `updateSchedule(config)` | Настройка Chrome alarms для продавцов |
| `updateProductSchedule(config)` | Настройка Chrome alarms для товаров |
| `addLogEntry(entry)` | Сохранить в storage (макс. 5000 записей) |

### content/content-duplicates.js (~610 строк) — МОДУЛЬ ДУБЛИКАТОВ
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
| `showPanel()` | Drag-панель на странице OZON (синяя тема, логи, свернуть/закрыть) |

#### 4 стратегии сбора (по порядку):
1. **data-widget секции** — `[data-widget*="Similar/Seller/Offer/Cheaper"]` (самый надёжный)
2. **Текстовые секции** — поиск заголовков «есть дешевле», «другие продавцы»
3. **Широкий поиск ссылок** — все product-ссылки кроме nav/header/footer
4. **Виджет-парсинг** — финальный резерв через атрибуты `data-widget`

#### Протокол сообщений:
- **Принимает:** `startDuplicateScan { skus[], currentIndex, config }` + `stopDuplicates`
- **Отправляет:** `duplicatePageResult { sku, competitors[], error?, pageIndex, totalSkus }` + `techLog`

### content/content-batch-products.js (~149 строк) — BATCH КОЛЛЕКТОР SKU (NEW v3.1.0)
Работает на `seller.ozon.ru/app/products`. IIFE с guard `#__obg-batch-guard`.

#### Основные функции

| Функция | Описание |
|---------|----------|
| `collectAllSkus()` | Цикл по страницам, накопление SKU, пагинация |
| `parseCurrentPageSkus()` | 3 стратегии: data-widget spans, product links, barcode cells |
| `waitForTable()` | Ожидание `table tbody tr` (30 попыток) |
| `goToNextPage()` | Поиск и клик следующей страницы пагинации (10 попыток) |

#### 3 стратегии извлечения SKU:
1. **data-widget spans** — `[data-widget="@products/list-ods/table/cell/sku-fbs/span"]` → regex `SKU\s+(\d{5,})`
2. **Product links** — `a[data-widget="products-table-row-title-link"]` → href `/product/(\d{5,})`
3. **Barcode cells** — `[data-style="text"]` → regex `OZN(\d{5,})`

#### Протокол сообщений:
- **Принимает:** `collectProductSkus`
- **Отправляет:** `batchSkusCollected { skus[], error? }` + `techLog`
- Guard против двойного запуска: флаг `isCollecting`

### content/content.js (~1743 строк) — LEGACY: МОДУЛЬ ПРОДАВЦОВ
Работает на `seller.ozon.ru/app/brand/sellers*`. IIFE с guard `#__obg-sellers-guard`.

#### Состояние
- `config`, `isRunning`, `shouldStop`, `stats`, `panelEl`, `logLines`

#### Основные функции

| Функция | Строки | Описание |
|---------|--------|----------|
| `safeSend()` | 21-27 | Безопасная отправка сообщений в background |
| `simulateRealClick()` | 31-68 | PointerEvents + MouseEvents + native click для React 17+ |
| `deepQuerySelector/All()` | 71-121 | Поиск через Shadow DOM и iframes |
| **Message listener** | 124-137 | Обработка: `start`, `stop`, `scanBrands` |
| `scanBrandsOnPage()` | 140-308 | Автопоиск брендов (4 стратегии) |
| `startProcess()` | 416-446 | Главная точка входа: stats reset, showPanel, processAllPages |
| `stopProcess()` | 448-459 | Немедленная остановка всех процессов |
| `processAllPages()` | 462-516 | Цикл: парсинг → whitelist check → fileComplaint → next page |
| `parseSellersTable()` | 523-548 | Парсинг таблицы OZON (td[0]=checkbox, td[1]=name, td[2]=brand, td[3]=count, td[4]=country) |
| `extractSellerFromRow()` | 588-628 | Извлечение seller из строки таблицы |
| `parseNameCell()` | 632-669 | 3 стратегии парсинга имени+ИНН |
| `findMenuButton()` | 671-697 | Поиск кнопки ⋮ (три точки) |
| `checkWhitelist()` | 700-710 | Проверка по name/inn |
| `fileComplaint()` | 716-850 | 5 шагов: menu → пожаловаться → textarea → file → submit |
| `findComplainButtonWithRetry()` | 882-908 | 5 попыток найти «Пожаловаться» |
| `findComplainButtonInDOM()` | 910-971 | Specificity scoring, исключение своей панели |
| `findTextareaInModal()` | 1067-1158 | 5 стратегий + 8 попыток |
| `findComplaintSidebar()` | 1287-1336 | 3 стратегии поиска sidebar жалобы |
| `handleComplaintReasonStep()` | 1229-1284 | Multi-step wizard (radio/select/buttons) |
| `attachFile()` | 1019-1062 | base64 → File → DataTransfer → input[type=file] |
| `setInputValueSmart()` | 1339-1360 | React-compatible: contenteditable + native setter |
| `goToNextPage()` | 1420-1470 | Пагинация: data-selected, disabled, next |
| `showPanel()` | 1514-1629 | Плавающая панель: stats, log, drag, minimize, stop |
| `log()` | 1690-1707 | Логирование + techLog relay в popup |

#### Поток работы fileComplaint:
1. `simulateRealClick(menuButton)` — клик ⋮
2. `findComplainButtonWithRetry()` — ищем «Пожаловаться на продавца»
3. `simulateRealClick(complainButton)` — открываем sidebar
4. `findTextareaInModal()` — ищем textarea (8 попыток)
5. `setInputValueSmart(textarea, text)` — заполняем текст
6. `attachFile(brand)` — прикрепляем файл + ожидание 8с
7. `findSubmitButton()` + `simulateRealClick(submitButton)` — отправляем
8. `waitCooldown()` — задержка + jitter

### content/content-products.js (~879 строк) — МОДУЛЬ ТОВАРОВ
Работает на `seller.ozon.ru/app/brand-products/*`. IIFE с guard `#__obg-products-guard`.

#### Таблица товаров (7 колонок)

| Index | Содержимое | Извлечение |
|-------|-----------|------------|
| td[0] | Название + SKU + картинка | `[title]`, `a[href*="ozon.ru"]`, `[class*="label"]` → SKU |
| td[1] | Дата создания | `[title]` |
| td[2] | Бренд | `[title]` |
| td[3] | Продавец | `[title]` — используется для whitelist фильтра |
| td[4] | Цена покупателя | textContent |
| td[5] | Цена продавца | `[title]` |
| td[6] | Меню ⋮ | `button` с SVG |

#### Основные функции

| Функция | Описание |
|---------|----------|
| `parseProductsTable()` | Парсинг таблицы товаров |
| `extractProductFromRow()` | Извлечение: name, sku, link, brand, seller, date, price, menuButton |
| `checkWhitelist(sellerName)` | Проверка продавца по whitelist (name only) |
| `fileProductComplaint()` | Полный цикл: menu → Пожаловаться → textarea → file → submit |
| `getProductComplaintText()` | Приоритет: productComplaintText → brand.complaint → defaultComplaint |
| `findComplainButtonInDOM()` | Ищет «Пожаловаться» (не «Пожаловаться на продавца») |

#### Отличия от sellers:
- Messages: `startProducts`/`stopProducts`/`doneProducts`/`updateProductStats`
- Панель: оранжевая тема (`#e65100`)
- Лог-префикс: `[OBG-P]`, `[Товар]`
- Кнопка меню: текст «Пожаловаться» (без «на продавца»)
- Фильтр: по whitelist seller name (не по стране)
- Config: `productComplaintText`, `productFileData`, `productFileName`

### content/content.css (192 строки)
- `.obg-overlay`, `.obg-panel` — стили плавающей панели (drag)
- `.obg-panel--orange` — оранжевая тема для товаров
- `.obg-violator-row` — красная подсветка нарушителя
- `.obg-whitelisted-row` — зелёная подсветка разрешённого
- `.obg-badge--violator`, `.obg-badge--safe` — бейджи

### popup/popup.html (~492 строк)
5 вкладок: Дубликаты | Отчёт | Настройки | Бренды (legacy) | Инфо
- **Дубликаты**: 3 стратегии сбора (ручной ввод, текущая страница, batch), прогресс-бар, быстрые результаты, копирование SKU + Excel
- **Отчёт**: таблица дубликатов + группировка по продавцам + export Excel/CSV + техлог
- **Настройки**: вайтлист (SKU/продавец/ИНН), экспорт/импорт данных, задержка
- **Бренды (legacy)**: deprecated notice + полный старый функционал (продавцы, товары, жалобы, бренды, whitelist, расписание)
- **Инфо**: 3 шага поиска дубликатов + советы + совместимость
- Footer: `v3.1.1 by firayzer`

### popup/popup.js (~995 строк)
- `DEFAULT_CONFIG`: brands[], whitelist[], duplicateWhitelist[], duplicateDelay:3, lastDuplicateResults[], savedSkuInput
- `MAX_LOG_ENTRIES = 5000`
- `renderBrands()` — red highlight `brand-item--no-file` если нет fileData
- `renderLog()` — table с tbody, count X/5000
- `renderTechLog()` — тёмная консоль, color-coded lines
- Export: `exportCSV()` (BOM+`;`), `exportExcel()` (HTML table .xls)
- Sub-tabs: `.sub-tab` → `#subtab-table` / `#subtab-sellers` / `#subtab-technical`
- Message listener: `updateStats`, `done`, `logUpdate`, `techLog`, `scanBrandsResult`, `duplicatePageDone`, `doneDuplicates`
- `ensureContentScript()` — `chrome.scripting.executeScript/insertCSS`
- `ensureOzonPage(targetUrl, urlCheck)` — универсальная авто-навигация на любую страницу OZON
- `ensureSellersPage()` → `ensureOzonPage('…/brand/sellers', …)`
- `ensureProductsPage()` → `ensureOzonPage('…/brand-products/all', …)`
- `waitForTabLoad()` — ожидание `chrome.tabs.onUpdated` status=complete + 2с SPA render, таймаут 15с
- `launchDuplicateSearch()` — передать SKU в background для обработки
- `saveTechLogs()` / `loadTechLogs()` — персист в `obgTechLog` (макс. 500 записей)

### popup/popup.css (~1146 строк)
Ключевые блоки: tabs, cards, inputs, brand-item, file-upload, stats, log-header, sub-tabs, log-table, log-export, tech-log-list, dup-progress, dup-quick-list, dup-group, scrollbar, footer

### options/options.html (79 строк)
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

**Tech logs:** хранятся отдельно в `obgTechLog` (до 500 записей)

## Поток сообщений

```
popup.js → chrome.tabs.sendMessage → content.js (start/stop/scanBrands)
content.js → chrome.runtime.sendMessage → service-worker.js (logComplaint/setRunning/techLog/updateStats)
service-worker.js → chrome.runtime.sendMessage → popup.js (relay: techLog/updateStats/done/scanBrandsResult)

popup.js → chrome.runtime.sendMessage → service-worker.js (launchDuplicates/stopDuplicates/launchCurrentPage/launchBatchProducts)
service-worker.js → chrome.tabs.sendMessage → content-duplicates.js (startDuplicateScan)
content-duplicates.js → chrome.runtime.sendMessage → service-worker.js (duplicatePageResult)
service-worker.js → chrome.runtime.sendMessage → popup.js (relay: duplicatePageDone/doneDuplicates/updateDuplicateStats)

service-worker.js → chrome.tabs.sendMessage → content-batch-products.js (collectProductSkus)
content-batch-products.js → chrome.runtime.sendMessage → service-worker.js (batchSkusCollected)
```

## Архитектура поиска дубликатов (v3.0+)

```
[Popup] 3 стратегии запуска:
  ├── Ручной ввод SKU → launchDuplicates
  ├── Текущая страница → launchCurrentPage → background извлекает SKU из URL
  └── Batch с товаров → launchBatchProducts
       └── background открывает seller.ozon.ru/app/products
           → инжектирует content-batch-products.js
           → получает batchSkusCollected
           → запускает launchDuplicates

[Service Worker] processDuplicateSku(index) цикл:
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

## Селекторы OZON (sellers page)

| Элемент | Селектор |
|---------|----------|
| Таблица | `table tbody tr` (min 5 td) |
| Name cell | `td[1]` → `.md5-bu7` (name), `.md5-ub7` (inn) |
| Brand cell | `td[2]` |
| Country cell | `td[4]` — текст CN/RU/TR и т.д. |
| Menu ⋮ | Последний `td` → `button` с SVG |
| Пожаловаться | `[role="menuitem"]` с текстом «пожаловаться» |
| Sidebar | div с «Жалоба на» + form/textarea/file input |
| Textarea | `textarea[id^="baseInput"]`, class `r8c110-a2` |
| File input | `input[type="file"][accept=".jpg,.png,.jpeg,.pdf"]` |
| Submit | `form button[type="submit"]` с текстом «Отправить» |
| Pagination | `ul li button` с `data-selected="true"` |

## Счётчики строк (актуально для v3.1.1)

| Файл | Строк |
|------|-------|
| content/content.js | ~1743 |
| popup/popup.css | ~1146 |
| content/content-products.js | ~879 |
| popup/popup.js | ~995 |
| popup/popup.html | ~492 |
| background/service-worker.js | ~584 |
| content/content-duplicates.js | ~610 |
| content/content-batch-products.js | ~149 |
| content/content.css | ~192 |
| options/options.html | 79 |
| **Итого** | **~6869** |

## Известные особенности

- React 17+ на OZON — нужны PointerEvents для кликов (simulateRealClick)
- Textarea может быть в Shadow DOM (deepQuerySelector)
- Multi-step wizard жалобы — handleComplaintReasonStep
- MIN_COOLDOWN_MS = 10с, jitter 0-5с
- Файл загружается через DataTransfer API, ожидание 8с
- Плавающая панель исключается из поиска кнопок (#obg-float-panel)
- Content scripts инжектятся программно (не через matches в manifest)
- switchToBrandCabinet() требует MAIN world для доступа к DOM
- Batch collection: guard `isCollecting` предотвращает двойной запуск (v3.1.1 fix)
- Tech logs: отдельный ключ `obgTechLog`, лимит 500 записей
