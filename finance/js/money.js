// Деньги и валюты.
//
// Основная валюта студии — доллар. Всё, что показывает приложение
// (прибыль, долги, зарплаты, отчёты), считается и выводится в долларах.
//
// Сомони можно выбрать при вводе любой суммы: она тут же пересчитывается
// в доллары по курсу Национального банка Таджикистана. Курс, по которому
// прошёл пересчёт, сохраняется вместе с операцией и НЕ пересматривается
// задним числом, когда курс НБТ меняется.

export const BASE_CURRENCY = 'USD';

export const CURRENCIES = {
  USD: { code: 'USD', name: 'Доллар', symbol: '$', decimals: 2 },
  TJS: { code: 'TJS', name: 'Сомони', symbol: 'TJS', decimals: 0 },
};

// Порядок важен: доллар первым, потому что он основной.
export const CURRENCY_LIST = [CURRENCIES.USD, CURRENCIES.TJS];

// Курс по умолчанию, если настройки ещё не заполнены.
export const FALLBACK_USD_RATE = 9.25;

export function isBase(currency) {
  return (currency || BASE_CURRENCY) === BASE_CURRENCY;
}

// Курс НБТ в привычном виде: сколько сомони дают за один доллар.
export function usdRate(settings) {
  const rate = Number(settings?.usdRate);
  return Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_USD_RATE;
}

// Множитель к основной валюте: сколько долларов стоит одна единица валюты.
// Для доллара это 1, для сомони — 1 / курс НБТ.
export function defaultRate(currency, settings) {
  if (isBase(currency)) return 1;
  if (currency === 'TJS') return 1 / usdRate(settings);
  return 1;
}

// Обратное преобразование: из множителя обратно в курс «сомони за доллар».
// Нужно везде, где курс показывается человеку.
export function rateToHuman(fx) {
  const value = Number(fx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round(1 / value, 4);
}

export function humanToRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return 1 / value;
}

export function toBase(amount, currency, rate) {
  const value = Number(amount) || 0;
  if (isBase(currency)) return round(value);
  const fx = Number(rate) > 0 ? Number(rate) : 1;
  return round(value * fx);
}

export function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

// Собирает денежные поля операции в единый вид.
export function makeMoney(amount, currency, rate) {
  const fx = isBase(currency) ? 1 : (Number(rate) > 0 ? Number(rate) : 1);
  return {
    amount: round(amount),
    currency: currency || BASE_CURRENCY,
    fx,
    base: toBase(amount, currency, fx),
  };
}

const formatters = new Map();

function formatterFor(min, max = min) {
  const key = `${min}:${max}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    }));
  }
  return formatters.get(key);
}

export function formatAmount(amount, currency = BASE_CURRENCY, opts = {}) {
  const meta = CURRENCIES[currency] || CURRENCIES[BASE_CURRENCY];
  const raw = Number(amount) || 0;
  // Сначала округляем до копеек: 2,9999999 — это ровно 3, а не «3,00».
  const value = Math.round(raw * 100) / 100;
  // Центы показываем только там, где они действительно есть.
  // Если центы есть — всегда обе цифры: «$12,50», а не «$12,5».
  const hasCents = Math.abs(value % 1) > 0.004;
  const decimals = hasCents ? (opts.decimals ?? meta.decimals) : 0;
  const text = formatterFor(decimals).format(Math.abs(value));
  const sign = value < 0 ? '−' : (opts.sign && value > 0 ? '+' : '');
  if (meta.code === 'USD') return `${sign}$${text}`;
  return `${sign}${text} ${meta.symbol}`;
}

// Число без обозначения валюты — для таблиц, где валюта указана в заголовке.
export function formatPlain(amount, decimals = 0) {
  const value = Number(amount) || 0;
  const text = formatterFor(0, decimals).format(Math.abs(value));
  return value < 0 ? `−${text}` : text;
}

// Короткая запись для графиков и плиток: 250 000 -> $250 тыс.
export function formatCompact(amount, currency = BASE_CURRENCY) {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const isUsd = (currency || BASE_CURRENCY) === 'USD';
  const suffix = isUsd ? '' : ' TJS';
  const prefix = isUsd ? '$' : '';
  if (abs >= 1_000_000) return `${sign}${prefix}${formatterFor(0, 1).format(round(abs / 1_000_000, 1))} млн${suffix}`;
  if (abs >= 10_000) return `${sign}${prefix}${Math.round(abs / 1000)} тыс.${suffix}`;
  return formatAmount(value, currency);
}

// Площадь по-русски: «84,5 м²».
export function formatArea(value) {
  const number = Number(value) || 0;
  return `${formatterFor(0, 2).format(number)} м²`;
}

// «$8 / м²»
export function formatRate(amount, currency) {
  return `${formatAmount(amount, currency, { decimals: 2 })} / м²`;
}

// Курс в привычном виде: «1 $ = 9,2325 TJS». НБТ публикует курс
// с четырьмя знаками, и считаем мы по нему же — так и показываем,
// иначе «92 325 TJS по курсу 9,23» не сходится с $10 000.
export function formatUsdRate(rate, decimals = 4) {
  return `1 $ = ${formatterFor(0, decimals).format(round(Number(rate) || 0, decimals))} TJS`;
}

// Курс для поля ввода: с запятой, как все числа в программе.
export function rateForInput(rate) {
  return String(round(Number(rate) || 0, 4)).replace('.', ',');
}

// Подпись с исходной валютой, если операция была введена не в долларах.
export function formatWithOriginal(entry) {
  if (!entry || isBase(entry.currency)) return formatAmount(entry?.base ?? 0);
  return `${formatAmount(entry.base)} · введено ${formatAmount(entry.amount, entry.currency)}`
    + ` по курсу ${formatterFor(0, 4).format(round(rateToHuman(entry.fx), 4))}`;
}
