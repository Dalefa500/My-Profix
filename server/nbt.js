// Курс доллара с сайта Национального банка Таджикистана.
//
// У НБТ есть выгрузка курсов в XML:
//   https://nbt.tj/ru/kurs/export_xml.php?date=ГГГГ-ММ-ДД&export=xmlout
// Но отвечает она неровно: на одни варианты запроса выдаёт ошибку сервера,
// на другие — нормальный документ. Поэтому мы пробуем несколько адресов
// подряд и в самом конце — обычную страницу с курсами.
//
// Если не удалось ничего, приложение продолжает работать с последним
// сохранённым курсом, а вручную его можно поправить в настройках.

const TIMEOUT_MS = 6000;
// Общий предел на весь перебор: кнопка в приложении не должна «висеть».
const BUDGET_MS = 25000;

// Некоторые сайты отвечают ошибкой на непривычного клиента,
// поэтому представляемся обычным браузером.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Accept: 'application/xml, text/xml, text/html, */*',
  'Accept-Language': 'ru,tg;q=0.9,en;q=0.8',
};

function isoDate(shiftDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + shiftDays);
  return date.toISOString().slice(0, 10);
}

function parseNumber(text) {
  const value = Number(String(text ?? '').trim().replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function toIsoDate(raw) {
  const text = String(raw || '').trim();
  const dotted = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  const plain = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return plain ? plain[0] : '';
}

// Разбор официальной выгрузки: ищем блок валюты с кодом USD.
export function parseRateXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return null;

  const blocks = xml.match(/<Valute\b[\s\S]*?<\/Valute>/gi) || [];
  for (const block of blocks) {
    const code = block.match(/<CharCode>\s*([^<]+?)\s*<\/CharCode>/i)?.[1];
    const num = block.match(/<NumCode>\s*([^<]+?)\s*<\/NumCode>/i)?.[1];
    if (String(code).toUpperCase() !== 'USD' && String(num).trim() !== '840') continue;

    const value = parseNumber(block.match(/<Value>\s*([^<]+?)\s*<\/Value>/i)?.[1]);
    const nominal = parseNumber(block.match(/<Nominal>\s*([^<]+?)\s*<\/Nominal>/i)?.[1]) || 1;
    if (!value) return null;

    // Дата стоит атрибутом у корневого тега, кавычки бывают любые.
    const rawDate = (xml.match(/<ValCurs[^>]*\bDate\s*=\s*"([^"]+)"/i)
      || xml.match(/<ValCurs[^>]*\bDate\s*=\s*'([^']+)'/i))?.[1] || '';
    return { value: Math.round((value / nominal) * 10000) / 10000, date: toIsoDate(rawDate) };
  }
  return null;
}

// Запасной разбор: обычная страница курсов. Ищем строку таблицы,
// где рядом стоят обозначение доллара и число вида 10,9512.
export function parseRateHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const plain = row.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
    if (!/\bUSD\b|Доллар|Доллари/i.test(plain)) continue;
    const numbers = plain.match(/\d+[.,]\d{2,6}/g) || [];
    // Курс сомони к доллару — единственное число с дробной частью в строке;
    // если их несколько, берём последнее (в таблицах это текущий курс).
    const value = parseNumber(numbers[numbers.length - 1]);
    if (value > 1 && value < 1000) {
      const date = toIsoDate(html.match(/(\d{2}\.\d{2}\.\d{4})/)?.[1] || '');
      return { value, date };
    }
  }
  return null;
}

async function load(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: HEADERS, redirect: 'follow' });
    if (!response.ok) return { ok: false, error: `код ${response.status}` };

    // Сайт отдаёт страницы в кодировке Windows-1251; если прочитать их
    // как UTF-8, русские подписи превратятся в мусор.
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    const head = buffer.subarray(0, 400).toString('latin1');
    const charset = (type.match(/charset=([\w-]+)/i) || head.match(/charset=["']?([\w-]+)/i))?.[1] || 'utf-8';
    let text;
    try {
      text = new TextDecoder(charset.toLowerCase()).decode(buffer);
    } catch {
      text = buffer.toString('utf8');
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'нет ответа' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

// Адреса пробуем по очереди: сначала выгрузка за сегодня, потом за вчера
// (в выходные курс за текущий день может быть ещё не опубликован),
// затем другие языковые разделы и в самом конце — страница с таблицей.
function candidates() {
  const today = isoDate(0);
  const yesterday = isoDate(-1);
  return [
    { url: `https://nbt.tj/ru/kurs/export_xml.php?date=${today}&export=xmlout`, parse: parseRateXml },
    { url: `https://nbt.tj/ru/kurs/export_xml.php?date=${today}`, parse: parseRateXml },
    { url: `https://nbt.tj/ru/kurs/export_xml.php?date=${yesterday}&export=xmlout`, parse: parseRateXml },
    { url: 'https://nbt.tj/ru/kurs/export_xml.php?date=&export=xmlout', parse: parseRateXml },
    { url: `https://nbt.tj/en/kurs/export_xml.php?date=${today}&export=xmlout`, parse: parseRateXml },
    { url: 'https://nbt.tj/ru/kurs/kurs.php', parse: parseRateHtml },
    { url: 'https://nbt.tj/ru/', parse: parseRateHtml },
  ];
}

export async function fetchUsdRate() {
  const problems = [];
  const deadline = Date.now() + BUDGET_MS;
  for (const { url, parse } of candidates()) {
    if (Date.now() > deadline) {
      problems.push('дальше не проверяли — сайт отвечает слишком долго');
      break;
    }
    const response = await load(url);
    if (!response.ok) {
      problems.push(`${new URL(url).pathname}: ${response.error}`);
      continue;
    }
    const rate = parse(response.text);
    if (rate) return { ok: true, rate, source: url };
    problems.push(`${new URL(url).pathname}: курс не найден в ответе`);
  }
  return {
    ok: false,
    error: 'Сайт НБТ не отдал курс. Его можно ввести вручную в настройках.',
    details: problems.slice(0, 4).join('; '),
  };
}
