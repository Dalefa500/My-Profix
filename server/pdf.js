// Сборка PDF вручную, без сторонних библиотек.
//
// Отчёт нужен такой, чтобы его можно было открыть на телефоне и сразу
// переслать клиенту или сотруднику. Поэтому файл собирается на сервере
// и отдаётся готовым.
//
// Кириллица в PDF требует вложенного шрифта: текст пишется не буквами,
// а номерами начертаний (см. server/ttf.js). Чтобы текст всё же можно
// было выделить и скопировать, рядом кладётся таблица обратного
// перевода — ToUnicode.

import { deflateSync } from 'node:zlib';
import { readFont, subsetFont, glyphFor, glyphWidth } from './ttf.js';

const PAGE = { width: 595.28, height: 841.89 }; // A4 в типографских точках

// Заголовок документа хранится в UTF-16 — иначе русские буквы
// в свойствах файла превращаются в мусор.
function pdfString(value) {
  const text = String(value ?? '');
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i += 1) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

class FontSlot {
  constructor(buffer, name) {
    this.font = readFont(buffer);
    this.name = name;
    this.used = new Map(); // глиф -> код буквы, для ToUnicode
  }

  // Переводит строку в последовательность номеров глифов.
  encode(text) {
    let hex = '';
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      const glyph = glyphFor(this.font, code);
      this.used.set(glyph, code);
      hex += glyph.toString(16).padStart(4, '0');
    }
    return hex;
  }

  width(text, size) {
    let total = 0;
    for (const ch of String(text)) {
      total += glyphWidth(this.font, glyphFor(this.font, ch.codePointAt(0)));
    }
    return (total * size) / 1000;
  }
}

export class Pdf {
  constructor({ regular, bold, title = '', author = '' }) {
    this.fonts = { regular: new FontSlot(regular, 'F1'), bold: new FontSlot(bold, 'F2') };
    this.title = title;
    this.author = author;
    this.pages = [];
    this.ops = [];
    this.addPage();
  }

  addPage() {
    if (this.ops.length) this.pages.push(this.ops.join('\n'));
    this.ops = [];
    return this;
  }

  get pageCount() {
    return this.pages.length + 1;
  }

  // Во всём отчёте координаты считаются сверху вниз — так удобнее верстать.
  // Пересчёт в систему PDF (снизу вверх) происходит здесь.
  text(x, y, value, { size = 10, font = 'regular', color = [0, 0, 0], align = 'left', width = 0 } = {}) {
    const slot = this.fonts[font] || this.fonts.regular;
    const str = String(value ?? '');
    if (!str) return this;
    let left = x;
    if (align === 'right') left = x + width - slot.width(str, size);
    else if (align === 'center') left = x + (width - slot.width(str, size)) / 2;
    const [r, g, b] = color;
    this.ops.push(
      `BT ${r} ${g} ${b} rg /${slot.name} ${size} Tf`
      + ` 1 0 0 1 ${left.toFixed(2)} ${(PAGE.height - y).toFixed(2)} Tm`
      + ` <${slot.encode(str)}> Tj ET`,
    );
    return this;
  }

  widthOf(value, size, font = 'regular') {
    return (this.fonts[font] || this.fonts.regular).width(String(value ?? ''), size);
  }

  // Обрезает строку по ширине колонки, чтобы длинное название
  // не наезжало на соседний столбец.
  fit(value, size, maxWidth, font = 'regular') {
    const str = String(value ?? '');
    if (this.widthOf(str, size, font) <= maxWidth) return str;
    let cut = str;
    while (cut.length > 1 && this.widthOf(`${cut}…`, size, font) > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut.trim()}…`;
  }

  line(x1, y1, x2, y2, { color = [0.8, 0.8, 0.8], width = 0.5 } = {}) {
    const [r, g, b] = color;
    this.ops.push(
      `${width} w ${r} ${g} ${b} RG ${x1.toFixed(2)} ${(PAGE.height - y1).toFixed(2)} m`
      + ` ${x2.toFixed(2)} ${(PAGE.height - y2).toFixed(2)} l S`,
    );
    return this;
  }

  rect(x, y, w, h, { color = [0.95, 0.95, 0.95] } = {}) {
    const [r, g, b] = color;
    this.ops.push(
      `${r} ${g} ${b} rg ${x.toFixed(2)} ${(PAGE.height - y - h).toFixed(2)}`
      + ` ${w.toFixed(2)} ${h.toFixed(2)} re f`,
    );
    return this;
  }

  build() {
    this.addPage();
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    const pageIds = [];
    const contentIds = this.pages.map((content) => {
      const packed = deflateSync(Buffer.from(content, 'latin1'));
      return add(Buffer.concat([
        Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        packed,
        Buffer.from('\nendstream', 'latin1'),
      ]));
    });

    const fontIds = {};
    for (const key of ['regular', 'bold']) fontIds[key] = this.buildFont(this.fonts[key], add);

    const pagesId = objects.length + this.pages.length + 1;
    this.pages.forEach((_, index) => {
      pageIds.push(add(
        `<< /Type /Page /Parent ${pagesId} 0 R`
        + ` /MediaBox [0 0 ${PAGE.width} ${PAGE.height}]`
        + ` /Resources << /Font << /F1 ${fontIds.regular} 0 R /F2 ${fontIds.bold} 0 R >> >>`
        + ` /Contents ${contentIds[index]} 0 R >>`,
      ));
    });

    const pages = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const info = add(`<< /Title ${pdfString(this.title)} /Author ${pdfString(this.author)}`
      + ` /Producer ${pdfString('Line Design — финансы студии')} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);

    return assemble(objects, catalog, info);
  }

  buildFont(slot, add) {
    const glyphs = [...slot.used.keys()];
    const subset = subsetFont(slot.font, glyphs);
    const packed = deflateSync(subset);
    const fileId = add(Buffer.concat([
      Buffer.from(`<< /Length ${packed.length} /Length1 ${subset.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      packed,
      Buffer.from('\nendstream', 'latin1'),
    ]));

    const scale = 1000 / slot.font.unitsPerEm;
    const bbox = slot.font.bbox.map((value) => Math.round(value * scale));
    const descriptorId = add(
      `<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32`
      + ` /FontBBox [${bbox.join(' ')}] /ItalicAngle 0`
      + ` /Ascent ${Math.round(slot.font.ascent * scale)}`
      + ` /Descent ${Math.round(slot.font.descent * scale)}`
      + ` /CapHeight 700 /StemV 80 /FontFile2 ${fileId} 0 R >>`,
    );

    // Ширины перечисляем поштучно: [glyph [width]] — так проще и надёжнее,
    // чем группировать диапазоны, а глифов в отчёте немного.
    const widths = glyphs
      .filter((glyph) => glyph)
      .sort((a, b) => a - b)
      .map((glyph) => `${glyph} [${glyphWidth(slot.font, glyph)}]`)
      .join(' ');
    const descendantId = add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans`
      + ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
      + ` /FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}]`
      + ` /CIDToGIDMap /Identity >>`,
    );

    const toUnicode = deflateSync(Buffer.from(buildToUnicode(slot.used), 'latin1'));
    const unicodeId = add(Buffer.concat([
      Buffer.from(`<< /Length ${toUnicode.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      toUnicode,
      Buffer.from('\nendstream', 'latin1'),
    ]));

    return add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H`
      + ` /DescendantFonts [${descendantId} 0 R] /ToUnicode ${unicodeId} 0 R >>`,
    );
  }
}

// Таблица «номер начертания -> буква». Без неё текст в PDF нельзя
// выделить и скопировать, а поиск по документу не работает.
function buildToUnicode(used) {
  const entries = [...used.entries()].filter(([glyph]) => glyph);
  const lines = entries.map(([glyph, code]) => {
    const value = code > 0xffff
      ? (() => {
        const v = code - 0x10000;
        return `${(0xd800 + (v >> 10)).toString(16).padStart(4, '0')}${(0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')}`;
      })()
      : code.toString(16).padStart(4, '0');
    return `<${glyph.toString(16).padStart(4, '0')}> <${value}>`;
  });

  const chunks = [];
  for (let i = 0; i < lines.length; i += 100) {
    const part = lines.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function assemble(objects, catalogId, infoId) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  let position = parts[0].length;

  objects.forEach((body, index) => {
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(position);
    parts.push(head, data, tail);
    position += head.length + data.length + tail.length;
  });

  const xrefAt = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

export { PAGE };
