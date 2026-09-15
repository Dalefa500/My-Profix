// Работа с датами. Везде используется формат ISO: YYYY-MM-DD.

export const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export const MONTHS_SHORT = [
  'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
  'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек',
];

export function today() {
  return toISO(new Date());
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parse(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

export function addDays(iso, days) {
  const date = parse(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

export function addMonths(iso, months) {
  const date = parse(iso);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  date.setDate(Math.min(day, daysInMonth(date.getFullYear(), date.getMonth())));
  return toISO(date);
}

export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function monthKey(iso) {
  return String(iso || '').slice(0, 7);
}

export function monthStart(iso) {
  return `${monthKey(iso)}-01`;
}

export function monthEnd(iso) {
  const date = parse(iso);
  return toISO(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

// Ключ месяца YYYY-MM -> «Сентябрь 2026»
export function monthLabel(key, opts = {}) {
  const [y, m] = String(key).split('-').map(Number);
  const name = opts.short ? MONTHS_SHORT[m - 1] : MONTHS[m - 1];
  return opts.noYear ? name : `${name} ${y}`;
}

export function monthKeysBetween(fromKey, toKey) {
  const keys = [];
  let cursor = `${fromKey}-01`;
  const last = `${toKey}-01`;
  let guard = 0;
  while (cursor <= last && guard < 600) {
    keys.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
    guard += 1;
  }
  return keys;
}

// Последние n месяцев, включая месяц даты anchor.
export function lastMonthKeys(anchorIso, count) {
  const from = monthKey(addMonths(monthStart(anchorIso), -(count - 1)));
  return monthKeysBetween(from, monthKey(anchorIso));
}

export function formatDate(iso, opts = {}) {
  if (!iso) return '—';
  const date = parse(iso);
  const day = date.getDate();
  const month = opts.short ? MONTHS_SHORT[date.getMonth()] : MONTHS[date.getMonth()].toLowerCase();
  return opts.withYear === false
    ? `${day} ${month}`
    : `${day} ${month} ${date.getFullYear()}`;
}

export function daysUntil(iso, fromIso = today()) {
  const ms = parse(iso).getTime() - parse(fromIso).getTime();
  return Math.round(ms / 86400000);
}

export function inRange(iso, from, to) {
  return Boolean(iso) && iso >= from && iso <= to;
}

// Готовые диапазоны для переключателя периода.
export function rangeFor(preset, anchorIso = today()) {
  const anchor = parse(anchorIso);
  switch (preset) {
    case 'today':
      return { from: anchorIso, to: anchorIso, label: 'Сегодня' };
    case 'week': {
      const shift = (anchor.getDay() + 6) % 7; // неделя с понедельника
      const from = addDays(anchorIso, -shift);
      return { from, to: addDays(from, 6), label: 'Неделя' };
    }
    case 'month':
      return { from: monthStart(anchorIso), to: monthEnd(anchorIso), label: 'Месяц' };
    case 'quarter':
      return { from: monthStart(addMonths(anchorIso, -2)), to: monthEnd(anchorIso), label: '3 месяца' };
    case 'half':
      return { from: monthStart(addMonths(anchorIso, -5)), to: monthEnd(anchorIso), label: '6 месяцев' };
    case 'year':
      return { from: monthStart(addMonths(anchorIso, -11)), to: monthEnd(anchorIso), label: 'Год' };
    case 'calendarYear':
      return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear()}-12-31`, label: String(anchor.getFullYear()) };
    default:
      return { from: monthStart(anchorIso), to: monthEnd(anchorIso), label: 'Месяц' };
  }
}
