// Действия над данными: то, что нажимает пользователь.
// Здесь собраны все правила, из-за которых одна операция меняет несколько
// сущностей сразу (например, выплата сотруднику создаёт расход компании).

import * as store from './store.js';
import { op } from './ops.js';
import { toBase, defaultRate, round, formatAmount, isBase } from './money.js';
import { today, monthKey, monthLabel, addMonths, daysInMonth } from './dates.js';
import {
  assignmentState, assignmentStateIn, assignmentHasPayments, payrollMonthsFor, payrollState, clampPercent, projectPlan,
  projectSettledBase, founderDebt, employeeLoans,
} from './calc.js';
import { categoryLabel } from './model.js';

const { uid, getState } = store;

function money(values, settings) {
  const currency = values.currency || settings.baseCurrency;
  const fx = currency === settings.baseCurrency
    ? 1
    : (Number(values.fx) > 0 ? Number(values.fx) : defaultRate(currency, settings));
  const amount = round(values.amount);
  return { amount, currency, fx, base: toBase(amount, currency, fx) };
}

// Сумма в долларах по значениям формы — для проверок до сохранения.
export function baseOf(values) {
  return money(values, getState().settings).base;
}

// Имя того, кто внёс операцию (оба коллеги работают с одними данными).
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
  for (const barter of state.barters.filter((item) => item.clientId === id)) {
    ops.push(op.patch('barters', barter.id, { clientId: null }));
  }
  return store.commit(ops);
}

// ------------------------------------------------------------------ проекты

// План поступлений по умолчанию: аванс и остаток пополам (пункт 5 ТЗ).
export function defaultPaymentPlan(price, startDate, dueDate, percent = 50, currency = 'USD') {
  // Сомони — без копеек: иначе половины 46 162,5 + 46 162,5 на экране
  // выглядят как 46 163 + 46 163 и не сходятся с суммой договора.
  const raw = Number(price) * clampPercent(percent) / 100;
  const advance = currency === 'TJS' ? Math.round(raw) : round(raw);
  return [
    { id: uid('pay'), type: 'advance', title: 'Аванс', amount: advance, dueDate: startDate || today() },
    // Без срока сдачи остаток ставим через месяц после начала — иначе
    // новый проект сразу выглядел просроченным.
    { id: uid('pay'), type: 'final', title: 'Остаток', amount: round(Number(price) - advance), dueDate: dueDate || addMonths(startDate || today(), 1) },
  ];
}

// Пересчёт плана платежей проекта под новую цену (и валюту).
// Полученные платежи не меняются; разница ложится на неоплаченные,
// начиная с последнего, а если всё уже оплачено — отдельной строкой.
function replanOps(existing, record) {
  const state = getState();
  const receivedBase = projectSettledBase(existing, state.incomes.filter((item) => item.projectId === existing.id));
  const plan = projectPlan(existing, receivedBase).filter((item) => item.type !== 'extra');
  const fx = isBase(record.currency) ? 1 : (Number(record.fx) > 0 ? Number(record.fx) : 1);
  const whole = record.currency === 'TJS';
  const fit = (value) => (whole ? Math.round(value) : round(value));
  // Вниз — чтобы полученное не оказалось меньше суммы платежа из-за
  // округления (иначе висел бы «долг» в пять центов).
  const fitDown = (value) => (whole ? Math.floor(value + 1e-6) : Math.floor(value * 100 + 1e-6) / 100);
  const sameCurrency = existing.currency === record.currency;
  const rows = plan.map((item) => {
    const received = item.status === 'received';
    const coveredAmount = item.coveredBase / fx;
    let amount;
    if (sameCurrency) amount = Number(item.amount) || 0;
    else amount = received ? fitDown(coveredAmount) : fit(item.base / fx);
    const floor = received ? amount : Math.min(amount, fitDown(coveredAmount));
    return { item, amount, floor, received };
  });
  let diff = round(record.price - rows.reduce((acc, row) => acc + row.amount, 0));
  if (whole) diff = Math.round(diff);
  for (let index = rows.length - 1; index >= 0 && Math.abs(diff) > 0.004; index -= 1) {
    const row = rows[index];
    if (row.received) continue;
    if (diff > 0) {
      row.amount = round(row.amount + diff);
      diff = 0;
    } else {
      const room = round(row.amount - row.floor);
      if (room <= 0) continue;
      const cut = Math.min(room, -diff);
      row.amount = round(row.amount - cut);
      diff = round(diff + cut);
    }
  }
  const ops = [];
  for (const row of rows) {
    const amount = Math.max(0, whole ? Math.round(row.amount) : round(row.amount));
    // Платёж, сжавшийся до нуля и ничем не оплаченный, убираем совсем —
    // иначе в плане висела бы строка на $0.
    if (amount <= 0.004 && row.item.coveredBase <= 0.004) {
      ops.push(op.dropItem('projects', existing.id, 'payments', row.item.id));
      continue;
    }
    if (amount !== Number(row.item.amount)) {
      ops.push(op.putItem('projects', existing.id, 'payments', { id: row.item.id, amount }));
    }
  }
  // Сменили валюту договора — доп. работы пересчитываем в новую валюту,
  // иначе «10 000 сомони» превратились бы в «$10 000».
  if (!sameCurrency) {
    const oldFx = isBase(existing.currency) ? 1 : (Number(existing.fx) > 0 ? Number(existing.fx) : 1);
    for (const item of (existing.payments || []).filter((row) => row.type === 'extra')) {
      const amount = fit((Number(item.amount) || 0) * oldFx / fx);
      if (amount !== Number(item.amount)) ops.push(op.putItem('projects', existing.id, 'payments', { id: item.id, amount }));
    }
  }
  // Цену увеличили, а все платежи уже получены — доплата отдельной строкой.
  if (diff > 0.004) {
    ops.push(op.putItem('projects', existing.id, 'payments', {
      id: uid('pay'),
      type: 'final',
      title: 'Доплата по новой цене',
      amount: whole ? Math.round(diff) : round(diff),
      dueDate: record.dueDate && record.dueDate >= today() ? record.dueDate : today(),
    }));
  }
  return ops;
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
    // План платежей правится поштучно (putItem), чтобы правки двух
    // человек не затирали друг друга.
    if (!existing) return null;
    const ops = [op.patch('projects', id, record)];
    // Цену поменяли — план платежей подгоняем под новую цену, иначе
    // карточка проекта и «Платежи» расходятся. Уже полученные деньги
    // не трогаем: разница ложится на неоплаченные платежи, начиная
    // с последнего, а если всё уже оплачено — отдельной строкой.
    const oldPrice = Number(existing.price) || 0;
    if (oldPrice > 0 && (oldPrice !== record.price || existing.currency !== record.currency)) {
      ops.push(...replanOps(existing, record));
    } else if (oldPrice <= 0 && record.price > 0 && !(existing.payments || []).length) {
      for (const item of defaultPaymentPlan(record.price, record.startDate, record.dueDate, settings.defaultAdvancePercent, record.currency)) {
        ops.push(op.putItem('projects', id, 'payments', item));
      }
    }
    store.commit(ops);
    return store.byId('projects', id);
  }
  return store.insert('projects', {
    ...record,
    payments: defaultPaymentPlan(price.amount, record.startDate, record.dueDate, settings.defaultAdvancePercent, price.currency),
    createdBy: currentOwner(),
  }, 'prj');
}

export function setProjectStatus(id, status) {
  return store.patch('projects', id, { status });
}

export function savePlanItem(projectId, values, itemId = null) {
  const project = store.byId('projects', projectId);
  if (!project) return null;
  const record = {
    id: itemId || uid('pay'),
    type: values.type || 'final',
    title: values.title?.trim() || '',
    amount: round(values.amount),
    dueDate: values.dueDate || today(),
  };
  return store.commit(op.putItem('projects', projectId, 'payments', record));
}

export function deletePlanItem(projectId, itemId) {
  const project = store.byId('projects', projectId);
  if (!project) return null;
  return store.commit(op.dropItem('projects', projectId, 'payments', itemId));
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
    payType: ['piecework', 'percent'].includes(values.payType) ? values.payType : 'fixed',
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
  } else if (record.payType === 'percent') {
    // Доля от суммы каждого проекта, на который сотрудника добавят.
    Object.assign(record, { percent: clampPercent(values.percent || 50), rate: 0, salary: 0 });
  } else {
    const rate = money({ amount: values.rate, currency: values.rateCurrency, fx: values.rateFx }, settings);
    Object.assign(record, {
      rate: rate.amount,
      rateCurrency: rate.currency,
      rateFx: rate.fx,
      salary: 0,
    });
  }
  // С какого месяца начислять зарплату. Новому сотруднику — с месяца,
  // когда его завели (прошлые месяцы, как правило, уже выплачены вне
  // программы), а при возвращении из «неактивных» — с месяца возвращения,
  // а не за всё время перерыва.
  const existing = id ? store.byId('employees', id) : null;
  const state = getState();
  if (!existing) {
    // С сегодняшнего дня, если начало уже прошло (месяц всё равно начисляется
    // целиком — от этой даты зависит только срок первой выплаты).
    record.activeFrom = record.startDate > today() ? record.startDate : today();
  } else if ((existing.active === false && record.active)
    || (existing.payType !== 'fixed' && record.payType === 'fixed')) {
    // Вернули из «неактивных» или перевели со сдельной / с процента на
    // зарплату — начисляем с этого месяца (или с будущей даты начала),
    // а не за всё время перерыва или работы по другой схеме.
    record.activeFrom = record.startDate > today() ? record.startDate : today();
  } else if (!existing.activeFrom) {
    // Сотрудник заведён до этого правила. Если перенести «Работает с»
    // в прошлое, не начисляем задним числом месяцы, которых раньше не было:
    // начисления идут с самого раннего уже существующего месяца.
    const first = state.payrolls
      .filter((item) => item.employeeId === id)
      .map((item) => item.month)
      .sort()[0];
    record.activeFrom = first ? `${first}-01` : today();
  }
  const saved = id ? store.patch('employees', id, record) : store.insert('employees', record, 'emp');
  // Зарплату изменили — начисление текущего месяца, по которому ещё ничего
  // не выплачено, пересчитываем по новой сумме.
  if (existing && record.payType === 'fixed'
    && (existing.salary !== record.salary || existing.salaryCurrency !== record.salaryCurrency)) {
    const current = state.payrolls.find((item) => item.employeeId === id && item.month === monthKey(today()));
    if (current && !(current.payments || []).length) {
      const fx = record.salaryCurrency === state.settings.baseCurrency ? 1 : defaultRate(record.salaryCurrency, state.settings);
      store.patch('payrolls', current.id, {
        amount: round(record.salary),
        currency: record.salaryCurrency,
        fx,
        accruedBase: toBase(record.salary, record.salaryCurrency, fx),
      });
    }
  }
  // Перевели с зарплаты на сдельную или на процент — начисление текущего
  // месяца, по которому ещё ничего не выплачено, больше не нужно.
  if (existing && existing.payType === 'fixed' && record.payType !== 'fixed') {
    const current = state.payrolls.find((item) => item.employeeId === id && item.month === monthKey(today()));
    // Срок уже наступил — это долг сотруднику, его не трогаем.
    if (current && !(current.payments || []).length && current.dueDate > today()) {
      store.remove('payrolls', current.id);
    }
  }
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
  // Проведённые выплаты и выданные авансы остаются в расходах как факт
  // и как расход проекта.
  for (const expense of state.expenses.filter((item) => item.employeeId === id && item.source)) {
    if (['assignment', 'payroll', 'loan'].includes(expense.source)) {
      ops.push(op.patch('expenses', expense.id, { assignmentId: null, payrollId: null, source: null }));
    }
  }
  return store.commit(ops);
}

// ------------------------------------------- сдельные назначения на проект

export function saveAssignment(values, id = null) {
  const state = getState();
  const settings = state.settings;
  const employee = store.byId('employees', values.employeeId);
  // Сотрудник на проценте: храним только долю, сумма считается от цены
  // проекта (и меняется вместе с ней).
  if (values.mode === 'percent') {
    const project = store.byId('projects', values.projectId);
    const record = {
      projectId: values.projectId,
      employeeId: values.employeeId,
      role: values.role?.trim() || employee?.position || 'Сотрудник',
      mode: 'percent',
      percent: clampPercent(values.percent === '' || values.percent == null ? (employee?.percent || 50) : values.percent),
      currency: project?.currency || settings.baseCurrency,
      fx: project?.fx || 1,
      area: 0,
      rate: 0,
      advancePercent: 0,
    };
    if (id) {
      const existing = store.byId('assignments', id);
      if (existing && assignmentHasPayments(existing)) record.employeeId = existing.employeeId;
      return store.patch('assignments', id, record);
    }
    return store.insert('assignments', { stage: 'assigned', ...record }, 'asg');
  }
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
    advancePercent: clampPercent(values.advancePercent === '' || values.advancePercent == null
      ? settings.defaultAdvancePercent : values.advancePercent),
  };
  // Этап при правке не трогаем: исправление площади не должно снова
  // закрывать остаток, уже одобренный клиентом.
  if (values.stage) record.stage = values.stage;
  if (id) {
    const existing = store.byId('assignments', id);
    if (existing && assignmentHasPayments(existing)) {
      record.employeeId = existing.employeeId;
      // По «процентной» работе уже платили — сдельной она не становится.
      if (existing.mode === 'percent') return existing;
    }
    // Была «процентной» — теперь сдельная: признак процента убираем.
    return store.patch('assignments', id, { ...record, mode: 'piecework' }, ['percent']);
  }
  return store.insert('assignments', { stage: 'assigned', ...record }, 'asg');
}

export function setAssignmentStage(id, stage) {
  return store.patch('assignments', id, { stage });
}

export function deleteAssignment(id) {
  const state = getState();
  // Уже проведённые выплаты остаются в расходах компании как факт.
  const ops = [op.remove('assignments', id)];
  // Выплата перестаёт быть «выплатой по назначению» и остаётся обычным
  // расходом проекта — иначе она пропала бы из себестоимости проекта.
  for (const expense of state.expenses.filter((item) => item.assignmentId === id)) {
    ops.push(op.patch('expenses', expense.id, { assignmentId: null, source: null }));
  }
  return store.commit(ops);
}

// ------------------------------------------- авансы сотрудникам (в долг)

// Аванс в счёт будущих выплат: деньги ушли из кассы (расход), сотрудник
// их потом отрабатывает — при выплате их удерживают из аванса.
function loanRecord(employee, payment, values, comment) {
  return {
    id: uid('exp'),
    date: values.date || today(),
    category: 'staff/loan',
    ...payment,
    projectId: null,
    employeeId: employee?.id || null,
    source: 'loan',
    method: values.method || 'cash',
    comment: values.comment?.trim() || comment,
    createdBy: currentOwner(),
    createdAt: today(),
  };
}

export function giveLoan(employeeId, values = {}) {
  const employee = store.byId('employees', employeeId);
  if (!employee) return { ok: false, error: 'Сотрудник не найден' };
  const payment = money(values, getState().settings);
  if (payment.base <= 0) return { ok: false, error: 'Укажите сумму больше нуля' };
  const expense = loanRecord(employee, payment, values, `Аванс в счёт будущих выплат · ${employee.name}`);
  store.commit([op.insert('expenses', expense)]);
  return { ok: true, expense };
}

// Больше ли выплата, чем причитается (limit — в валюте обязательства
// и в долларах). В валюте обязательства сравниваем сами суммы, в другой —
// доллары с допуском в цент на округление пересчёта.
function overLimit(payment, limit) {
  return payment.currency === limit.currency
    ? payment.amount > limit.amount + 0.005
    : payment.base > limit.base + 0.01;
}

// Делит выплату на часть в счёт долга и часть сверх него (в валюте выплаты).
function splitOverpay(payment, limit) {
  if (!overLimit(payment, limit)) return { paid: payment, extra: null };
  const paidAmount = Math.max(0, Math.min(payment.amount, payment.currency === limit.currency
    ? round(limit.amount)
    : round(limit.base / payment.fx)));
  const paidBase = toBase(paidAmount, payment.currency, payment.fx);
  return {
    paid: paidAmount > 0 ? { ...payment, amount: paidAmount, base: paidBase } : null,
    extra: { ...payment, amount: round(payment.amount - paidAmount), base: round(payment.base - paidBase) },
  };
}

// Удержать сумму из авансов сотрудника (старые первыми). От записи аванса
// отделяется часть — она станет выплатой с датой и способом оплаты аванса:
// деньги ушли тогда, сейчас их просто зачли.
// Считаем в валюте обязательства и по его курсу (limit.fx): начисление
// пересчитывает выплаты в другой валюте именно так. settle — сколько
// зачтено в валюте обязательства: отметка о выплате пишется в ней, чтобы
// не оставалось «хвостов» вроде 0,02 сомони из-за округления долларов.
function withholdFromLoans(state, employeeId, payment, limit) {
  const owedFx = Number(limit.fx) > 0 ? Number(limit.fx) : 1;
  let left = round(payment.currency === limit.currency ? payment.amount : payment.base / owedFx);
  const pieces = [];
  const ops = [];
  for (const loan of employeeLoans(state, employeeId).items) {
    if (left * owedFx <= 0.005) break;
    let take;
    let settled;
    if (loan.currency === limit.currency) {
      take = round(Math.min(left, loan.amount));
      settled = take;
    } else if (left * owedFx < loan.base - 0.005) {
      take = round(left * owedFx / loan.fx);
      settled = left;
    } else {
      take = loan.amount;
      settled = round(loan.base / owedFx);
    }
    if (!(take > 0)) continue;
    left = round(left - settled);
    const whole = take >= loan.amount - 0.005;
    const amount = whole ? loan.amount : take;
    const base = whole ? loan.base : toBase(take, loan.currency, loan.fx);
    const id = uid('exp');
    pieces.push({
      id,
      loan,
      money: { amount, currency: loan.currency, fx: loan.fx, base },
      settle: { amount: settled, currency: limit.currency, fx: owedFx, base },
    });
    // Разница, а не новая сумма: удержания с двух телефонов складываются.
    // Однократно — пока выплаты-части ещё нет.
    ops.push(op.adjust('expenses', loan.id, { amount: -amount, base: -base }, {
      dropIfZero: 'amount',
      guard: { collection: 'expenses', id, exists: false },
      record: loan,
    }));
  }
  // Копейки от пересчёта целого аванса по другому курсу относим к последней
  // части: зачтено должно быть ровно столько, сколько ввели, — иначе
  // осталось бы, например, 0,02 сомони, которые не выплатить.
  if (pieces.length && Math.abs(left * owedFx) <= 0.011) {
    const last = pieces[pieces.length - 1].settle;
    last.amount = round(last.amount + left);
    left = 0;
  }
  return { pieces, ops, short: left * owedFx > 0.01 };
}

// Записи выплаты сотруднику. values.from === 'loan' — удержать из аванса
// (новых денег не уходит), иначе деньгами; то, что сверх долга, — аванс
// в счёт будущих выплат. makeExpense(часть) строит расход, makeItem(расход) —
// отметку о выплате в начислении или работе.
function payout(state, employee, payment, values, limit, makeExpense, makeItem) {
  const ops = [];
  const parts = [];
  let extraMoney = null;
  if (values.from === 'loan') {
    if (overLimit(payment, limit)) {
      return { ok: false, error: `Из аванса можно удержать не больше того, что причитается: ${formatAmount(limit.amount, limit.currency)}` };
    }
    const held = withholdFromLoans(state, employee?.id, payment, limit);
    if (held.short) {
      const loans = employeeLoans(state, employee?.id);
      return {
        ok: false,
        error: loans.base > 0
          ? `Аванса осталось ${loans.byCurrency.map((item) => formatAmount(item.amount, item.currency)).join(' + ')} — больше удержать нельзя`
          : 'У сотрудника нет аванса',
      };
    }
    ops.push(...held.ops);
    for (const piece of held.pieces) {
      parts.push({
        id: piece.id, money: piece.money, settle: piece.settle,
        date: piece.loan.date, method: piece.loan.method || 'cash', loan: piece.loan,
      });
    }
  } else {
    const { paid, extra } = splitOverpay(payment, limit);
    if (paid) parts.push({ money: paid, date: values.date || today(), method: values.method || 'cash' });
    if (extra) {
      extraMoney = extra;
      ops.push(op.insert('expenses', loanRecord(employee, extra, { ...values, comment: '' },
        `Аванс сверх начисленного · ${employee?.name || ''}`.trim())));
    }
  }
  let first = null;
  for (const part of parts) {
    const expense = {
      ...makeExpense(part),
      id: part.id || uid('exp'),
      date: part.date,
      ...part.money,
      method: part.method,
      createdBy: currentOwner(),
      createdAt: today(),
    };
    if (part.loan) {
      // Чтобы при удалении удержания вернуть сумму в аванс.
      Object.assign(expense, { loanId: part.loan.id, loanDate: part.loan.date, loanComment: part.loan.comment || '' });
      if (!values.comment) expense.comment = `${expense.comment} · из аванса`;
    }
    first = first || expense;
    ops.push(op.insert('expenses', expense), makeItem(expense, part.settle || part.money));
  }
  store.commit(ops);
  return { ok: true, expense: first, extra: extraMoney };
}

// Выплата доли сотруднику на проценте: не больше того, что уже заработано
// оплатами клиента (студия не платит долю вперёд из своих денег).
function payShare(assignment, project, info, values) {
  const state = getState();
  const payment = money({
    amount: values.amount ?? info.available,
    currency: values.currency || info.currency,
    fx: values.fx ?? (isBase(info.currency) ? 1 : project?.fx),
  }, state.settings);
  if (payment.base <= 0) return { ok: false, error: 'Укажите сумму больше нуля' };
  // Сверх доступной доли — это уже аванс сотруднику в счёт будущих выплат.
  const employee = store.byId('employees', assignment.employeeId);
  return payout(state, employee, payment, values,
    {
      amount: info.available,
      currency: info.currency,
      base: info.availableBase,
      fx: isBase(info.currency) ? 1 : (Number(project?.fx) > 0 ? Number(project.fx) : 1),
    },
    () => ({
      category: 'staff/share',
      projectId: assignment.projectId,
      employeeId: assignment.employeeId,
      assignmentId: assignment.id,
      source: 'assignment',
      comment: values.comment || `Доля ${info.percent}% · ${employee?.name || ''} · ${project?.name || ''}`.trim(),
    }),
    (expense, settle) => op.putItem('assignments', assignment.id, 'payments', {
      id: uid('apt'), expenseId: expense.id, part: 'share', date: values.date || today(),
      amount: settle.amount, currency: settle.currency, base: settle.base,
    }));
}

// Выплата аванса или остатка сдельному сотруднику.
// Правило 5 ТЗ: фактическая выплата сразу становится расходом компании.
export function payAssignment(assignmentId, part, values = {}) {
  const state = getState();
  const assignment = store.byId('assignments', assignmentId);
  if (!assignment) return { ok: false, error: 'Назначение не найдено' };
  const project = store.byId('projects', assignment.projectId);
  const info = assignmentStateIn(state, assignment, project);
  if (info.mode === 'percent') return payShare(assignment, project, info, values);

  if (part === 'advance' && info.advancePaid) return { ok: false, error: 'Аванс уже выплачен' };
  if (part === 'final') {
    if (info.remainderBase <= 0.01) return { ok: false, error: 'Остаток уже выплачен' };
    if (!info.remainderAvailable) {
      return { ok: false, error: 'Остаток станет доступен после того, как клиент одобрит работу' };
    }
  }

  const fallbackAmount = part === 'advance' ? info.advanceLeft : info.remainder;
  const payment = money({
    amount: values.amount ?? fallbackAmount,
    currency: values.currency || assignment.currency,
    fx: values.fx ?? assignment.fx,
  }, state.settings);
  if (payment.base <= 0) return { ok: false, error: 'Укажите сумму больше нуля' };
  // Сколько причитается за работу. Аванс — не больше того, что ещё не
  // выплачено остатком (остаток могли отдать раньше аванса). Всё, что
  // сверх, — аванс сотруднику в счёт будущих выплат.
  const limit = part === 'advance'
    ? {
      amount: round(Math.max(0, info.accrued - info.finalPaidCur - info.advancePaidCur)),
      currency: assignment.currency,
      base: round(Math.max(0, info.accruedBase - info.finalPaidBase - info.advancePaidBase)),
      fx: assignment.fx,
    }
    : { amount: info.remainder, currency: assignment.currency, base: info.remainderBase, fx: assignment.fx };

  const employee = store.byId('employees', assignment.employeeId);
  // Каждая выплата — отдельной строкой в payments: остаток можно отдать
  // частями, а удаление одной выплаты убирает только её.
  const result = payout(state, employee, payment, values, limit,
    () => ({
      category: part === 'advance' ? 'staff/advance' : 'staff/final',
      projectId: assignment.projectId,
      employeeId: assignment.employeeId,
      assignmentId: assignment.id,
      source: 'assignment',
      comment: values.comment
        || `${part === 'advance' ? 'Аванс' : 'Остаток'} · ${employee?.name || ''} · ${project?.name || ''}`.trim(),
    }),
    (expense, settle) => op.putItem('assignments', assignmentId, 'payments', {
      id: uid('apt'), expenseId: expense.id, part, date: values.date || today(),
      amount: settle.amount, currency: settle.currency, base: settle.base,
    }));
  if (result.ok && part === 'final') store.patch('assignments', assignmentId, { stage: 'approved' });
  return result;
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
        // Начисление в сомони — по курсу НБТ на момент начисления,
        // а не по курсу того дня, когда карточку сотрудника сохранили.
        const fx = employee.salaryCurrency === state.settings.baseCurrency
          ? 1
          : defaultRate(employee.salaryCurrency, state.settings);
        const payday = Math.min(
          Number(employee.payday) || Number(state.settings.salaryDay) || 5,
          daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1),
        );
        let dueDate = `${month}-${String(payday).padStart(2, '0')}`;
        // Срок выплаты не раньше, чем сотрудник появился в программе:
        // иначе новый сотрудник в день добавления уже «просрочен».
        const since = employee.activeFrom || employee.startDate || '';
        // Начал работать после дня зарплаты — за этот месяц платим
        // в день зарплаты следующего месяца.
        if (since && dueDate < since) {
          const next = addMonths(`${month}-01`, 1);
          const nextDay = Math.min(payday, daysInMonth(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1));
          dueDate = `${next.slice(0, 7)}-${String(nextDay).padStart(2, '0')}`;
        }
        const record = {
          // Один сотрудник — одно начисление за месяц. Постоянный номер
          // не даёт двум телефонам начислить один месяц дважды:
          // сервер просто пропустит вторую такую запись.
          id: `pyr_${employee.id}_${month}`,
          employeeId: employee.id,
          month,
          amount: round(employee.salary),
          currency: employee.salaryCurrency || state.settings.baseCurrency,
          fx,
          accruedBase: toBase(employee.salary, employee.salaryCurrency, fx),
          dueDate,
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
  // В валюте начисления сравниваем сами суммы: 5001 сомони при долге
  // 5000 — это переплата, хоть в долларах разница и меньше цента-двух.
  const paidInCurrency = (payroll.payments || []).reduce((total, item) => total + (item.currency === payroll.currency
    ? Number(item.amount) || 0
    : (Number(item.base) || 0) / (Number(payroll.fx) || 1)), 0);
  const leftInCurrency = isBase(payroll.currency)
    ? info.leftBase
    : Math.max(0, round((Number(payroll.amount) || 0) - paidInCurrency));

  // Сверх начисленного — аванс сотруднику в счёт будущих выплат.
  const employee = store.byId('employees', payroll.employeeId);
  return payout(state, employee, payment, values,
    { amount: leftInCurrency, currency: payroll.currency, base: info.leftBase, fx: payroll.fx },
    () => ({
      category: 'staff/salary',
      projectId: null,
      employeeId: payroll.employeeId,
      payrollId: payroll.id,
      source: 'payroll',
      comment: values.comment || `Зарплата · ${employee?.name || ''} · ${monthLabel(payroll.month)}`.trim(),
    }),
    (expense, settle) => op.putItem('payrolls', payrollId, 'payments', {
      id: uid('prt'),
      date: values.date || today(),
      expenseId: expense.id,
      amount: settle.amount,
      currency: settle.currency,
      fx: settle.fx,
      base: settle.base,
    }));
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
    // Без проекта не бывает «аванса проекта» — это прочий доход.
    type: values.projectId
      ? (values.type || 'advance')
      : (['advance', 'final'].includes(values.type) || !values.type ? 'other' : values.type),
    method: values.method || 'cash',
    // Приход по взаимозачёту привязан к имуществу, с которого списывается.
    barterId: values.method === 'barter' ? (values.barterId || null) : null,
    // Деньги, которыми клиент доплатил сверх стоимости имущества.
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
  if (!expense) return { ok: false, error: 'Операция не найдена' };
  if (expense.source === 'founder' && expense.founderMoveId) {
    const problem = spendDeleteProblem(state, store.byId('draws', expense.founderMoveId));
    if (problem) return { ok: false, error: problem };
  }
  const ops = [op.remove('expenses', id)];

  if (expense.source === 'assignment' && expense.assignmentId) {
    const assignment = state.assignments.find((item) => item.id === expense.assignmentId);
    if ((assignment?.payments || []).some((item) => item.expenseId === id)) {
      ops.push(op.dropItem('assignments', assignment.id, 'payments', id));
    }
    if (assignment?.advanceExpenseId === id) {
      ops.push(op.patch('assignments', assignment.id, {}, ['advanceExpenseId', 'advancePaidAt', 'advancePaidBase']));
    }
    if (assignment?.remainderExpenseId === id) {
      ops.push(op.patch('assignments', assignment.id, {}, ['remainderExpenseId', 'remainderPaidAt', 'remainderPaidBase']));
    }
  }
  if (expense.source === 'payroll' && expense.payrollId) {
    const payroll = state.payrolls.find((item) => item.id === expense.payrollId);
    if (payroll) {
      ops.push(op.dropItem('payrolls', payroll.id, 'payments', id));
    }
  }
  if (expense.source === 'planned' && expense.plannedId) {
    const planned = state.planned.find((item) => item.id === expense.plannedId);
    if (planned) {
      ops.push(op.patch('planned', planned.id, { status: 'planned' }, ['expenseId']));
    }
  }
  // Расход, оплаченный коллегой, связан с записью о его деньгах:
  // удаляем обе, иначе долг студии останется висеть без основания.
  if (expense.source === 'founder' && expense.founderMoveId) {
    ops.push(op.remove('draws', expense.founderMoveId));
  }
  // Удержание из аванса отменили — деньги снова числятся авансом сотрудника
  // (из кассы они ушли, просто ещё не отработаны). Разницей и однократно —
  // пока сама выплата-часть ещё есть, поэтому идёт первой в пакете.
  if (expense.loanId && state.employees.some((item) => item.id === expense.employeeId)) {
    const loan = state.expenses.find((item) => item.id === expense.loanId);
    const sameLoan = !loan || (loan.source === 'loan' && loan.currency === expense.currency);
    const loanId = sameLoan ? expense.loanId : uid('exp');
    ops.unshift(op.adjust('expenses', loanId, { amount: Number(expense.amount) || 0, base: Number(expense.base) || 0 }, {
      guard: { collection: 'expenses', id: expense.id, exists: true },
      record: {
        id: loanId,
        date: expense.loanDate || expense.date,
        category: 'staff/loan',
        currency: expense.currency,
        fx: expense.fx,
        projectId: null,
        employeeId: expense.employeeId,
        source: 'loan',
        method: expense.method || 'cash',
        comment: expense.loanComment || 'Аванс в счёт будущих выплат',
        createdBy: expense.createdBy || currentOwner(),
        createdAt: today(),
      },
    }));
  }
  store.commit(ops);
  return { ok: true };
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
  };
  // Число месяца, к которому привязан ежемесячный платёж: 31-го в феврале
  // платим 28-го, а в марте — снова 31-го, а не 28-го навсегда.
  record.anchorDay = Number(String(record.dueDate).slice(8, 10)) || 1;
  // Правка не должна снова делать оплаченный платёж неоплаченным.
  if (values.status) record.status = values.status;
  if (id) return store.patch('planned', id, record);
  return store.insert('planned', { status: 'planned', ...record }, 'pln');
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
  if (planned.status === 'paid') return { ok: false, error: 'Этот платёж уже оплачен' };
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
    const anchor = Number(planned.anchorDay) || Number(String(planned.dueDate).slice(8, 10)) || 1;
    const nextMonth = addMonths(`${String(planned.dueDate).slice(0, 7)}-01`, 1);
    const year = Number(nextMonth.slice(0, 4));
    const month = Number(nextMonth.slice(5, 7));
    const day = Math.min(anchor, daysInMonth(year, month - 1));
    const nextDate = `${nextMonth.slice(0, 7)}-${String(day).padStart(2, '0')}`;
    // Постоянный номер следующего платежа: если два человека оплатят
    // один и тот же месяц, следующий всё равно появится один.
    const series = planned.seriesId || planned.id;
    const exists = state.planned.some(
      (item) => (item.seriesId || item.id) === series && item.dueDate.slice(0, 7) === nextDate.slice(0, 7),
    ) || state.planned.some(
      (item) => item.title === planned.title && item.category === planned.category && item.dueDate === nextDate,
    );
    if (!exists) {
      const { expenseId: _paid, ...rest } = planned;
      ops.push(op.insert('planned', {
        ...rest,
        id: `${series}_${nextDate.slice(0, 7)}`,
        seriesId: series,
        anchorDay: anchor,
        dueDate: nextDate,
        status: 'planned',
        createdAt: today(),
      }));
    }
  }
  store.commit(ops);
  return { ok: true, expense };
}

// --------------------------------------------------------- взаиморасчёты

// Имущество, которым рассчитывается клиент: квартира, машина, материалы.
// Записываем его оценку, а дальше выполненные работы списываются с неё.
export function saveBarter(values, id = null) {
  const settings = getState().settings;
  const value = money(values, settings);
  const record = {
    clientId: values.clientId || null,
    title: values.title?.trim() || 'Взаимозачёт',
    kind: values.kind || 'property',
    ...value,
    date: values.date || today(),
    note: values.note?.trim() || '',
  };
  if (id) return store.patch('barters', id, record);
  return store.insert('barters', { ...record, createdBy: currentOwner() }, 'brt');
}

export function deleteBarter(id) {
  const state = getState();
  // Уже зачтённые работы остаются доходом — просто перестают быть
  // привязанными к имуществу.
  const ops = [op.remove('barters', id)];
  for (const income of state.incomes.filter((item) => item.barterId === id)) {
    ops.push(op.patch('incomes', income.id, { barterId: null }));
  }
  return store.commit(ops);
}

// -------------------------------------------------------------- коллеги

export function saveFounder(values, id = null) {
  const record = {
    name: values.name?.trim() || 'Коллега',
    role: values.role?.trim() || '',
    note: values.note?.trim() || '',
  };
  if (id) return store.patch('founders', id, record);
  return store.insert('founders', record, 'fnd');
}

export function deleteFounder(id) {
  const state = getState();
  // Вклады и долги — история денег студии: молча стереть их вместе
  // с коллегой нельзя, иначе «Осталось в студии» изменится без движения денег.
  const money = state.draws.filter((item) => item.founderId === id && ['invest', 'spend'].includes(item.kind));
  if (money.length) {
    return { ok: false, error: 'У коллеги есть вклады или оплаты за студию. Сначала удалите эти операции в его карточке' };
  }
  const ops = [op.remove('founders', id)];
  for (const draw of state.draws.filter((item) => item.founderId === id)) {
    ops.push(op.remove('draws', draw.id));
  }
  // Расходы, которые коллега оплатил за студию, остаются расходами
  // студии — но уже обычными, которые можно открыть и исправить.
  for (const expense of state.expenses.filter((item) => item.source === 'founder' && item.paidByFounderId === id)) {
    ops.push(op.patch('expenses', expense.id, { source: null }, ['founderMoveId', 'paidByFounderId']));
  }
  store.commit(ops);
  return { ok: true };
}

// Движение денег между студией и коллегой. Три случая, и считаются
// они по-разному:
//   draw  — взял для себя: доля прибыли, на прибыль студии не влияет;
//   spend — оплатил расход студии своими деньгами: это настоящий расход
//           студии, поэтому заводится ещё и запись в расходах, а студия
//           остаётся должна коллеге;
//   repay — студия вернула ему потраченное: гасит этот долг.
export function saveDraw(values, id = null) {
  const state = getState();
  const settings = state.settings;
  const payment = money(values, settings);
  const kind = ['draw', 'spend', 'repay', 'invest'].includes(values.kind) ? values.kind : 'draw';
  // Вклад: деньгами в кассу или оплатой расхода за студию.
  const investWay = kind === 'invest' ? (values.investWay === 'cash' ? 'cash' : 'paid') : null;
  // Расход студии появляется, когда коллега сам заплатил за студию:
  // в долг («Оплатил из своих») или как вклад («Вложил — оплатил за студию»).
  const paysExpense = kind === 'spend' || investWay === 'paid';
  const founder = store.byId('founders', values.founderId);
  if (!values.founderId) return { ok: false, error: 'Выберите коллегу' };

  const existing = id ? store.byId('draws', id) : null;
  if (!(payment.base > 0)) return { ok: false, error: 'Укажите сумму больше нуля' };
  // Вернуть можно только то, что студия должна: иначе деньги уходят
  // из кассы и не попадают ни в одну сумму.
  if (kind === 'repay') {
    // Долг считаем в его валюте: 2000 сомони возвращаются 2000 сомони
    // по любому курсу.
    const others = (state.draws || []).filter((item) => item.founderId === values.founderId && item.id !== id);
    const owed = founderDebt(others).owedBase;
    if (founderDebt([...others, { kind: 'repay', ...payment }]).overBase > 0.01) {
      return {
        ok: false,
        error: owed > 0
          ? `${founder?.name || 'Учредитель'}: студия должна ${formatAmount(owed)} — больше вернуть нельзя`
          : `${founder?.name || 'Учредитель'}: долга студии нет — вложенное уже вернули или вкладов не было. Если деньги взяли себе, выберите «Взял для себя»`,
      };
    }
  }
  // Уменьшили или убрали расход, по которому студия уже вернула деньги, —
  // возвращённое оказалось бы больше долга, и разница нигде бы не числилась.
  if (existing && ['spend', 'invest'].includes(existing.kind || 'draw')) {
    const stillOwed = ['spend', 'invest'].includes(kind) && values.founderId === existing.founderId;
    const overflow = repayOverflow(state, existing.founderId, id, stillOwed ? { kind, ...payment } : null);
    if (overflow > 0.01) {
      return {
        ok: false,
        error: stillOwed
          ? `Учредителю уже вернули больше — сумма не может быть меньше на ${formatAmount(overflow)}`
          : values.founderId !== existing.founderId && ['spend', 'invest'].includes(kind)
            ? 'Из этих денег учредителю уже возвращали. Чтобы перенести вклад на другого учредителя, сначала удалите запись «Забрал вложенное»'
            : 'Из этих денег учредителю уже возвращали. Чтобы сменить тип операции, сначала удалите запись «Забрал вложенное»',
      };
    }
  }
  const drawId = id || uid('drw');
  const record = {
    founderId: values.founderId,
    date: values.date || today(),
    ...payment,
    kind,
    method: values.method || 'cash',
    category: paysExpense ? (values.category || 'other/misc') : null,
    projectId: paysExpense ? (values.projectId || null) : null,
    investWay,
    comment: values.comment?.trim() || '',
  };

  const ops = [];
  // Расход студии, оплаченный коллегой, должен попасть в общие расходы —
  // иначе прибыль окажется завышенной.
  if (paysExpense) {
    const expenseId = existing?.expenseId || uid('exp');
    const expense = {
      id: expenseId,
      date: record.date,
      category: record.category,
      projectId: record.projectId,
      ...payment,
      method: record.method,
      source: 'founder',
      founderMoveId: drawId,
      paidByFounderId: record.founderId,
      comment: record.comment
        || `${kind === 'invest' ? 'Вклад' : 'Оплатил'} ${founder?.name || 'коллега'} · ${categoryLabel(record.category, settings)}`,
      createdBy: currentOwner(),
      createdAt: today(),
    };
    ops.push(existing?.expenseId
      ? op.patch('expenses', expenseId, expense)
      : op.insert('expenses', expense));
    record.expenseId = expenseId;
  } else if (existing?.expenseId) {
    // Тип поменяли — связанный расход больше не нужен.
    ops.push(op.remove('expenses', existing.expenseId));
    record.expenseId = null;
  }

  ops.push(existing
    ? op.patch('draws', drawId, record)
    : op.insert('draws', { id: drawId, ...record, createdBy: currentOwner() }));
  store.commit(ops);
  return { ok: true };
}

// Насколько возвращённое коллеге превысит его расходы за студию, если
// запись ignoreId убрать (и при желании добавить расход extraSpend).
// Насколько возвращённое коллеге превысит его расходы за студию, если
// запись ignoreId убрать, а вместо неё учесть extra (новую или исправленную).
function repayOverflow(state, founderId, ignoreId, extra = null) {
  const others = (state.draws || []).filter((item) => item.founderId === founderId && item.id !== ignoreId);
  return founderDebt(extra ? [...others, extra] : others).overBase;
}

function spendDeleteProblem(state, draw) {
  if (!draw || !['spend', 'invest'].includes(draw.kind || 'draw')) return null;
  const overflow = repayOverflow(state, draw.founderId, draw.id);
  return overflow > 0.01
    ? 'Учредителю уже вернули эти деньги. Сначала удалите или уменьшите запись «Забрал вложенное».'
    : null;
}

export function deleteDraw(id) {
  const draw = store.byId('draws', id);
  const problem = spendDeleteProblem(getState(), draw);
  if (problem) return { ok: false, error: problem };
  const ops = [op.remove('draws', id)];
  if (draw?.expenseId) ops.push(op.remove('expenses', draw.expenseId));
  store.commit(ops);
  return { ok: true };
}

// ------------------------------------------------------------ настройки

export function saveSettings(values) {
  const settings = getState().settings;
  return store.setSettings({
    companyName: (values.companyName?.trim() || settings.companyName).slice(0, 120),
    usdRate: Number(values.usdRate) > 0 ? Number(values.usdRate) : settings.usdRate,
    // Курс, введённый руками, помечаем — чтобы было видно, что он не с сайта НБТ.
    ...(Number(values.usdRate) > 0 && Number(values.usdRate) !== settings.usdRate
      ? { usdRateSource: 'manual', usdRateDate: today() }
      : {}),
    defaultAdvancePercent: clampPercent(values.defaultAdvancePercent ?? settings.defaultAdvancePercent),
    // День выплаты до 31: в коротких месяцах он сам сдвигается на последний день.
    salaryDay: Math.min(31, Math.max(1, Math.round(Number(values.salaryDay)) || settings.salaryDay)),
    // 0 — «напоминать в тот же день», это допустимое значение.
    notifyDaysAhead: values.notifyDaysAhead === '' || !Number.isFinite(Number(values.notifyDaysAhead))
      ? settings.notifyDaysAhead
      : Math.min(60, Math.max(0, Math.round(Number(values.notifyDaysAhead)))),
  });
}

// Курс, полученный с сайта Национального банка. Приходит с сервера.
export function applyNbtRate(rate) {
  if (!rate || !(Number(rate.value) > 0)) return null;
  return store.setSettings({
    usdRate: Number(rate.value),
    usdRateDate: rate.date || today(),
    usdRateSource: 'nbt',
    usdRateCheckedAt: new Date().toISOString(),
  });
}

export function addCategory(groupId, label) {
  const settings = getState().settings;
  const id = `${groupId}/custom_${uid('c').slice(-6)}`;
  const customCategories = [...(settings.customCategories || []), { id, group: groupId, label: label.trim().slice(0, 120) }];
  store.setSettings({ customCategories });
  return id;
}

export function removeCategory(categoryId) {
  const state = getState();
  const settings = state.settings;
  // Если по категории уже есть записи, оставляем её название для истории.
  const used = [...state.expenses, ...(state.planned || []), ...(state.draws || [])]
    .some((item) => item.category === categoryId);
  store.setSettings({
    customCategories: (settings.customCategories || [])
      .map((item) => (item.id === categoryId && used ? { ...item, removed: true } : item))
      .filter((item) => item.id !== categoryId || used),
  });
}
