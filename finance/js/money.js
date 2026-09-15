// Деньги и валюты.
// Правило системы: у каждой операции хранится валюта, сумма, курс и сумма
// в базовой валюте. Курс фиксируется в момент операции и НЕ пересчитывается
// задним числом при изменении текущего курса.

export const BASE_CURRENCY = 'TJS';

export const CURRENCIES = {
  TJS: { code: 'TJS', name: 'Сомони', symbol: 'TJS', decimals: 0 },
  USD: { code: 'USD', name: 'Доллар', symbol: '$', decimals: 0 },
};

export const CURRENCY_LIST = Object.values(CURRENCIES);

export function isBase(currency) {
  return currency === BASE_CURRENCY;
}

// Курс = сколько единиц базовой валюты стоит 1 единица указанной валюты.
export function defaultRate(currency, settings) {
  if (isBase(currency)) return 1;
  const rate = Number(settings?.rates?.[currency]);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
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
    currency,
    fx,
    base: toBase(amount, currency, fx),
  };
}

const formatters = new Map();

function formatterFor(currency, decimals) {
  const key = `${currency}:${decimals}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    }));
  }
  return formatters.get(key);
}

export function formatAmount(amount, currency = BASE_CURRENCY, opts = {}) {
  const meta = CURRENCIES[currency] || CURRENCIES[BASE_CURRENCY];
  const value = Number(amount) || 0;
  const decimals = opts.decimals ?? (Math.abs(value) < 1000 && value % 1 !== 0 ? 2 : 0);
  const text = formatterFor(meta.code, decimals).format(Math.abs(value));
  const sign = value < 0 ? '−' : (opts.sign && value > 0 ? '+' : '');
  if (meta.code === 'USD') return `${sign}$${text}`;
  return `${sign}${text} ${meta.symbol}`;
}

// Число без обозначения валюты — для таблиц, где валюта указана в заголовке.
export function formatPlain(amount, decimals = 0) {
  const value = Number(amount) || 0;
  const text = formatterFor(BASE_CURRENCY, decimals).format(Math.abs(value));
  return value < 0 ? `−${text}` : text;
}

// Короткая запись для графиков и плиток: 250 000 -> 250 тыс.
export function formatCompact(amount, currency = BASE_CURRENCY) {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const suffix = currency === 'USD' ? '' : ' TJS';
  const prefix = currency === 'USD' ? '$' : '';
  if (abs >= 1_000_000) return `${sign}${prefix}${round(abs / 1_000_000, 1)} млн${suffix}`;
  if (abs >= 10_000) return `${sign}${prefix}${Math.round(abs / 1000)} тыс.${suffix}`;
  return formatAmount(value, currency);
}

// «$8 / м²»
export function formatRate(amount, currency) {
  return `${formatAmount(amount, currency, { decimals: 2 })} / м²`;
}

// Подпись с исходной валютой, если операция была не в базовой валюте.
export function formatWithOriginal(entry) {
  if (!entry || isBase(entry.currency)) return formatAmount(entry?.base ?? 0);
  return `${formatAmount(entry.base)} · ${formatAmount(entry.amount, entry.currency)} по курсу ${entry.fx}`;
}
