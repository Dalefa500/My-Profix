// Операции над данными — единственный способ что-либо изменить.
// Один и тот же код выполняется в браузере (сразу, чтобы интерфейс не ждал)
// и на сервере (чтобы данные были общими для обоих учредителей).

export const COLLECTIONS = [
  'clients', 'projects', 'employees', 'assignments',
  'incomes', 'expenses', 'payrolls', 'planned',
  // barters — взаиморасчёты: застройщик рассчитывается квартирой или машиной,
  // и стоимость выполненных работ списывается с её оценки.
  // founders — коллеги студии, draws — деньги, которые они берут из кассы.
  'barters', 'founders', 'draws',
];

// Версия устройства данных. Меняется, когда старые записи нужно
// пересобрать по новым правилам (см. migrate ниже).
export const SCHEMA_VERSION = 2;

export function emptyData() {
  return {
    settings: {
      schemaVersion: SCHEMA_VERSION,
      companyName: 'Line Design',
      // Студия считает в долларах; сомони пересчитываются при вводе.
      baseCurrency: 'USD',
      // Курс Национального банка Таджикистана: сомони за один доллар.
      // Значение на случай, пока сервер не забрал курс с nbt.tj.
      usdRate: 9.25,
      usdRateDate: '',
      usdRateSource: 'manual',
      usdRateCheckedAt: '',
      defaultAdvancePercent: 50,
      salaryDay: 5,
      notifyDaysAhead: 7,
      customCategories: [],
    },
    clients: [],
    projects: [],
    employees: [],
    assignments: [],
    incomes: [],
    expenses: [],
    payrolls: [],
    planned: [],
    barters: [],
    founders: [],
    draws: [],
  };
}

export function normalizeData(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  for (const name of COLLECTIONS) {
    data[name] = Array.isArray(raw[name]) ? raw[name] : [];
  }
  return migrate(data, raw);
}

// ------------------------------------------------- перевод базы на доллары

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Раньше всё считалось в сомони, а доллар был дополнительной валютой.
// Теперь наоборот. У каждой записи хранится своя сумма в той валюте,
// в которой её вводили, — сами суммы не трогаем. Пересчитываем только
// множитель перевода в основную валюту и производные от него итоги.
function convertNode(node, fxUsd, fxTjs, seen) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) convertNode(item, fxUsd, fxTjs, seen);
    return;
  }
  const pick = (currency) => (currency === 'TJS' ? fxTjs : fxUsd);
  if (typeof node.currency === 'string' && node.fx !== undefined) {
    node.fx = pick(node.currency);
    if (node.base !== undefined) node.base = round2((Number(node.amount) || 0) * node.fx);
    if (node.accruedBase !== undefined) node.accruedBase = round2((Number(node.amount) || 0) * node.fx);
  }
  // У сотрудника две независимые суммы: оклад и ставка за метр.
  if (typeof node.salaryCurrency === 'string') node.salaryFx = pick(node.salaryCurrency);
  if (typeof node.rateCurrency === 'string') node.rateFx = pick(node.rateCurrency);
  for (const value of Object.values(node)) convertNode(value, fxUsd, fxTjs, seen);
}

function migrate(data, raw) {
  const stored = Number(raw?.settings?.schemaVersion) || 1;
  if (stored >= SCHEMA_VERSION) return data;

  // Курс, по которому в старой версии считались доллары.
  // Запасное значение — историческое (курс времён первой версии),
  // а не сегодняшнее: им пересчитываются старые записи.
  const oldRate = Number(raw?.settings?.rates?.USD);
  const rate = Number.isFinite(oldRate) && oldRate > 0 ? oldRate : 10.9;

  const seen = new WeakSet();
  for (const name of COLLECTIONS) convertNode(data[name], 1, 1 / rate, seen);

  data.settings = {
    ...data.settings,
    schemaVersion: SCHEMA_VERSION,
    baseCurrency: 'USD',
    usdRate: rate,
    usdRateSource: data.settings.usdRateSource || 'manual',
  };
  delete data.settings.rates;
  return data;
}

function collectionOf(data, name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`Неизвестный раздел данных: ${name}`);
  if (!Array.isArray(data[name])) data[name] = [];
  return data[name];
}

export function applyOp(data, op) {
  if (!op || typeof op !== 'object') return data;
  switch (op.type) {
    case 'insert': {
      const items = collectionOf(data, op.collection);
      if (!op.record?.id) throw new Error('Запись без идентификатора');
      // Повторная доставка той же операции не должна создавать дубль.
      if (items.some((item) => item.id === op.record.id)) return data;
      // Зарплату за один месяц одному сотруднику начисляем один раз,
      // даже если два телефона начислили её независимо.
      if (op.collection === 'payrolls' && items.some(
        (item) => item.employeeId === op.record.employeeId && item.month === op.record.month,
      )) return data;
      items.unshift(op.record);
      return data;
    }
    case 'patch': {
      const items = collectionOf(data, op.collection);
      const index = items.findIndex((item) => item.id === op.id);
      if (index === -1) return data;
      const next = { ...items[index], ...(op.changes || {}) };
      for (const field of op.unset || []) delete next[field];
      items[index] = next;
      return data;
    }
    case 'remove': {
      const items = collectionOf(data, op.collection);
      const index = items.findIndex((item) => item.id === op.id);
      if (index >= 0) items.splice(index, 1);
      return data;
    }
    case 'settings': {
      data.settings = { ...data.settings, ...(op.changes || {}) };
      return data;
    }
    // Добавить, заменить или убрать один элемент вложенного списка
    // (например, выплату в начислении зарплаты). В отличие от patch со
    // всем списком, два человека, отметивших выплаты одновременно,
    // не затрут друг друга.
    case 'item': {
      const items = collectionOf(data, op.collection);
      if (!/^[a-z][a-zA-Z]{0,30}$/.test(String(op.field || ''))) throw new Error('Неверное поле');
      const index = items.findIndex((item) => item.id === op.id);
      if (index === -1) return data;
      const list = Array.isArray(items[index][op.field]) ? [...items[index][op.field]] : [];
      if (op.removeId) {
        const at = list.findIndex((entry) => entry?.id === op.removeId || entry?.expenseId === op.removeId);
        if (at >= 0) list.splice(at, 1);
      } else {
        if (!op.item?.id) throw new Error('Элемент без идентификатора');
        const at = list.findIndex((entry) => entry?.id === op.item.id);
        if (at >= 0) list[at] = { ...list[at], ...op.item };
        else list.push(op.item);
      }
      items[index] = { ...items[index], [op.field]: list };
      return data;
    }
    default:
      throw new Error(`Неизвестная операция: ${op.type}`);
  }
}

export function applyOps(data, ops) {
  for (const op of ops || []) applyOp(data, op);
  return data;
}

// Операции-конструкторы — чтобы не собирать объекты руками в коде интерфейса.
export const op = {
  insert: (collection, record) => ({ type: 'insert', collection, record }),
  patch: (collection, id, changes, unset) => ({ type: 'patch', collection, id, changes, unset }),
  remove: (collection, id) => ({ type: 'remove', collection, id }),
  settings: (changes) => ({ type: 'settings', changes }),
  // Один элемент вложенного списка: добавить/заменить или убрать.
  putItem: (collection, id, field, item) => ({ type: 'item', collection, id, field, item }),
  dropItem: (collection, id, field, removeId) => ({ type: 'item', collection, id, field, removeId }),
};
