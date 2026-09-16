// Курс доллара с сайта Национального банка Таджикистана.
//
// НБТ публикует официальные курсы выгрузкой в XML:
//   https://nbt.tj/ru/kurs/export_xml.php?date=ГГГГ-ММ-ДД&export=xmlout
// Без даты отдаётся последний зарегистрированный курс.
//
// Разбор намеренно устойчивый: если НБТ поменяет вёрстку или сайт окажется
// недоступен, мы возвращаем ошибку, а приложение продолжает работать
// с последним известным курсом, введённым вручную.

const ENDPOINT = 'https://nbt.tj/ru/kurs/export_xml.php';
const TIMEOUT_MS = 12000;

// В XML попадаются и точка, и запятая как разделитель дробной части.
function parseNumber(text) {
  const value = Number(String(text).trim().replace(',', '.').replace(/\s+/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Ищем блок валюты с кодом USD и достаём номинал, значение и дату.
export function parseRateXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return null;

  const blocks = xml.match(/<Valute\b[\s\S]*?<\/Valute>/gi) || [];
  for (const block of blocks) {
    const code = block.match(/<CharCode>\s*([^<]+?)\s*<\/CharCode>/i)?.[1];
    const num = block.match(/<NumCode>\s*([^<]+?)\s*<\/NumCode>/i)?.[1];
    const isUsd = String(code).toUpperCase() === 'USD' || String(num).trim() === '840';
    if (!isUsd) continue;

    const value = parseNumber(block.match(/<Value>\s*([^<]+?)\s*<\/Value>/i)?.[1] || '');
    const nominal = parseNumber(block.match(/<Nominal>\s*([^<]+?)\s*<\/Nominal>/i)?.[1] || '') || 1;
    if (!value) return null;

    // Дата стоит атрибутом у корневого тега: Date="16.09.2026".
    // Кавычки бывают и двойные, и одинарные — принимаем оба варианта.
    const rawDate = (xml.match(/<ValCurs[^>]*\bDate\s*=\s*"([^"]+)"/i)
      || xml.match(/<ValCurs[^>]*\bDate\s*=\s*'([^']+)'/i))?.[1] || '';
    const parts = rawDate.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const date = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : (rawDate.slice(0, 10) || '');

    return { value: Math.round((value / nominal) * 10000) / 10000, date };
  }
  return null;
}

export async function fetchUsdRate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}?date=&export=xmlout`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Line Design Finance/1.0', Accept: 'application/xml, text/xml, */*' },
    });
    if (!response.ok) return { ok: false, error: `НБТ ответил кодом ${response.status}` };
    const rate = parseRateXml(await response.text());
    if (!rate) return { ok: false, error: 'В ответе НБТ не нашёлся курс доллара' };
    return { ok: true, rate };
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'сайт НБТ не ответил вовремя' : error.message;
    return { ok: false, error: `Не удалось получить курс: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}
