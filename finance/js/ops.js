// Операции над данными — единственный способ что-либо изменить.
// Один и тот же код выполняется в браузере (сразу, чтобы интерфейс не ждал)
// и на сервере (чтобы данные были общими для обоих учредителей).

export const COLLECTIONS = [
  'clients', 'projects', 'employees', 'assignments',
  'incomes', 'expenses', 'payrolls', 'planned',
];

export function emptyData() {
  return {
    settings: {
      companyName: 'Line Design',
      baseCurrency: 'TJS',
      rates: { USD: 10.9 },
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
  };
}

export function normalizeData(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  for (const name of COLLECTIONS) {
    data[name] = Array.isArray(raw[name]) ? raw[name] : [];
  }
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
    case 'replace': {
      return normalizeData(op.data);
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
};
