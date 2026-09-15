// Действия над данными: то, что нажимает пользователь.
// Здесь собраны все правила, из-за которых одна операция меняет несколько
// сущностей сразу (например, выплата сотруднику создаёт расход компании).

import * as store from './store.js';
import { op } from './ops.js';
import { toBase, defaultRate, round } from './money.js';
import { today, monthKey, monthLabel, addMonths, daysInMonth } from './dates.js';
import { assignmentState, payrollMonthsFor, payrollState, clampPercent } from './calc.js';

const { uid, getState } = store;

function money(values, settings) {
  const currency = values.currency || settings.baseCurrency;
  const fx = currency === settings.baseCurrency
    ? 1
    : (Number(values.fx) > 0 ? Number(values.fx) : defaultRate(currency, settings));
  const amount = round(values.amount);
  return { amount, currency, fx, base: toBase(amount, currency, fx) };
}

// Имя того, кто внёс операцию (оба учредителя работают с одними данными).
function currentOwner() {
  return store.getUser()?.name || '';
}

// ------------------------------------------------------------------ клиенты

export function saveClient(values, id = null) {
  const record = {
    name: values.name?.trim() || 'Без имени',
    phone: values.phone?.trim() || '',
    email: values.email?.trim() || '',
    note: values.note?.trim() || '',
  };
  if (id) return store.patch('clients', id, record);
  return store.insert('clients', record, 'cli');
}

export function deleteClient(id) {
  const state = getState();
  // Проекты и операции не удаляем — просто отвязываем, чтобы не терять историю.
  const ops = [op.remove('clients', id)];
  for (const project of state.projects.filter((item) => item.clientId === id)) {
    ops.push(op.patch('projects', project.id, { clientId: null }));
  }
  for (const income of state.incomes.filter((item) => item.clientId === id)) {
    ops.push(op.patch('incomes', income.id, { clientId: null }));
  }
  return store.commit(ops);
}

// ------------------------------------------------------------------ проекты

// План поступлений по умолчанию: аванс и остаток пополам (пункт 5 ТЗ).
export function defaultPaymentPlan(price, startDate, dueDate, percent = 50) {
  const advance = round(Number(price) * clampPercent(percent) / 100);
  return [
    { id: uid('pay'), type: 'advance', title: 'Аванс', amount: advance, dueDate: startDate || today() },
    { id: uid('pay'), type: 'final', title: 'Остаток', amount: round(Number(price) - advance), dueDate: dueDate || startDate || today() },
  ];
}

export function saveProject(values, id = null) {
  const state = getState();
  const settings = state.settings;
  const price = money({ amount: values.price, currency: values.currency, fx: values.fx }, settings);
  const record = {
    name: values.name?.trim() || 'Без названия',
    clientId: values.clientId || null,
    objectType: values.objectType || '',
    address: values.address?.trim() || '',
    area: Number(values.area) || 0,
    startDate: values.startDate || today(),
    dueDate: values.dueDate || '',
    leadId: values.leadId || null,
    price: price.amount,
    currency: price.currency,
    fx: price.fx,
    status: values.status || 'new',
    note: values.note?.trim() || '',
  };
  if (id) {
    const existing = store.byId('projects', id);
    // План платежей не трогаем при редактировании — его правят отдельно.
    return store.patch('projects', id, { ...record, payments: existing?.payments || [] });
  }
  return store.insert('projects', {
    ...record,
    payments: defaultPaymentPlan(price.amount, record.startDate, record.dueDate, settings.defaultAdvancePercent),
    createdBy: currentOwner(),
  }, 'prj');
}

export function setProjectStatus(id, status) {
  return store.patch('projects', id, { status });
}

export function savePlanItem(projectId, values, itemId = null) {
  const project = store.byId('projects', projectId);
  if (!project) return null;
  const payments = [...(project.payments || [])];
  const record = {
    type: values.type || 'final',
    title: values.title?.trim() || '',
    amount: round(values.amount),
    dueDate: values.dueDate || today(),
  };
  if (itemId) {
    const index = payments.findIndex((item) => item.id === itemId);
    if (index >= 0) payments[index] = { ...payments[index], ...record };
  } else {
    payments.push({ id: uid('pay'), ...record });
  }
  return store.patch('projects', projectId, { payments });
}

export function deletePlanItem(projectId, itemId) {
  const project = store.byId('projects', projectId);
  if (!project) return null;
  return store.patch('projects', projectId, {
    payments: (project.payments || []).filter((item) => item.id !== itemId),
  });
}

export function deleteProject(id) {
  const state = getState();
  const ops = [op.remove('projects', id)];
  for (const assignment of state.assignments.filter((item) => item.projectId === id)) {
    ops.push(op.remove('assignments', assignment.id));
  }
  for (const income of state.incomes.filter((item) => item.projectId === id)) {
    ops.push(op.patch('incomes', income.id, { projectId: null }));
  }
  for (const expense of state.expenses.filter((item) => item.projectId === id)) {
    ops.push(op.patch('expenses', expense.id, { projectId: null }));
  }
  return store.commit(ops);
}

// --------------------------------------------------------------- сотрудники

export function saveEmployee(values, id = null) {
  const settings = getState().settings;
  const record = {
    name: values.name?.trim() || 'Без имени',
    position: values.position?.trim() || '',
    payType: values.payType === 'piecework' ? 'piecework' : 'fixed',
    phone: values.phone?.trim() || '',
    startDate: values.startDate || today(),
    active: values.active !== false,
    note: values.note?.trim() || '',
  };
  if (record.payType === 'fixed') {
    const salary = money({ amount: values.salary, currency: values.salaryCurrency, fx: values.salaryFx }, settings);
    Object.assign(record, {
      salary: salary.amount,
      salaryCurrency: salary.currency,
      salaryFx: salary.fx,
      payday: Number(values.payday) || settings.salaryDay,
      rate: 0,
    });
  } else {
    const rate = money({ amount: values.rate, currency: values.rateCurrency, fx: values.rateFx }, settings);
    Object.assign(record, {
      rate: rate.amount,
      rateCurrency: rate.currency,
      rateFx: rate.fx,
      salary: 0,
    });
  }
  const saved = id ? store.patch('employees', id, record) : store.insert('employees', record, 'emp');
  ensurePayrolls();
  return saved;
}

export function deleteEmployee(id) {
  const state = getState();
  const ops = [op.remove('employees', id)];
  for (const assignment of state.assignments.filter((item) => item.employeeId === id)) {
    ops.push(op.remove('assignments', assignment.id));
  }
  for (const payroll of state.payrolls.filter((item) => item.employeeId === id)) {
    ops.push(op.remove('payrolls', payroll.id));
  }
  return store.commit(ops);
}

// ------------------------------------------- сдельные назначения на проект

export function saveAssignment(values, id = null) {
  const state = getState();
  const settings = state.settings;
  const employee = store.byId('employees', values.employeeId);
  const currency = values.currency || employee?.rateCurrency || settings.baseCurrency;
  const fx = currency === settings.baseCurrency
    ? 1
    : (Number(values.fx) > 0 ? Number(values.fx) : (employee?.rateFx || defaultRate(currency, settings)));
  const record = {
    projectId: values.projectId,
    employeeId: values.employeeId,
    role: values.role?.trim() || employee?.position || 'Сотрудник',
    area: Number(values.area) || 0,
    // Ставка хранится в назначении: её можно поменять для конкретного проекта.
    rate: round(values.rate),
    currency,
    fx,
    advancePercent: clampPercent(values.advancePercent ?? settings.defaultAdvancePercent),
    stage: values.stage || 'assigned',
  };
  if (id) return store.patch('assignments', id, record);
  return store.insert('assignments', record, 'asg');
}

export function setAssignmentStage(id, stage) {
  return store.patch('assignments', id, { stage });
}

export function deleteAssignment(id) {
  const state = getState();
  // Уже проведённые выплаты остаются в расходах компании как факт.
  const ops = [op.remove('assignments', id)];
  for (const expense of state.expenses.filter((item) => item.assignmentId === id)) {
    ops.push(op.patch('expenses', expense.id, { assignmentId: null }));
  }
  return store.commit(ops);
}

// Выплата аванса или остатка сдельному сотруднику.
// Правило 5 ТЗ: фактическая выплата сразу становится расходом компании.
export function payAssignment(assignmentId, part, values = {}) {
  const state = getState();
  const assignment = store.byId('assignments', assignmentId);
  if (!assignment) return { ok: false, error: 'Назначение не найдено' };
  const project = store.byId('projects', assignment.projectId);
  const info = assignmentState(assignment, project);

  if (part === 'advance' && info.advancePaid) return { ok: false, error: 'Аванс уже выплачен' };
  if (part === 'final') {
    if (info.remainderPaid) return { ok: false, error: 'Остаток уже выплачен' };
    if (!info.remainderAvailable) {
      return { ok: false, error: 'Остаток станет доступен после того, как клиент одобрит работу' };
    }
  }

  const fallbackAmount = part === 'advance' ? info.advance : info.remainder;
  const payment = money({
    amount: values.amount ?? fallbackAmount,
    currency: values.currency || assignment.currency,
    fx: values.fx ?? assignment.fx,
  }, state.settings);

  const employee = store.byId('employees', assignment.employeeId);
  const expense = {
    id: uid('exp'),
    date: values.date || today(),
    category: part === 'advance' ? 'staff/advance' : 'staff/final',
    ...payment,
    projectId: assignment.projectId,
    employeeId: assignment.employeeId,
    assignmentId: assignment.id,
    source: 'assignment',
    method: values.method || 'cash',
    comment: values.comment
      || `${part === 'advance' ? 'Аванс' : 'Остаток'} · ${employee?.name || ''} · ${project?.name || ''}`.trim(),
    createdBy: currentOwner(),
    createdAt: today(),
  };

  const changes = part === 'advance'
    ? { advancePaidAt: expense.date, advanceExpenseId: expense.id }
    : { remainderPaidAt: expense.date, remainderExpenseId: expense.id, stage: 'approved' };
  store.commit([
    op.insert('expenses', expense),
    op.patch('assignments', assignmentId, changes),
  ]);
  return { ok: true, expense };
}

// ------------------------------------------------------------- зарплаты

// Ежемесячное начисление штатным сотрудникам (пункт 11 ТЗ).
// Функция идемпотентна: повторный вызов не создаёт дублей.
export function ensurePayrolls(nowIso = today()) {
  const state = getState();
  const created = [];
  const ops = [];
  {
    for (const employee of state.employees) {
      for (const month of payrollMonthsFor(employee, nowIso)) {
        const exists = state.payrolls.some(
          (item) => item.employeeId === employee.id && item.month === month,
        );
        if (exists) continue;
        const fx = employee.salaryCurrency === state.settings.baseCurrency
          ? 1
          : (Number(employee.salaryFx) > 0 ? employee.salaryFx : defaultRate(employee.salaryCurrency, state.settings));
        const payday = Math.min(
          Number(employee.payday) || Number(state.settings.salaryDay) || 5,
          daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1),
        );
        const record = {
          id: uid('pyr'),
          employeeId: employee.id,
          month,
          amount: round(employee.salary),
          currency: employee.salaryCurrency || state.settings.baseCurrency,
          fx,
          accruedBase: toBase(employee.salary, employee.salaryCurrency, fx),
          dueDate: `${month}-${String(payday).padStart(2, '0')}`,
          payments: [],
          createdAt: nowIso,
        };
        ops.push(op.insert('payrolls', record));
        created.push(record);
      }
    }
  }
  if (ops.length) {
    ops.push(op.settings({ payrollThrough: monthKey(nowIso) }));
    store.commit(ops);
  }
  return created;
}

// Выплата зарплаты, в том числе частичная (пункт 11 ТЗ).
export function payPayroll(payrollId, values = {}) {
  const state = getState();
  const payroll = store.byId('payrolls', payrollId);
  if (!payroll) return { ok: false, error: 'Начисление не найдено' };
  const info = payrollState(payroll);
  if (info.leftBase <= 0.01) return { ok: false, error: 'Зарплата уже выплачена' };

  const payment = money({
    amount: values.amount ?? payroll.amount - (info.paidBase / (payroll.fx || 1)),
    currency: values.currency || payroll.currency,
    fx: values.fx ?? payroll.fx,
  }, state.settings);
  if (payment.base <= 0) return { ok: false, error: 'Укажите сумму больше нуля' };

  const employee = store.byId('employees', payroll.employeeId);
  const expense = {
    id: uid('exp'),
    date: values.date || today(),
    category: 'staff/salary',
    ...payment,
    projectId: null,
    employeeId: payroll.employeeId,
    payrollId: payroll.id,
    source: 'payroll',
    method: values.method || 'cash',
    comment: values.comment || `Зарплата · ${employee?.name || ''} · ${monthLabel(payroll.month)}`.trim(),
    createdBy: currentOwner(),
    createdAt: today(),
  };

  const payments = [...(payroll.payments || []), {
    id: uid('prt'),
    date: expense.date,
    expenseId: expense.id,
    amount: payment.amount,
    currency: payment.currency,
    fx: payment.fx,
    base: payment.base,
  }];
  store.commit([
    op.insert('expenses', expense),
    op.patch('payrolls', payrollId, { payments }),
  ]);
  return { ok: true, expense };
}

// --------------------------------------------------- приходы и расходы

export function saveIncome(values, id = null) {
  const state = getState();
  const payment = money(values, state.settings);
  const project = store.byId('projects', values.projectId);
  const record = {
    date: values.date || today(),
    ...payment,
    clientId: values.clientId || project?.clientId || null,
    projectId: values.projectId || null,
    type: values.type || (values.projectId ? 'advance' : 'other'),
    method: values.method || 'cash',
    comment: values.comment?.trim() || '',
  };
  if (id) return store.patch('incomes', id, record);
  return store.insert('incomes', { ...record, createdBy: currentOwner() }, 'inc');
}

export function saveExpense(values, id = null) {
  const state = getState();
  const payment = money(values, state.settings);
  const record = {
    date: values.date || today(),
    category: values.category || 'other/misc',
    ...payment,
    projectId: values.projectId || null,
    employeeId: values.employeeId || null,
    method: values.method || 'cash',
    comment: values.comment?.trim() || '',
  };
  if (id) {
    const existing = store.byId('expenses', id);
    // Служебные расходы (выплаты сотрудникам) правятся только через выплату.
    if (existing?.source) return store.patch('expenses', id, { date: record.date, comment: record.comment });
    return store.patch('expenses', id, record);
  }
  return store.insert('expenses', { ...record, createdBy: currentOwner() }, 'exp');
}

export function deleteIncome(id) {
  return store.remove('incomes', id);
}

// Удаление расхода снимает отметку о выплате, чтобы обязательство вернулось.
export function deleteExpense(id) {
  const state = getState();
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return null;
  const ops = [op.remove('expenses', id)];

  if (expense.source === 'assignment' && expense.assignmentId) {
    const assignment = state.assignments.find((item) => item.id === expense.assignmentId);
    if (assignment?.advanceExpenseId === id) {
      ops.push(op.patch('assignments', assignment.id, {}, ['advanceExpenseId', 'advancePaidAt']));
    }
    if (assignment?.remainderExpenseId === id) {
      ops.push(op.patch('assignments', assignment.id, {}, ['remainderExpenseId', 'remainderPaidAt']));
    }
  }
  if (expense.source === 'payroll' && expense.payrollId) {
    const payroll = state.payrolls.find((item) => item.id === expense.payrollId);
    if (payroll) {
      ops.push(op.patch('payrolls', payroll.id, {
        payments: (payroll.payments || []).filter((item) => item.expenseId !== id),
      }));
    }
  }
  if (expense.source === 'planned' && expense.plannedId) {
    const planned = state.planned.find((item) => item.id === expense.plannedId);
    if (planned) {
      ops.push(op.patch('planned', planned.id, { status: 'planned' }, ['expenseId']));
    }
  }
  return store.commit(ops);
}

// ------------------------------------------------ планируемые платежи

export function savePlanned(values, id = null) {
  const settings = getState().settings;
  const payment = money(values, settings);
  const record = {
    title: values.title?.trim() || 'Платёж',
    category: values.category || 'other/misc',
    ...payment,
    dueDate: values.dueDate || today(),
    repeat: values.repeat === 'monthly' ? 'monthly' : 'none',
    status: values.status || 'planned',
  };
  if (id) return store.patch('planned', id, record);
  return store.insert('planned', record, 'pln');
}

export function deletePlanned(id) {
  return store.remove('planned', id);
}

// Оплата планового расхода: создаёт факт расхода, а для ежемесячных
// платежей сразу ставит следующий месяц.
export function payPlanned(plannedId, values = {}) {
  const state = getState();
  const planned = store.byId('planned', plannedId);
  if (!planned) return { ok: false, error: 'Платёж не найден' };
  const payment = money({
    amount: values.amount ?? planned.amount,
    currency: values.currency || planned.currency,
    fx: values.fx ?? planned.fx,
  }, state.settings);

  const expense = {
    id: uid('exp'),
    date: values.date || today(),
    category: planned.category,
    ...payment,
    projectId: values.projectId || null,
    employeeId: null,
    plannedId: planned.id,
    source: 'planned',
    method: values.method || 'transfer',
    comment: values.comment || planned.title,
    createdBy: currentOwner(),
    createdAt: today(),
  };

  const ops = [
    op.insert('expenses', expense),
    op.patch('planned', plannedId, { status: 'paid', expenseId: expense.id }),
  ];
  if (planned.repeat === 'monthly') {
    const nextDate = addMonths(planned.dueDate, 1);
    const exists = state.planned.some(
      (item) => item.title === planned.title
        && item.category === planned.category
        && item.dueDate === nextDate,
    );
    if (!exists) {
      ops.push(op.insert('planned', {
        ...planned,
        id: uid('pln'),
        dueDate: nextDate,
        status: 'planned',
        expenseId: undefined,
        createdAt: today(),
      }));
    }
  }
  store.commit(ops);
  return { ok: true, expense };
}

// ------------------------------------------------------------ настройки

export function saveSettings(values) {
  const settings = getState().settings;
  return store.setSettings({
    companyName: values.companyName?.trim() || settings.companyName,
    rates: { ...settings.rates, USD: Number(values.usdRate) > 0 ? Number(values.usdRate) : settings.rates.USD },
    defaultAdvancePercent: clampPercent(values.defaultAdvancePercent ?? settings.defaultAdvancePercent),
    salaryDay: Math.min(28, Math.max(1, Number(values.salaryDay) || settings.salaryDay)),
    notifyDaysAhead: Math.min(60, Math.max(1, Number(values.notifyDaysAhead) || settings.notifyDaysAhead)),
  });
}

export function addCategory(groupId, label) {
  const settings = getState().settings;
  const id = `${groupId}/custom_${uid('c').slice(-6)}`;
  const customCategories = [...(settings.customCategories || []), { id, group: groupId, label: label.trim() }];
  store.setSettings({ customCategories });
  return id;
}

export function removeCategory(categoryId) {
  const settings = getState().settings;
  store.setSettings({
    customCategories: (settings.customCategories || []).filter((item) => item.id !== categoryId),
  });
}
