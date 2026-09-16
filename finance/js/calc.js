// Финансовый движок: все производные величины считаются здесь,
// в данных хранятся только факты (операции, назначения, начисления).
//
// Главные правила:
//   • Начислено ≠ Выплачено, Должны получить ≠ Получено.
//   • Остаток сдельного сотрудника доступен только после одобрения клиентом.
//   • Общие расходы компании не распределяются по проектам автоматически.

import { toBase, round } from './money.js';
import {
  today, monthKey, monthStart, monthEnd, addMonths, monthKeysBetween, inRange, formatDate, monthLabel,
} from './dates.js';
import {
  CLIENT_APPROVED_STATUSES, CLOSED_PROJECT_STATUSES, WORK_STAGES, labelOf,
} from './model.js';

const sum = (items, pick) => round(items.reduce((acc, item) => acc + (Number(pick(item)) || 0), 0));

// ---------------------------------------------------------------- сдельщики

// Начислено = площадь × ставка. Аванс — процент от начисленного, остаток — всё прочее.
export function assignmentTotals(assignment) {
  const area = Number(assignment?.area) || 0;
  const rate = Number(assignment?.rate) || 0;
  const fx = Number(assignment?.fx) > 0 ? Number(assignment.fx) : 1;
  const percent = clampPercent(assignment?.advancePercent);
  const accrued = round(area * rate);
  const advance = round(accrued * percent / 100);
  const remainder = round(accrued - advance);
  return {
    area,
    rate,
    percent,
    currency: assignment?.currency || 'USD',
    accrued,
    advance,
    remainder,
    accruedBase: toBase(accrued, assignment?.currency, fx),
    advanceBase: toBase(advance, assignment?.currency, fx),
    remainderBase: toBase(remainder, assignment?.currency, fx),
  };
}

export function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 50;
  return Math.min(100, Math.max(0, percent));
}

// Клиент одобрил работу — либо по этапу самого сотрудника, либо по статусу проекта.
export function isClientApproved(assignment, project) {
  if (assignment?.stage === 'approved') return true;
  return CLIENT_APPROVED_STATUSES.includes(project?.status);
}

// Сводный статус сдельного сотрудника в проекте (пункт 8 ТЗ).
export function assignmentState(assignment, project) {
  const totals = assignmentTotals(assignment);
  const advancePaid = Boolean(assignment?.advancePaidAt);
  const remainderPaid = Boolean(assignment?.remainderPaidAt);
  const approved = isClientApproved(assignment, project);
  const remainderAvailable = approved && !remainderPaid && totals.remainder > 0;

  let label;
  let tone = 'neutral';
  if (remainderPaid) {
    label = 'Остаток выплачен';
    tone = 'good';
  } else if (remainderAvailable) {
    label = 'Остаток доступен к выплате';
    tone = 'good';
  } else if (assignment?.stage === 'review') {
    label = 'На согласовании';
    tone = 'warn';
  } else if (assignment?.stage === 'done') {
    label = 'Работа завершена';
    tone = 'info';
  } else if (!advancePaid && totals.advance > 0) {
    label = 'Аванс не выплачен';
    tone = 'warn';
  } else if (advancePaid) {
    label = 'Аванс выплачен';
    tone = 'info';
  } else {
    label = labelOf(WORK_STAGES, assignment?.stage, 'Назначен');
  }

  // К выплате прямо сейчас: невыплаченный аванс + доступный остаток.
  const dueNowBase = round(
    (advancePaid ? 0 : totals.advanceBase)
    + (remainderAvailable ? totals.remainderBase : 0),
  );
  const paidBase = round(
    (advancePaid ? totals.advanceBase : 0)
    + (remainderPaid ? totals.remainderBase : 0),
  );
  // Остаток, который ещё не согласован клиентом, — обязательство будущего периода.
  const lockedBase = !remainderPaid && !approved ? totals.remainderBase : 0;

  return {
    ...totals,
    advancePaid,
    remainderPaid,
    approved,
    remainderAvailable,
    label,
    tone,
    dueNowBase,
    paidBase,
    lockedBase,
    owedBase: round(totals.accruedBase - paidBase),
  };
}

export function projectAssignments(state, projectId) {
  return state.assignments.filter((item) => item.projectId === projectId);
}

export function employeeAssignments(state, employeeId) {
  return state.assignments.filter((item) => item.employeeId === employeeId);
}

// ------------------------------------------------------------------ проекты

export function projectIncomes(state, projectId) {
  return state.incomes.filter((item) => item.projectId === projectId);
}

// Прямые расходы проекта: только то, что пользователь сам привязал к проекту.
// Выплаты сдельным и зарплаты сюда не попадают — они считаются отдельно,
// чтобы не задваивать суммы.
export function projectDirectExpenses(state, projectId) {
  return state.expenses.filter((item) => item.projectId === projectId && !item.source);
}

// План поступлений проекта. Полученные деньги распределяются по платежам
// в порядке срока — статусы плана всегда синхронны фактическим приходам.
export function projectPlan(project, receivedBase) {
  const fx = Number(project?.fx) > 0 ? Number(project.fx) : 1;
  const items = [...(project?.payments || [])].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  let left = Number(receivedBase) || 0;
  return items.map((item) => {
    const base = toBase(item.amount, project.currency, fx);
    const covered = Math.min(base, Math.max(0, left));
    left = round(left - covered);
    const status = covered >= base - 0.01 && base > 0 ? 'received'
      : covered > 0 ? 'partial' : 'planned';
    const overdue = status !== 'received' && item.dueDate && item.dueDate < today();
    return {
      ...item,
      base,
      coveredBase: round(covered),
      leftBase: round(base - covered),
      status,
      overdue,
    };
  });
}

export function projectFinance(state, project) {
  if (!project) return null;
  const fx = Number(project.fx) > 0 ? Number(project.fx) : 1;
  const priceBase = toBase(project.price, project.currency, fx);
  const incomes = projectIncomes(state, project.id);
  const receivedBase = sum(incomes, (item) => item.base);

  // Обязательство клиента = стоимость договора + запланированные доп. работы.
  const extraPlanBase = sum(
    (project.payments || []).filter((item) => item.type === 'extra'),
    (item) => toBase(item.amount, project.currency, fx),
  );
  const contractBase = round(priceBase + extraPlanBase);
  const plan = projectPlan(project, receivedBase);
  const cancelled = CLOSED_PROJECT_STATUSES.includes(project.status);
  const toReceiveBase = cancelled ? 0 : Math.max(0, round(contractBase - receivedBase));

  const assignments = projectAssignments(state, project.id);
  const states = assignments.map((item) => assignmentState(item, project));
  const pieceworkAccruedBase = sum(states, (item) => item.accruedBase);
  const pieceworkPaidBase = sum(states, (item) => item.paidBase);
  const pieceworkDueBase = sum(states, (item) => item.dueNowBase);

  const direct = projectDirectExpenses(state, project.id);
  const directBase = sum(direct, (item) => item.base);

  const costPlanBase = round(pieceworkAccruedBase + directBase);
  const costActualBase = round(pieceworkPaidBase + directBase);
  const profitPlanBase = round(contractBase - costPlanBase);
  const profitActualBase = round(receivedBase - costActualBase);

  return {
    project,
    priceBase,
    contractBase,
    receivedBase,
    toReceiveBase,
    plan,
    assignments,
    assignmentStates: states,
    pieceworkAccruedBase,
    pieceworkPaidBase,
    pieceworkDueBase,
    directExpenses: direct,
    directBase,
    costPlanBase,
    costActualBase,
    profitPlanBase,
    profitActualBase,
    margin: contractBase > 0 ? round(profitPlanBase / contractBase * 100, 1) : 0,
    paid: toReceiveBase <= 0.01 && contractBase > 0,
  };
}

// ------------------------------------------------------------ взаиморасчёты

// Взаимозачёт: клиент рассчитывается не деньгами, а имуществом —
// квартирой, машиной, материалами. Мы записываем оценку этого имущества,
// а дальше стоимость выполненных работ списывается с неё.
export function barterState(state, barter) {
  if (!barter) return null;
  const incomes = state.incomes.filter((item) => item.barterId === barter.id);
  const usedBase = sum(incomes, (item) => item.base);
  const totalBase = toBase(barter.amount, barter.currency, barter.fx);
  return {
    barter,
    incomes,
    totalBase,
    usedBase,
    leftBase: round(Math.max(0, totalBase - usedBase)),
    // Списали больше, чем стоит имущество: клиент остался должен деньгами.
    overBase: round(Math.max(0, usedBase - totalBase)),
    done: usedBase >= totalBase - 0.01,
  };
}

export function clientBarters(state, clientId) {
  return state.barters
    .filter((item) => item.clientId === clientId)
    .map((item) => barterState(state, item));
}

export function openBarters(state) {
  return state.barters
    .map((item) => barterState(state, item))
    .filter((item) => !item.done)
    .sort((a, b) => b.leftBase - a.leftBase);
}

// Сколько всего имущества получено и сколько по нему ещё не отработано.
export function barterTotals(state) {
  const rows = state.barters.map((item) => barterState(state, item));
  return {
    rows,
    totalBase: sum(rows, (item) => item.totalBase),
    usedBase: sum(rows, (item) => item.usedBase),
    leftBase: sum(rows, (item) => item.leftBase),
  };
}

// -------------------------------------------------------------- партнёры

// Партнёры берут деньги из кассы как свою долю прибыли. Это не расход
// студии: прибыль от таких изъятий не уменьшается, поэтому они живут
// отдельно от расходов и считаются здесь.
export function founderDraws(state, founderId, from, to) {
  return state.draws
    .filter((item) => item.founderId === founderId)
    .filter((item) => (from && to ? inRange(item.date, from, to) : true))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function founderState(state, founder, from, to) {
  if (!founder) return null;
  const all = founderDraws(state, founder.id);
  const period = from && to ? all.filter((item) => inRange(item.date, from, to)) : all;
  const of = (list, kind) => list.filter((item) => (item.kind || 'draw') === kind);

  // Три разных движения, и путать их нельзя:
  //   взял для себя — доля прибыли, студия ничего не должна;
  //   оплатил из своих — расход студии, и студия остаётся должна партнёру;
  //   вернули долг — гасит эту задолженность.
  const takenBase = sum(of(all, 'draw'), (item) => item.base);
  const spentBase = sum(of(all, 'spend'), (item) => item.base);
  const repaidBase = sum(of(all, 'repay'), (item) => item.base);

  return {
    founder,
    draws: all,
    periodDraws: period,
    takenBase,
    spentBase,
    repaidBase,
    owedBase: round(Math.max(0, spentBase - repaidBase)),
    periodTakenBase: sum(of(period, 'draw'), (item) => item.base),
    periodSpentBase: sum(of(period, 'spend'), (item) => item.base),
    periodRepaidBase: sum(of(period, 'repay'), (item) => item.base),
    // «Взял» в сводках — это именно доля прибыли.
    totalBase: takenBase,
    periodBase: sum(of(period, 'draw'), (item) => item.base),
    lastDate: all[0]?.date || '',
  };
}

export function foundersSummary(state, from, to) {
  const rows = state.founders.map((founder) => founderState(state, founder, from, to));
  return {
    rows,
    totalBase: sum(rows, (item) => item.totalBase),
    periodBase: sum(rows, (item) => item.periodBase),
    owedBase: sum(rows, (item) => item.owedBase),
    periodSpentBase: sum(rows, (item) => item.periodSpentBase),
  };
}

// ------------------------------------------------------------------ клиенты

export function clientFinance(state, clientId) {
  const projects = state.projects.filter((item) => item.clientId === clientId);
  let contractBase = 0;
  let receivedBase = 0;
  let toReceiveBase = 0;
  for (const project of projects) {
    const finance = projectFinance(state, project);
    contractBase += finance.contractBase;
    receivedBase += finance.receivedBase;
    toReceiveBase += finance.toReceiveBase;
  }
  // Прочие приходы клиента, не привязанные к проекту.
  receivedBase += sum(
    state.incomes.filter((item) => item.clientId === clientId && !item.projectId),
    (item) => item.base,
  );
  return {
    projects,
    contractBase: round(contractBase),
    receivedBase: round(receivedBase),
    toReceiveBase: round(toReceiveBase),
  };
}

// ---------------------------------------------------------------- зарплаты

export function payrollPaidBase(payroll) {
  return sum(payroll?.payments || [], (item) => item.base);
}

export function payrollState(payroll) {
  const accruedBase = Number(payroll?.accruedBase) || 0;
  const paidBase = payrollPaidBase(payroll);
  const leftBase = round(Math.max(0, accruedBase - paidBase));
  let label = 'Начислено';
  let tone = 'warn';
  if (paidBase <= 0) {
    label = 'Начислено';
    tone = 'warn';
  } else if (leftBase <= 0.01) {
    label = 'Выплачено';
    tone = 'good';
  } else {
    label = 'Частично выплачено';
    tone = 'info';
  }
  return { accruedBase, paidBase, leftBase, label, tone };
}

export function employeePayrolls(state, employeeId) {
  return state.payrolls
    .filter((item) => item.employeeId === employeeId)
    .sort((a, b) => b.month.localeCompare(a.month));
}

// Какие месяцы должны быть начислены сотруднику на текущую дату.
export function payrollMonthsFor(employee, nowIso = today()) {
  if (employee.payType !== 'fixed' || employee.active === false) return [];
  const from = monthKey(employee.startDate || employee.createdAt || nowIso);
  const to = monthKey(nowIso);
  if (from > to) return [];
  return monthKeysBetween(from, to);
}

// --------------------------------------------------------------- сотрудники

export function employeeFinance(state, employee) {
  if (!employee) return null;
  if (employee.payType === 'fixed') {
    const payrolls = employeePayrolls(state, employee.id);
    const accruedBase = sum(payrolls, (item) => item.accruedBase);
    const paidBase = sum(payrolls, (item) => payrollPaidBase(item));
    return {
      type: 'fixed',
      payrolls,
      accruedBase,
      paidBase,
      dueNowBase: round(Math.max(0, accruedBase - paidBase)),
      lockedBase: 0,
      owedBase: round(Math.max(0, accruedBase - paidBase)),
    };
  }
  const assignments = employeeAssignments(state, employee.id);
  const rows = assignments.map((assignment) => ({
    assignment,
    project: state.projects.find((item) => item.id === assignment.projectId) || null,
    state: assignmentState(assignment, state.projects.find((item) => item.id === assignment.projectId)),
  }));
  return {
    type: 'piecework',
    rows,
    accruedBase: sum(rows, (row) => row.state.accruedBase),
    paidBase: sum(rows, (row) => row.state.paidBase),
    dueNowBase: sum(rows, (row) => row.state.dueNowBase),
    lockedBase: sum(rows, (row) => row.state.lockedBase),
    owedBase: sum(rows, (row) => row.state.owedBase),
  };
}

// ------------------------------------------------------- периоды и отчёты

export function incomesInRange(state, from, to) {
  return state.incomes.filter((item) => inRange(item.date, from, to));
}

export function expensesInRange(state, from, to) {
  return state.expenses.filter((item) => inRange(item.date, from, to));
}

export function periodTotals(state, from, to) {
  const incomes = incomesInRange(state, from, to);
  const expenses = expensesInRange(state, from, to);
  const incomeBase = sum(incomes, (item) => item.base);
  const expenseBase = sum(expenses, (item) => item.base);
  // Часть дохода приходит не деньгами, а взаимозачётом — это видно отдельно,
  // иначе непонятно, сколько на самом деле пришло в кассу.
  const barterIncomes = incomes.filter((item) => item.method === 'barter' || item.barterId);
  const incomeBarterBase = sum(barterIncomes, (item) => item.base);

  const expenseByCategory = new Map();
  for (const expense of expenses) {
    const key = expense.category || 'other/misc';
    expenseByCategory.set(key, round((expenseByCategory.get(key) || 0) + (Number(expense.base) || 0)));
  }
  const expenseByGroup = new Map();
  for (const [category, value] of expenseByCategory) {
    const group = String(category).split('/')[0];
    expenseByGroup.set(group, round((expenseByGroup.get(group) || 0) + value));
  }
  const incomeByType = new Map();
  for (const income of incomes) {
    const key = income.type || 'other';
    incomeByType.set(key, round((incomeByType.get(key) || 0) + (Number(income.base) || 0)));
  }

  return {
    from,
    to,
    incomes,
    expenses,
    incomeBase,
    incomeBarterBase,
    incomeCashBase: round(incomeBase - incomeBarterBase),
    expenseBase,
    profitBase: round(incomeBase - expenseBase),
    expenseByCategory,
    expenseByGroup,
    incomeByType,
  };
}

export function monthlySeries(state, monthKeys) {
  return monthKeys.map((key) => {
    const totals = periodTotals(state, monthStart(`${key}-01`), monthEnd(`${key}-01`));
    return {
      key,
      incomeBase: totals.incomeBase,
      expenseBase: totals.expenseBase,
      profitBase: totals.profitBase,
    };
  });
}

// ------------------------------------------------- планируемые поступления

// Пункт 21 ТЗ, раздел «Получить».
export function receivables(state) {
  const rows = [];
  for (const project of state.projects) {
    if (CLOSED_PROJECT_STATUSES.includes(project.status)) continue;
    const finance = projectFinance(state, project);
    if (finance.toReceiveBase <= 0.01) continue;
    const client = state.clients.find((item) => item.id === project.clientId) || null;
    for (const item of finance.plan) {
      if (item.leftBase <= 0.01) continue;
      rows.push({
        id: `${project.id}:${item.id}`,
        projectId: project.id,
        project,
        client,
        title: item.title || labelOfPlanType(item.type),
        type: item.type,
        amountBase: item.leftBase,
        dueDate: item.dueDate,
        overdue: Boolean(item.overdue),
        status: item.status,
      });
    }
    // Часть долга, не покрытая планом платежей, показывается отдельной строкой.
    const planned = finance.plan.reduce((acc, item) => acc + item.leftBase, 0);
    const uncovered = round(finance.toReceiveBase - planned);
    if (uncovered > 0.01) {
      rows.push({
        id: `${project.id}:rest`,
        projectId: project.id,
        project,
        client,
        title: 'Остаток по договору',
        type: 'final',
        amountBase: uncovered,
        dueDate: project.dueDate || '',
        overdue: Boolean(project.dueDate && project.dueDate < today()),
        status: 'planned',
      });
    }
  }
  return rows.sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
}

function labelOfPlanType(type) {
  if (type === 'advance') return 'Аванс';
  if (type === 'final') return 'Остаток';
  if (type === 'extra') return 'Дополнительная работа';
  return 'Платёж';
}

// Пункт 21 ТЗ, раздел «Выплатить».
export function payables(state) {
  const rows = [];

  for (const assignment of state.assignments) {
    const project = state.projects.find((item) => item.id === assignment.projectId);
    if (project && CLOSED_PROJECT_STATUSES.includes(project.status)) continue;
    const employee = state.employees.find((item) => item.id === assignment.employeeId);
    const info = assignmentState(assignment, project);
    if (!info.advancePaid && info.advanceBase > 0) {
      rows.push({
        id: `${assignment.id}:advance`,
        kind: 'assignment-advance',
        title: `Аванс — ${employee?.name || 'сотрудник'}`,
        subtitle: project?.name || '',
        amountBase: info.advanceBase,
        dueDate: project?.startDate || '',
        ready: true,
        assignmentId: assignment.id,
        employeeId: assignment.employeeId,
      });
    }
    if (!info.remainderPaid && info.remainder > 0) {
      rows.push({
        id: `${assignment.id}:final`,
        kind: 'assignment-final',
        title: `Остаток — ${employee?.name || 'сотрудник'}`,
        subtitle: info.remainderAvailable
          ? `${project?.name || ''} · клиент одобрил`
          : `${project?.name || ''} · ждёт одобрения клиента`,
        amountBase: info.remainderBase,
        dueDate: project?.dueDate || '',
        ready: info.remainderAvailable,
        assignmentId: assignment.id,
        employeeId: assignment.employeeId,
      });
    }
  }

  for (const payroll of state.payrolls) {
    const info = payrollState(payroll);
    if (info.leftBase <= 0.01) continue;
    const employee = state.employees.find((item) => item.id === payroll.employeeId);
    rows.push({
      id: `${payroll.id}:salary`,
      kind: 'payroll',
      title: `Зарплата — ${employee?.name || 'сотрудник'}`,
      subtitle: monthLabel(payroll.month),
      amountBase: info.leftBase,
      dueDate: payroll.dueDate || '',
      ready: true,
      payrollId: payroll.id,
      employeeId: payroll.employeeId,
    });
  }

  for (const item of state.planned) {
    if (item.status === 'paid') continue;
    rows.push({
      id: item.id,
      kind: 'planned',
      title: item.title,
      subtitle: item.category,
      amountBase: toBase(item.amount, item.currency, item.fx),
      dueDate: item.dueDate || '',
      ready: true,
      plannedId: item.id,
    });
  }

  return rows.sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
}

// Итоговые показатели главного экрана.
export function dashboardTotals(state, from, to) {
  const totals = periodTotals(state, from, to);
  const toReceive = sum(receivables(state), (item) => item.amountBase);
  const toPay = sum(payables(state).filter((item) => item.ready), (item) => item.amountBase);
  const locked = sum(payables(state).filter((item) => !item.ready), (item) => item.amountBase);
  return { ...totals, toReceiveBase: toReceive, toPayBase: toPay, lockedPayBase: locked };
}

// ------------------------------------------------------------ уведомления

export function notifications(state, nowIso = today()) {
  const horizon = Number(state.settings.notifyDaysAhead) || 7;
  const limit = addDaysIso(nowIso, horizon);
  const items = [];

  for (const row of receivables(state)) {
    if (row.overdue) {
      items.push({
        id: `late:${row.id}`, tone: 'danger', icon: '!',
        title: 'Просрочен платёж клиента',
        text: `${row.client?.name || 'Без клиента'} · ${row.project.name} · ${row.title}`,
        amountBase: row.amountBase, href: `#/projects/${row.projectId}`,
      });
    } else if (row.dueDate && row.dueDate <= limit) {
      items.push({
        id: `soon:${row.id}`, tone: 'warn', icon: '→',
        title: 'Клиент должен оплатить',
        text: `${row.project.name} · ${row.title} · до ${formatDate(row.dueDate, { short: true })}`,
        amountBase: row.amountBase, href: `#/projects/${row.projectId}`,
      });
    }
  }

  for (const row of payables(state)) {
    if (row.kind === 'assignment-final' && row.ready) {
      items.push({
        id: `ready:${row.id}`, tone: 'good', icon: '✓',
        title: 'Остаток доступен к выплате',
        text: row.title.replace('Остаток — ', '') + ' · ' + (row.subtitle || ''),
        amountBase: row.amountBase, href: `#/payments/pay`,
      });
      continue;
    }
    if (!row.dueDate) continue;
    if (row.dueDate < nowIso) {
      items.push({
        id: `overdue:${row.id}`, tone: 'danger', icon: '!',
        title: 'Просрочена выплата',
        text: `${row.title} · срок ${formatDate(row.dueDate, { short: true })}`,
        amountBase: row.amountBase, href: '#/payments/pay',
      });
    } else if (row.dueDate <= limit) {
      items.push({
        id: `duesoon:${row.id}`, tone: 'warn', icon: '→',
        title: row.kind === 'payroll' ? 'Приближается зарплата' : 'Приближается платёж',
        text: `${row.title} · до ${formatDate(row.dueDate, { short: true })}`,
        amountBase: row.amountBase, href: '#/payments/pay',
      });
    }
  }

  for (const project of state.projects) {
    if (project.status === 'review') {
      items.push({
        id: `review:${project.id}`, tone: 'warn', icon: '•',
        title: 'Проект ожидает согласования',
        text: project.name, href: `#/projects/${project.id}`,
      });
    }
  }

  return items;
}

function addDaysIso(iso, days) {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

// Годовая сводка (пункт 20 ТЗ).
export function yearSummary(state, year) {
  const keys = monthKeysBetween(`${year}-01`, `${year}-12`);
  const series = monthlySeries(state, keys);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const totals = periodTotals(state, from, to);

  const projects = state.projects.filter((project) => {
    const start = project.startDate || project.createdAt || '';
    return start >= from && start <= to;
  });

  const ranked = state.projects
    .map((project) => projectFinance(state, project))
    .filter((finance) => finance.contractBase > 0)
    .sort((a, b) => b.profitPlanBase - a.profitPlanBase);

  const staffBase = round(
    (totals.expenseByGroup.get('staff') || 0),
  );
  const fixedCostsBase = round(
    (totals.expenseByGroup.get('office') || 0) + (totals.expenseByGroup.get('gov') || 0),
  );

  return {
    year, keys, series, totals, projects,
    projectCount: projects.length,
    avgIncomePerProject: projects.length
      ? round(totals.incomeBase / projects.length)
      : 0,
    staffBase,
    fixedCostsBase,
    topProjects: ranked.slice(0, 5),
  };
}

export { sum };
