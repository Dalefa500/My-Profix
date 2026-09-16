// Справочники системы: статусы, категории, типы операций.

export const PROJECT_STATUSES = [
  { id: 'new', label: 'Новый', tone: 'neutral' },
  { id: 'in_progress', label: 'В работе', tone: 'info' },
  { id: 'review', label: 'На согласовании', tone: 'warn' },
  { id: 'rework', label: 'Требует доработки', tone: 'danger' },
  { id: 'approved', label: 'Одобрен', tone: 'good' },
  { id: 'done', label: 'Завершён', tone: 'good' },
  { id: 'cancelled', label: 'Отменён', tone: 'muted' },
];

// Статусы, после которых клиент считается согласовавшим работу:
// именно с этого момента остаток сдельного сотрудника доступен к выплате.
export const CLIENT_APPROVED_STATUSES = ['approved', 'done'];
export const CLOSED_PROJECT_STATUSES = ['cancelled'];

// Ход работы сдельного сотрудника по проекту.
export const WORK_STAGES = [
  { id: 'assigned', label: 'Назначен', tone: 'neutral' },
  { id: 'in_progress', label: 'Работа в процессе', tone: 'info' },
  { id: 'done', label: 'Работа завершена', tone: 'info' },
  { id: 'review', label: 'На согласовании', tone: 'warn' },
  { id: 'approved', label: 'Клиент одобрил', tone: 'good' },
];

export const PROJECT_ROLES = [
  'Дизайнер', 'Чертёжник', 'Визуализатор', 'Замерщик', 'Декоратор', 'Помощник',
];

export const OBJECT_TYPES = [
  'Квартира', 'Дом', 'Офис', 'Ресторан', 'Магазин', 'Отель', 'Другое',
];

export const EMPLOYEE_PAY_TYPES = [
  { id: 'fixed', label: 'Фиксированная зарплата' },
  { id: 'piecework', label: 'Сдельная оплата (за м²)' },
];

export const INCOME_TYPES = [
  { id: 'advance', label: 'Аванс проекта' },
  { id: 'final', label: 'Остаток проекта' },
  { id: 'extra', label: 'Дополнительная работа' },
  { id: 'other', label: 'Прочий доход' },
];

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'Наличные' },
  { id: 'transfer', label: 'Банковский перевод' },
  { id: 'card', label: 'Карта' },
  // Расчёт не деньгами: застройщик передаёт квартиру или машину,
  // и стоимость работ списывается с её оценки.
  { id: 'barter', label: 'Взаимозачёт' },
  { id: 'other', label: 'Другой способ' },
];

// Чем именно рассчитывается клиент по взаимозачёту.
export const BARTER_KINDS = [
  { id: 'property', label: 'Недвижимость' },
  { id: 'car', label: 'Автомобиль' },
  { id: 'goods', label: 'Товары или материалы' },
  { id: 'services', label: 'Услуги' },
  { id: 'other', label: 'Другое' },
];

// Категории расходов. id подкатегории — «group/item», он стабилен и хранится
// в операциях, поэтому переименование подписи не ломает историю.
export const EXPENSE_GROUPS = [
  {
    id: 'staff',
    label: 'Персонал',
    items: [
      { id: 'staff/salary', label: 'Зарплаты' },
      { id: 'staff/advance', label: 'Авансы сдельным сотрудникам' },
      { id: 'staff/final', label: 'Остаточные выплаты сдельным' },
    ],
  },
  {
    id: 'office',
    label: 'Офис',
    items: [
      { id: 'office/rent', label: 'Аренда' },
      { id: 'office/electricity', label: 'Электричество' },
      { id: 'office/water', label: 'Вода' },
      { id: 'office/utilities', label: 'Коммунальные' },
      { id: 'office/internet', label: 'Интернет' },
      { id: 'office/phone', label: 'Телефон' },
    ],
  },
  {
    id: 'gov',
    label: 'Государственные',
    items: [
      { id: 'gov/tax', label: 'Налоги' },
      { id: 'gov/other', label: 'Другие обязательные платежи' },
    ],
  },
  {
    id: 'stationery',
    label: 'Канцелярия',
    items: [
      { id: 'stationery/supplies', label: 'Канцелярские товары' },
      { id: 'stationery/print', label: 'Печать' },
      { id: 'stationery/paper', label: 'Бумага' },
      { id: 'stationery/household', label: 'Хозяйственные товары' },
    ],
  },
  {
    id: 'pro',
    label: 'Профессиональные',
    items: [
      { id: 'pro/software', label: 'Программы' },
      { id: 'pro/subscriptions', label: 'Подписки' },
      { id: 'pro/hardware', label: 'Техника' },
      { id: 'pro/equipment', label: 'Оборудование' },
    ],
  },
  {
    id: 'other',
    label: 'Прочее',
    items: [
      { id: 'other/taxi', label: 'Такси' },
      { id: 'other/delivery', label: 'Доставка' },
      { id: 'other/ads', label: 'Реклама' },
      { id: 'other/hospitality', label: 'Представительские' },
      { id: 'other/misc', label: 'Другие расходы' },
    ],
  },
];

// Категории, которые создаются системой при выплатах и не выбираются вручную.
export const SYSTEM_CATEGORIES = ['staff/salary', 'staff/advance', 'staff/final'];

export function expenseGroups(settings) {
  const custom = settings?.customCategories || [];
  return EXPENSE_GROUPS.map((group) => ({
    ...group,
    items: [
      ...group.items,
      ...custom.filter((item) => item.group === group.id)
        .map((item) => ({ id: item.id, label: item.label, custom: true })),
    ],
  }));
}

export function categoryLabel(categoryId, settings) {
  for (const group of expenseGroups(settings)) {
    const found = group.items.find((item) => item.id === categoryId);
    if (found) return found.label;
  }
  return categoryId || 'Без категории';
}

export function categoryGroupLabel(categoryId, settings) {
  const groupId = String(categoryId || '').split('/')[0];
  const group = expenseGroups(settings).find((item) => item.id === groupId);
  return group ? group.label : 'Прочее';
}

export function labelOf(list, id, fallback = '—') {
  const found = list.find((item) => item.id === id);
  return found ? found.label : fallback;
}

export function toneOf(list, id) {
  const found = list.find((item) => item.id === id);
  return found ? found.tone || 'neutral' : 'neutral';
}
