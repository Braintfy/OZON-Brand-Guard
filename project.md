# OZON Brand Guard — Project Map

> Обновляется после каждого изменения вместе с CHANGELOG.md
> Последнее обновление: 2026-03-12 | Версия: 2.0.0

## Архитектура

```
Chrome Extension (Manifest V3)
├── popup/          — UI расширения (4 вкладки: Главная, Настройки, Жалобы, Инфо)
├── content/        — Content script (работает на странице OZON)
├── background/     — Service Worker (планировщик, логи, relay сообщений)
├── options/        — Страница расширенных настроек (статичная)
├── assets/         — Иконки (SVG щит + PNG 16/48/128)
└── _locales/       — Локализация (ru, en)
```

## Файлы и их роли

### manifest.json
- **Manifest V3**, version `1.4.0`
- Permissions: `storage`, `alarms`, `notifications`, `activeTab`, `scripting`, `tabs`
- Host: `https://seller.ozon.ru/*`
- Content script инжектится ТОЛЬКО на: `https://seller.ozon.ru/app/brand/sellers*`
- Popup: `popup/popup.html`
- Background: `background/service-worker.js`

### background/service-worker.js (158 строк)
- **Message hub** — принимает сообщения от content и popup, relay между ними
- **Actions**: `getStatus`, `setRunning`, `updateSchedule`, `logComplaint`, `showNotification`, `getConfig`
- **Relay actions**: `scanBrandsResult`, `updateStats`, `done`, `logUpdate`, `techLog`
- **Scheduling**: `chrome.alarms` для автозапуска (1/3/6/12/24ч)
- **Logging**: `addLogEntry()` — сохраняет в `chrome.storage.local`, лимит **5000** записей
- **Alarm handler**: находит/создаёт вкладку sellers и отправляет `start`

### content/content.js (1713 строк) — ГЛАВНЫЙ ФАЙЛ
Работает на `seller.ozon.ru/app/brand/sellers*`. IIFE с guard `__obgContentLoaded`.

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
| `findComplainButtonWithRetry()` | 882-908 | 5 попыток найти "Пожаловаться" |
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
2. `findComplainButtonWithRetry()` — ищем "Пожаловаться на продавца"
3. `simulateRealClick(complainButton)` — открываем sidebar
4. `findTextareaInModal()` — ищем textarea (8 попыток)
5. `setInputValueSmart(textarea, text)` — заполняем текст
6. `attachFile(brand)` — прикрепляем файл + ожидание 8с
7. `findSubmitButton()` + `simulateRealClick(submitButton)` — отправляем
8. `waitCooldown()` — задержка + jitter

### content/content.css (192 строки)
- `.obg-overlay`, `.obg-panel` — стили модального окна
- `.obg-violator-row` — красная подсветка строки нарушителя
- `.obg-whitelisted-row` — зелёная подсветка разрешённого
- `.obg-badge--violator`, `.obg-badge--safe` — бейджи

### popup/popup.html (367 строк)
6 вкладок: Главная | Бренды | Whitelist | Настройки | Жалобы | Инфо
- **Главная**: режим, задержка (10-300с, default 20), start/stop, stats, расписание
- **Бренды**: автопоиск + список с template (name, complaint, file)
- **Whitelist**: список + input + фильтр по странам (CN/TR/KR/IN)
- **Настройки**: default complaint, dry run, notifications, export/import, clear/reset
- **Жалобы**: sub-tabs (Результаты: table + export CSV/Excel/TXT | Техническая: dark console)
- **Инфо**: 5 шагов + совместимость
- Footer: `v1.4.0 by firayzer`

### popup/popup.js (696 строк)
- `DEFAULT_CONFIG`: brands[], whitelist[{value,type}], bannedCountries['CN'], delaySeconds:20
- `MAX_LOG_ENTRIES = 5000`
- `renderBrands()` — red highlight `brand-item--no-file` если нет fileData
- `renderLog()` — table с tbody, count X/5000
- `renderTechLog()` — тёмная консоль, color-coded lines
- Export: `exportCSV()` (BOM+`;`), `exportExcel()` (HTML table .xls), `exportTXT()` (fixed-width)
- Sub-tabs: `.sub-tab` → `#subtab-complaints` / `#subtab-technical`
- Message listener: `updateStats`, `done`, `logUpdate`, `techLog`, `scanBrandsResult`
- `ensureContentScript()` — `chrome.scripting.executeScript/insertCSS`
- `ensureOzonPage(targetUrl, urlCheck)` — универсальная авто-навигация на любую страницу OZON
- `ensureSellersPage()` → `ensureOzonPage('…/brand/sellers', …)`
- `ensureProductsPage()` → `ensureOzonPage('…/brand-products/all', …)`
- `ensureProductContentScript()` — инжект `content-products.js`
- `waitForTabLoad()` — ожидание `chrome.tabs.onUpdated` status=complete + 2с SPA render, таймаут 15с
- `renderProductSettings()` — productComplaintText, productFileName

### content/content-products.js (~580 строк) — МОДУЛЬ ТОВАРОВ
Работает на `seller.ozon.ru/app/brand-products/*`. IIFE с guard `__obgProductsLoaded`.

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
| `findComplainButtonInDOM()` | Ищет "Пожаловаться" (не "Пожаловаться на продавца") |

#### Отличия от sellers:
- Messages: `startProducts`/`stopProducts`/`doneProducts`/`updateProductStats`
- Панель: оранжевая тема (`#e65100`)
- Лог-префикс: `[OBG-P]`, `[Товар]`
- Кнопка меню: текст "Пожаловаться" (без "на продавца")
- Фильтр: по whitelist seller name (не по стране)
- Config: `productComplaintText`, `productFileData`, `productFileName`

### popup/popup.css (730+ строк)
Ключевые блоки: tabs, cards, inputs, brand-item, file-upload, stats, log-header, sub-tabs, log-table, log-export, tech-log-list, scrollbar, footer

### options/options.html (79 строк)
Статичная страница: инструкция, совместимость, технические детали

## Config (chrome.storage.local → obgConfig)

```js
{
  brands: [{ id, name, complaint, fileData (base64), fileName }],
  whitelist: [{ value, type: 'name'|'inn' }],
  bannedCountries: ['CN'],
  useCountryFilter: true,
  defaultComplaint: 'Продажа подделок на мой бренд',
  productComplaintText: '',           // отдельный текст для жалоб на товары
  productFileData: null,              // base64 файла для товарных жалоб
  productFileName: '',
  skipProductFile: false,             // не прикладывать файл (жалоба на копию карточки)
  delaySeconds: 15,
  productMode: 'scan',               // отдельный режим для товаров
  mode: 'scan' | 'complain',
  dryRun: false,
  scheduleEnabled: false,
  scheduleInterval: 6,
  notificationsEnabled: true,
  log: [{ date, seller, inn, brand, country, success, error? }]
}
```

## Поток сообщений

```
popup.js → chrome.tabs.sendMessage → content.js (start/stop/scanBrands)
content.js → chrome.runtime.sendMessage → service-worker.js (logComplaint/setRunning/techLog/updateStats)
service-worker.js → chrome.runtime.sendMessage → popup.js (relay: techLog/updateStats/done/scanBrandsResult)
```

## Селекторы OZON (sellers page)

| Элемент | Селектор |
|---------|----------|
| Таблица | `table tbody tr` (min 5 td) |
| Name cell | `td[1]` → `.md5-bu7` (name), `.md5-ub7` (inn) |
| Brand cell | `td[2]` |
| Country cell | `td[4]` — текст CN/RU/TR и т.д. |
| Menu ⋮ | Последний `td` → `button` с SVG |
| Пожаловаться | `[role="menuitem"]` с текстом "пожаловаться" |
| Sidebar | div с "Жалоба на" + form/textarea/file input |
| Textarea | `textarea[id^="baseInput"]`, class `r8c110-a2` |
| File input | `input[type="file"][accept=".jpg,.png,.jpeg,.pdf"]` |
| Submit | `form button[type="submit"]` с текстом "Отправить" |
| Pagination | `ul li button` с `data-selected="true"` |

## Известные особенности

- React 17+ на OZON — нужны PointerEvents для кликов
- Textarea может быть в Shadow DOM (deepQuerySelector)
- Multi-step wizard жалобы — handleComplaintReasonStep
- MIN_COOLDOWN_MS = 10с, jitter 0-5с
- Файл загружается через DataTransfer API, ожидание 8с
- Плавающая панель исключается из поиска кнопок (#obg-float-panel)
- Content script инжектится ТОЛЬКО на sellers page (manifest.json matches)
