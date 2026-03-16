// OZON Brand Guard — Minimal XLSX Reader
// Парсит файл «Цены товаров» из seller.ozon.ru и извлекает SKU
// Использует DecompressionStream API (Chrome 80+)

/**
 * Читает XLSX-файл и возвращает массив SKU.
 * @param {ArrayBuffer} buffer — содержимое .xlsx файла
 * @returns {Promise<{skus: string[], total: number, filtered: number}>}
 */
async function readXlsxSkus(buffer) {
  const files = await unzipFiles(buffer);

  // Парсинг shared strings
  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml']);

  // Ищем лист с данными — sheet2 (стандарт OZON), или первый лист с заголовком «SKU»
  const sheetKeys = Object.keys(files)
    .filter(k => k.startsWith('xl/worksheets/sheet') && k.endsWith('.xml'))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/sheet(\d+)/)?.[1] || '0');
      return nb - na; // sheet2 first (larger number first), then sheet1
    });

  for (const key of sheetKeys) {
    const result = parseSheetSkus(files[key], sharedStrings);
    if (result.skus.length > 0) return result;
  }

  return { skus: [], total: 0, filtered: 0 };
}

// ── ZIP Parser ──

async function unzipFiles(buffer) {
  const view = new DataView(buffer);
  const files = {};
  let offset = 0;

  while (offset + 30 < buffer.byteLength) {
    // Local file header signature
    if (view.getUint32(offset, true) !== 0x04034b50) break;

    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    let compSize = view.getUint32(offset + 18, true);
    const uncompSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const hasDataDesc = (flags & 0x08) !== 0;

    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 30, nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;

    // Если размер 0 и есть data descriptor — ищем следующий заголовок
    if (hasDataDesc && compSize === 0) {
      // Ищем следующий local file header или central directory
      let searchPos = dataStart;
      while (searchPos + 4 < buffer.byteLength) {
        const sig = view.getUint32(searchPos, true);
        if (sig === 0x04034b50 || sig === 0x02014b50) break;
        searchPos++;
      }
      // Data descriptor может быть 12 или 16 байт перед следующим заголовком
      // Попробуем оба варианта
      const possibleEnd16 = searchPos - 16;
      const possibleEnd12 = searchPos - 12;
      if (possibleEnd16 > dataStart && view.getUint32(possibleEnd16, true) === 0x08074b50) {
        compSize = view.getUint32(possibleEnd16 + 8, true);
      } else if (possibleEnd12 > dataStart) {
        compSize = searchPos - dataStart - 12;
        if (compSize < 0) compSize = searchPos - dataStart;
      } else {
        compSize = searchPos - dataStart;
      }
    }

    if (name.endsWith('.xml') && compSize > 0) {
      const rawData = new Uint8Array(buffer, dataStart, compSize);

      if (method === 0) {
        // Stored (no compression)
        files[name] = new TextDecoder().decode(rawData);
      } else if (method === 8) {
        // Deflated
        try {
          files[name] = await inflateData(rawData);
        } catch (e) {
          console.warn('[XLSX] inflate error for', name, e);
        }
      }
    }

    offset = dataStart + compSize;

    // Skip data descriptor if present
    if (hasDataDesc) {
      if (offset + 4 < buffer.byteLength && view.getUint32(offset, true) === 0x08074b50) {
        offset += 16; // signature(4) + crc(4) + compSize(4) + uncompSize(4)
      } else if (offset + 12 <= buffer.byteLength) {
        offset += 12; // crc(4) + compSize(4) + uncompSize(4)
      }
    }
  }

  return files;
}

async function inflateData(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();

  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return new TextDecoder().decode(result);
}

// ── XML Parsers ──

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const strings = [];

  for (const si of doc.getElementsByTagNameNS(ns, 'si')) {
    const parts = [];
    for (const t of si.getElementsByTagNameNS(ns, 't')) {
      if (t.textContent) parts.push(t.textContent);
    }
    strings.push(parts.join(''));
  }

  return strings;
}

function parseSheetSkus(xml, sharedStrings) {
  if (!xml) return { skus: [], total: 0, filtered: 0 };

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rows = doc.getElementsByTagNameNS(ns, 'row');

  // 1) Найти строку-заголовок (row 1-4) с ячейкой «SKU»
  let skuCol = null;
  let statusCol = null;
  let headerRow = -1;

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    const rowNum = parseInt(row.getAttribute('r'));
    if (rowNum > 4) break;

    for (const cell of row.getElementsByTagNameNS(ns, 'c')) {
      const val = getCellValue(cell, sharedStrings);
      const col = cell.getAttribute('r').replace(/\d+/g, '');
      if (val === 'SKU') { skuCol = col; headerRow = rowNum; }
      if (val === 'Статус') { statusCol = col; }
    }
  }

  if (!skuCol) return { skus: [], total: 0, filtered: 0 };

  // 2) Данные начинаются через 2 строки после заголовка (заголовок + подзаголовок + пустая)
  const dataStartRow = headerRow + 3; // row2=header → row5=data (skip row3 "Нередактируемое", row4 empty)

  const skus = [];
  let total = 0;
  let filtered = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = parseInt(row.getAttribute('r'));
    if (rowNum < dataStartRow) continue;

    let skuVal = '';
    let statusVal = '';

    for (const cell of row.getElementsByTagNameNS(ns, 'c')) {
      const ref = cell.getAttribute('r');
      const col = ref.replace(/\d+/g, '');
      if (col === skuCol) skuVal = getCellValue(cell, sharedStrings).trim();
      if (statusCol && col === statusCol) statusVal = getCellValue(cell, sharedStrings).trim();
    }

    if (!skuVal) continue;

    // SKU может быть числом или строкой с числом
    const cleaned = skuVal.replace(/[^\d]/g, '');
    if (cleaned.length < 5) continue;

    total++;

    // Фильтр по статусу — пропускаем неактивные
    const lowerStatus = statusVal.toLowerCase();
    if (lowerStatus.includes('не продается') || lowerStatus.includes('не продаётся') ||
        lowerStatus.includes('убран из продажи') || lowerStatus.includes('заблокирован') ||
        lowerStatus.includes('архив')) {
      filtered++;
      continue;
    }

    skus.push(cleaned);
  }

  return { skus, total, filtered };
}

function getCellValue(cell, sharedStrings) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const type = cell.getAttribute('t');
  const vElem = cell.getElementsByTagNameNS(ns, 'v')[0];
  if (!vElem || !vElem.textContent) return '';

  if (type === 's') {
    const idx = parseInt(vElem.textContent);
    return (idx >= 0 && idx < sharedStrings.length) ? sharedStrings[idx] : '';
  }

  return vElem.textContent;
}
