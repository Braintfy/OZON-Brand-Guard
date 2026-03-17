# TODOS

## P2: Тестовая инфраструктура для content-duplicates.js
**What:** Создать базовую тестовую инфраструктуру с mock-фикстурами DOM OZON для `content/content-duplicates.js`.
**Why:** 3 сломанных релиза подряд (v4.0.0, v4.0.1) из-за отсутствия тестов. Каждое изменение — слепое.
**How:** Jest/Vitest + JSDOM фикстуры: сохранить HTML-снапшоты реальных OZON product-страниц (секции «Другие продавцы», виджеты, карусели). Тестировать `extractSkuFromUrl()`, `parseProductCards()`, `findCompetitorSections()`, `applyWhitelist()`.
**Effort:** M
**Depends on:** Ничего — можно начать в любой момент.
