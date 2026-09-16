// Разбор шрифта TrueType.
//
// Нужен для отчётов в PDF: в PDF нельзя просто написать русский текст
// стандартным шрифтом — кириллицы в нём нет. Шрифт приходится вкладывать
// в сам файл, причём в виде номеров начертаний (глифов), а не букв.
//
// Здесь ровно столько разбора, сколько для этого требуется:
//  - таблица cmap — какая буква каким глифом рисуется;
//  - таблица hmtx — ширина каждого глифа, чтобы считать длину строки;
//  - таблицы glyf/loca — сами очертания букв, чтобы вырезать из шрифта
//    только использованные и не таскать в каждый отчёт лишние 400 КБ.

function tag(buffer, offset) {
  return buffer.toString('latin1', offset, offset + 4);
}

export function readFont(buffer) {
  const numTables = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    tables.set(tag(buffer, record), {
      offset: buffer.readUInt32BE(record + 8),
      length: buffer.readUInt32BE(record + 12),
    });
  }
  const need = ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap'];
  for (const name of need) {
    if (!tables.has(name)) throw new Error(`В шрифте нет таблицы ${name}`);
  }

  const head = tables.get('head').offset;
  const font = {
    buffer,
    tables,
    unitsPerEm: buffer.readUInt16BE(head + 18),
    indexToLocFormat: buffer.readInt16BE(head + 50),
    bbox: [
      buffer.readInt16BE(head + 36), buffer.readInt16BE(head + 38),
      buffer.readInt16BE(head + 40), buffer.readInt16BE(head + 42),
    ],
    ascent: buffer.readInt16BE(tables.get('hhea').offset + 4),
    descent: buffer.readInt16BE(tables.get('hhea').offset + 6),
    numberOfHMetrics: buffer.readUInt16BE(tables.get('hhea').offset + 34),
    numGlyphs: buffer.readUInt16BE(tables.get('maxp').offset + 4),
  };
  font.cmap = readCmap(buffer, tables.get('cmap').offset);
  font.loca = readLoca(font);
  return font;
}

// Из всех вариантов cmap берём подтаблицу Unicode: формат 4 покрывает
// латиницу и кириллицу, формат 12 — всё остальное.
function readCmap(buffer, base) {
  const count = buffer.readUInt16BE(base + 2);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const rec = base + 4 + i * 8;
    const platform = buffer.readUInt16BE(rec);
    const encoding = buffer.readUInt16BE(rec + 2);
    const offset = base + buffer.readUInt32BE(rec + 4);
    const format = buffer.readUInt16BE(offset);
    const unicode = platform === 3 ? (encoding === 1 || encoding === 10) : platform === 0;
    if (!unicode) continue;
    if (format === 12) return readCmap12(buffer, offset);
    if (format === 4 && !best) best = offset;
  }
  if (best === null) throw new Error('В шрифте нет подходящей таблицы cmap');
  return readCmap4(buffer, best);
}

function readCmap4(buffer, offset) {
  const map = new Map();
  const segCount = buffer.readUInt16BE(offset + 6) / 2;
  const endBase = offset + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;

  for (let seg = 0; seg < segCount; seg += 1) {
    const end = buffer.readUInt16BE(endBase + seg * 2);
    const start = buffer.readUInt16BE(startBase + seg * 2);
    const delta = buffer.readInt16BE(deltaBase + seg * 2);
    const rangeOffset = buffer.readUInt16BE(rangeBase + seg * 2);
    if (start === 0xffff) continue;
    for (let code = start; code <= end && code !== 0x10000; code += 1) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const at = rangeBase + seg * 2 + rangeOffset + (code - start) * 2;
        if (at + 1 >= buffer.length) continue;
        glyph = buffer.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) map.set(code, glyph);
    }
  }
  return map;
}

function readCmap12(buffer, offset) {
  const map = new Map();
  const groups = buffer.readUInt32BE(offset + 12);
  for (let i = 0; i < groups; i += 1) {
    const rec = offset + 16 + i * 12;
    const start = buffer.readUInt32BE(rec);
    const end = buffer.readUInt32BE(rec + 4);
    const startGlyph = buffer.readUInt32BE(rec + 8);
    for (let code = start; code <= end; code += 1) map.set(code, startGlyph + (code - start));
  }
  return map;
}

function readLoca(font) {
  const { buffer, tables, numGlyphs, indexToLocFormat } = font;
  const base = tables.get('loca').offset;
  const loca = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i += 1) {
    loca[i] = indexToLocFormat === 0
      ? buffer.readUInt16BE(base + i * 2) * 2
      : buffer.readUInt32BE(base + i * 4);
  }
  return loca;
}

export function glyphFor(font, code) {
  return font.cmap.get(code) ?? 0;
}

// Ширина глифа в тысячных долях кегля — в таких единицах их ждёт PDF.
export function glyphWidth(font, glyph) {
  const base = font.tables.get('hmtx').offset;
  const index = Math.min(glyph, font.numberOfHMetrics - 1);
  const advance = font.buffer.readUInt16BE(base + index * 4);
  return Math.round((advance * 1000) / font.unitsPerEm);
}

// Составное начертание (например, «й») собрано из других глифов.
// Их тоже нужно забрать в урезанный шрифт, иначе буква пропадёт.
function componentsOf(font, glyph) {
  const start = font.loca[glyph];
  const end = font.loca[glyph + 1];
  if (end <= start) return [];
  const base = font.tables.get('glyf').offset + start;
  if (font.buffer.readInt16BE(base) >= 0) return [];

  const parts = [];
  let at = base + 10;
  for (;;) {
    const flags = font.buffer.readUInt16BE(at);
    parts.push(font.buffer.readUInt16BE(at + 2));
    at += 4;
    at += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) at += 2;
    else if (flags & 0x0040) at += 4;
    else if (flags & 0x0080) at += 8;
    if (!(flags & 0x0020)) break;
  }
  return parts;
}

export function expandGlyphs(font, glyphs) {
  const result = new Set([0]);
  const queue = [...glyphs];
  while (queue.length) {
    const glyph = queue.pop();
    if (glyph >= font.numGlyphs || result.has(glyph)) continue;
    result.add(glyph);
    for (const part of componentsOf(font, glyph)) queue.push(part);
  }
  return [...result].sort((a, b) => a - b);
}

// ------------------------------------------------------------- урезание

// Собирает из шрифта уменьшенную копию: только те начертания, которые
// встретились в отчёте. Нумерация глифов при этом сохраняется — так
// составные буквы продолжают ссылаться на свои части, а PDF может
// обращаться к глифам напрямую, без таблицы перевода.
export function subsetFont(font, glyphList) {
  const keep = new Set(expandGlyphs(font, glyphList));
  const glyfBase = font.tables.get('glyf').offset;

  const pieces = [];
  const offsets = new Array(font.numGlyphs + 1);
  let at = 0;
  for (let glyph = 0; glyph < font.numGlyphs; glyph += 1) {
    offsets[glyph] = at;
    if (!keep.has(glyph)) continue;
    const start = font.loca[glyph];
    const end = font.loca[glyph + 1];
    if (end <= start) continue;
    const data = font.buffer.subarray(glyfBase + start, glyfBase + end);
    const padded = data.length % 4 === 0 ? data.length : data.length + (4 - (data.length % 4));
    const chunk = Buffer.alloc(padded);
    data.copy(chunk);
    pieces.push(chunk);
    at += padded;
  }
  offsets[font.numGlyphs] = at;

  const glyf = Buffer.concat(pieces);
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  for (let i = 0; i <= font.numGlyphs; i += 1) loca.writeUInt32BE(offsets[i], i * 4);

  // В заголовке остаётся указать, что смещения теперь длинные (по 4 байта).
  const source = font.tables.get('head');
  const head = Buffer.from(font.buffer.subarray(source.offset, source.offset + source.length));
  head.writeInt16BE(1, 50);
  head.writeUInt32BE(0, 8); // контрольную сумму файла не пересчитываем

  const copy = (name) => {
    const table = font.tables.get(name);
    return Buffer.from(font.buffer.subarray(table.offset, table.offset + table.length));
  };

  return buildSfnt([
    ['head', head],
    ['hhea', copy('hhea')],
    ['maxp', copy('maxp')],
    ['hmtx', copy('hmtx')],
    ['loca', loca],
    ['glyf', glyf],
  ]);
}

function checksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    sum = (sum + buffer.readUInt32BE(i)) >>> 0;
  }
  return sum;
}

function buildSfnt(entries) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const count = sorted.length;
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  const power = 2 ** Math.floor(Math.log2(count));
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(count * 16 - power * 16, 10);

  const body = [];
  let offset = header.length;
  sorted.forEach(([name, data], index) => {
    const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    const record = 12 + index * 16;
    header.write(name, record, 4, 'latin1');
    header.writeUInt32BE(checksum(padded), record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(data.length, record + 12);
    body.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...body]);
}
