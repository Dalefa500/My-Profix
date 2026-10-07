// Финансовый движок: все производные величины считаются здесь,
// в данных хранятся только факты (операции, назначения, начисления).
//
// Главные правила:
//   • Начислено ≠ Выплачено, Должны получить ≠ Получено.
//   • Остаток сдельного сотрудника доступен только после одобрения клиентом.
//   • Общие расходы компании не распределяются по проектам автоматически.

import { toBase, round, isBase } from './money.js';
import {
  today, monthKey, monthStart, monthEnd, addMonths, addDays, monthKeysBetween, inRange, formatDate, monthLabel,
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
// Была ли по работе хоть одна выплата (новая или старого формата).
export function assignmentHasPayments(assignment) {
  return Boolean(assignment?.advancePaidAt || assignment?.remainderPaidAt
    || (Array.isArray(assignment?.payments) && assignment.payments.length));
}

export function assignmentState(assignment, project) {
  const base = assignmentTotals(assignment);
  const approved = isClientApproved(assignment, project);
  const fx = Number(assignment?.fx) > 0 ? Number(assignment.fx) : 1;
  const known = (value) => value !== undefined && value !== null && Number.isFinite(Number(value));

  // Сколько реально выплачено. Новые выплаты лежат списком payments
  // (их может быть несколько: остаток можно отдать частями или доплатить,
  // если площадь потом увеличили). У старых записей — одиночные поля
  // advancePaidAt/remainderPaidAt с суммой или без неё.
  const payments = Array.isArray(assignment?.payments) ? assignment.payments : [];
  // Сумма выплаты в валюте ставки: если платили в ней же — как ввели,
  // иначе пересчитываем по курсу назначения. Так работа в сомони,
  // оплаченная сомони по другому курсу, закрывается без «хвоста».
  const inCurrency = (item) => (item.currency === assignment.currency && Number.isFinite(Number(item.amount))
    ? Number(item.amount)
    : (Number(item.base) || 0) / fx);
  const partSum = (part, pick) => sum(payments.filter((item) => item.part === part), pick);
  const hasPart = (part) => payments.some((item) => item.part === part);
  const legacyAdvance = assignment?.advancePaidAt && !hasPart('advance');
  const legacyFinal = assignment?.remainderPaidAt && !hasPart('final');
  const advanceStarted = Boolean(assignment?.advancePaidAt) || hasPart('advance');
  const legacyAdvanceBase = legacyAdvance
    ? (known(assignment.advancePaidBase) ? Number(assignment.advancePaidBase) : base.advanceBase) : 0;
  const legacyFinalBase = legacyFinal
    ? (known(assignment.remainderPaidBase) ? Number(assignment.remainderPaidBase) : base.remainderBase) : 0;
  // Сколько ушло деньгами (в долларах) — для расходов и «Выплачено».
  const advancePaidBase = round(partSum('advance', (item) => item.base) + legacyAdvanceBase);
  const finalPaidBase = round(partSum('final', (item) => item.base) + legacyFinalBase);
  // То же в валюте ставки — для остатка.
  const advancePaidCur = partSum('advance', inCurrency) + (legacyAdvance
    ? (known(assignment.advancePaidBase) ? legacyAdvanceBase / fx : base.advance) : 0);
  const finalPaidCur = partSum('final', inCurrency) + (legacyFinal
    ? (known(assignment.remainderPaidBase) ? legacyFinalBase / fx : base.remainder) : 0);
  // У старых записей, оплаченных полностью, «выплачено» = начислено
  // (без копеечной разницы от округления двух половин).
  const legacyFull = legacyFinal && !payments.length
    && !known(assignment.remainderPaidBase) && !known(assignment.advancePaidBase);
  const paidBase = legacyFull ? base.accruedBase : round(advancePaidBase + finalPaidBase);

  // Аванс считается выплаченным, когда отдали всю его сумму (старые записи
  // с отметкой — выплаченными целиком). Отдали часть — недоплата аванса
  // остаётся к выплате сразу, а не переезжает в остаток «после одобрения».
  const advancePaid = Boolean(legacyAdvance) || legacyFull
    || (advanceStarted && advancePaidCur >= base.advance - 0.005);
  let advanceLeftCur = advancePaid ? 0 : Math.max(0, base.advance - advancePaidCur);
  if (advanceLeftCur <= 0.005) advanceLeftCur = 0;
  // Остаток — всё начисленное минус уже отданное и минус невыплаченный
  // аванс: увеличили площадь — разница попадёт в остаток, выплатили
  // меньше — тоже.
  let remainderCur = legacyFull ? 0
    : Math.max(0, base.accrued - advancePaidCur - finalPaidCur - advanceLeftCur);
  if (remainderCur <= 0.005) remainderCur = 0;
  const untouched = !advanceStarted && finalPaidCur === 0 && !legacyFull;
  const totals = {
    ...base,
    // Пока ничего не платили — точные суммы из ставки, без пересчёта.
    remainderBase: untouched ? base.remainderBase : round(remainderCur * fx),
    remainder: untouched ? base.remainder : round(remainderCur),
    advanceLeft: untouched ? base.advance : round(advanceLeftCur),
    advanceLeftBase: untouched ? base.advanceBase : round(advanceLeftCur * fx),
    advancePaidCur: round(advancePaidCur),
    advancePaidBase,
    finalPaidBase,
    finalPaidCur: round(finalPaidCur),
  };
  const remainderBase = totals.remainderBase;
  const remainderPaid = (finalPaidCur > 0 || legacyFull) && remainderBase <= 0.01;
  const remainderPartly = finalPaidCur > 0 && !remainderPaid;
  const remainderAvailable = approved && !remainderPaid && totals.remainder > 0;

  let label;
  let tone = 'neutral';
  if (remainderPaid) {
    label = 'Остаток выплачен';
    tone = 'good';
  } else if (remainderPartly && remainderAvailable) {
    label = 'Остаток выплачен частично';
    tone = 'warn';
  } else if (remainderAvailable) {
    label = 'Остаток доступен к выплате';
    tone = 'good';
  } else if (assignment?.stage === 'review') {
    label = 'На согласовании';
    tone = 'warn';
  } else if (assignment?.stage === 'done') {
    label = 'Работа завершена';
    tone = 'info';
  } else if (!advancePaid && advanceStarted && totals.advanceLeft > 0) {
    label = 'Аванс выплачен частично';
    tone = 'warn';
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
  const dueNowBase = round(totals.advanceLeftBase + (remainderAvailable ? totals.remainderBase : 0));
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
    // Долг перед сотрудником: невыплаченный аванс и остаток.
    owedBase: round(totals.advanceLeftBase + totals.remainderBase),
  };
}

// Срок аванса — начало проекта, но не раньше, чем сотрудника назначили:
// иначе новое назначение сразу «просрочено».
export function advanceDueDate(assignment, project) {
  const assigned = String(assignment?.createdAt || '').slice(0, 10);
  const start = project?.startDate || '';
  // Доплата аванса (площадь увеличили после выплаты) — не раньше
  // последней выплаты аванса, иначе она сразу «просрочена» на месяц.
  const lastAdvance = (assignment?.payments || [])
    .filter((item) => item.part === 'advance')
    .reduce((latest, item) => (String(item.date || '') > latest ? String(item.date) : latest), '');
  return [assigned, start, lastAdvance].reduce((a, b) => (b > a ? b : a), '');
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
  // Исключаются только выплаты по сдельным назначениям — они уже учтены
  // через сами назначения. Расход, оплаченный коллегой из своих, и плановый
  // платёж, привязанные к проекту, — это настоящие расходы проекта.
  return state.expenses.filter((item) => item.projectId === projectId && item.source !== 'assignment');
}

// План поступлений проекта. Полученные деньги распределяются по платежам
// в порядке срока — статусы плана всегда синхронны фактическим приходам.
export function projectPlan(project, receivedBase) {
  const fx = Number(project?.fx) > 0 ? Number(project.fx) : 1;
  const base = isBase(project?.currency);
  const tol = planTolerance(project);
  const items = [...(project?.payments || [])].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  // Доллары каждой строки округляются отдельно, и сумма строк могла уйти
  // от стоимости на цент. Если сами суммы плана равны цене — подгоняем
  // последнюю строку, чтобы и в долларах всё сходилось.
  const bases = new Map(items.map((item) => [item, toBase(item.amount, project?.currency, fx)]));
  const regular = items.filter((item) => item.type !== 'extra');
  const amountSum = regular.reduce((acc, item) => acc + (Number(item.amount) || 0), 0);
  if (regular.length && Math.abs(amountSum - (Number(project?.price) || 0)) < 0.005) {
    const target = toBase(project.price, project.currency, fx);
    const drift = round(target - regular.reduce((acc, item) => acc + bases.get(item), 0));
    const last = regular[regular.length - 1];
    if (drift !== 0 && Math.abs(drift) <= 0.05) bases.set(last, round(bases.get(last) + drift));
  }
  let left = Number(receivedBase) || 0;
  return items.map((item) => {
    const itemBase = bases.get(item);
    const covered = Math.min(itemBase, Math.max(0, left));
    left = round(left - covered);
    // Недостача меньше одной сомони — это округление при пересчёте
    // из долларов, а не долг: платёж считается полученным.
    const status = covered >= itemBase - tol && itemBase > 0 ? 'received'
      : covered > tol ? 'partial' : 'planned';
    const overdue = status !== 'received' && item.dueDate && item.dueDate < today();
    const leftBase = status === 'received' ? 0 : round(itemBase - covered);
    // Остаток в валюте договора: пока платёж не тронут, это его собственная
    // сумма (целые сомони так и остаются целыми), иначе — сумма минус
    // полученное, пересчитанное по курсу договора.
    const leftAmount = status === 'received' ? 0
      : covered <= 0.004 ? Number(item.amount) || 0
        : round(Math.max(0, (Number(item.amount) || 0) - (base ? covered : covered / fx)));
    return {
      ...item,
      base: itemBase,
      coveredBase: round(covered),
      leftBase,
      leftAmount,
      status,
      overdue,
    };
  });
}

// Допуск на округление: у договора в сомони — одна сомони, в долларах — цент.
export function planTolerance(project) {
  if (isBase(project?.currency)) return 0.01;
  const fx = Number(project?.fx) > 0 ? Number(project.fx) : 1;
  return Math.max(0.01, round(fx, 2));
}

// Сколько получено по договору в его валюте, выраженное в долларах по курсу
// договора. Для договора в долларах — просто сумма приходов.
export function projectSettledBase(project, incomes) {
  if (isBase(project?.currency)) return sum(incomes, (item) => item.base);
  const fx = Number(project.fx) > 0 ? Number(project.fx) : 1;
  const inCurrency = incomes.reduce((acc, item) => acc + (item.currency === project.currency
    ? Number(item.amount) || 0
    : (Number(item.base) || 0) / fx), 0);
  return round(inCurrency * fx);
}

export function projectFinance(state, project) {
  if (!project) return null;
  const fx = Number(project.fx) > 0 ? Number(project.fx) : 1;
  const priceBase = toBase(project.price, project.currency, fx);
  const incomes = projectIncomes(state, project.id);
  const receivedBase = sum(incomes, (item) => item.base);
  // Долг по договору считаем в валюте договора: 10 000 сомони, оплаченные
  // сомони по другому курсу, — это полный расчёт, а не долг в пару долларов.
  const settledBase = projectSettledBase(project, incomes);

  // Обязательство клиента = стоимость договора + запланированные доп. работы.
  const extraPlanBase = sum(
    (project.payments || []).filter((item) => item.type === 'extra'),
    (item) => toBase(item.amount, project.currency, fx),
  );
  const cancelledEarly = CLOSED_PROJECT_STATUSES.includes(project.status);
  // У отменённого проекта «договор» — то, что клиент успел заплатить.
  const contractBase = cancelledEarly ? round(receivedBase) : round(priceBase + extraPlanBase);
  const cancelled = CLOSED_PROJECT_STATUSES.includes(project.status);
  // У отменённого проекта неполученные платежи уже не ждём.
  const plan = projectPlan(project, settledBase).map((item) => {
    if (!cancelled || item.status === 'received') return item;
    // Частично полученный платёж так и показываем; неполученный — «не ожидается».
    return { ...item, status: item.status === 'partial' ? 'partial' : 'cancelled', leftBase: 0, leftAmount: 0, overdue: false };
  });
  const owed = round(contractBase - settledBase);
  const toReceiveBase = cancelled || owed <= planTolerance(project) ? 0 : owed;

  const assignments = projectAssignments(state, project.id);
  const states = assignments.map((item) => assignmentState(item, project));
  const pieceworkAccruedBase = sum(states, (item) => item.accruedBase);
  const pieceworkPaidBase = sum(states, (item) => item.paidBase);
  const pieceworkDueBase = sum(states, (item) => item.dueNowBase);

  const direct = projectDirectExpenses(state, project.id);
  const directBase = sum(direct, (item) => item.base);

  const costPlanBase = round(pieceworkAccruedBase + directBase);
  const costActualBase = round(pieceworkPaidBase + directBase);
  // Прибыль отменённого проекта — по факту: договор уже не будет оплачен.
  const profitPlanBase = cancelled ? round(receivedBase - costActualBase) : round(contractBase - costPlanBase);
  const profitActualBase = round(receivedBase - costActualBase);

  return {
    project,
    priceBase,
    contractBase,
    receivedBase,
    settledBase,
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
  const incomes = state.incomes
    .filter((item) => item.barterId === barter.id)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const fx = isBase(barter.currency) ? 1 : (Number(barter.fx) > 0 ? Number(barter.fx) : 1);
  const totalBase = toBase(barter.amount, barter.currency, barter.fx);
  // Списания считаем в валюте оценки: квартира за 300 000 сомони, на которую
  // списали работ на 300 000 сомони (по любому курсу), отработана целиком.
  const inCurrency = (income) => {
    if (isBase(barter.currency)) return Number(income.base) || 0;
    if (income.currency === barter.currency) return Number(income.amount) || 0;
    return (Number(income.base) || 0) / fx;
  };
  const totalAmount = Number(barter.amount) || 0;
  const usedAmount = round(sum(incomes, inCurrency));
  let leftAmount = Math.max(0, totalAmount - usedAmount);
  if (leftAmount <= 0.005) leftAmount = 0;
  // Этапы по порядку: сколько списали и сколько после этого осталось.
  let running = totalAmount;
  const stages = incomes.map((income) => {
    running = round(running - inCurrency(income));
    return { income, leftAfterBase: round(running * fx), leftAfterAmount: running };
  });
  return {
    barter,
    incomes,
    stages,
    percent: totalAmount > 0 ? Math.min(100, Math.round((usedAmount / totalAmount) * 100)) : 0,
    totalBase,
    // Отработано — по курсу оценки, чтобы «оценка − отработано = осталось»
    // сходилось и в долларах. Сколько этапы дали дохода по своим курсам —
    // incomeBase.
    usedBase: round(usedAmount * fx),
    incomeBase: sum(incomes, (item) => item.base),
    totalAmount,
    usedAmount,
    leftAmount: round(leftAmount),
    leftBase: round(leftAmount * fx),
    // Списать больше оценки форма не даёт; в старых записях такое могло
    // остаться — это видно в карточке имущества.
    overBase: round(Math.max(0, usedAmount - totalAmount) * fx),
    done: leftAmount === 0,
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

// -------------------------------------------------------------- коллеги

// Коллеги берут деньги из кассы как свою долю прибыли. Это не расход
// студии: прибыль от таких изъятий не уменьшается, поэтому они живут
// отдельно от расходов и считаются здесь.
export function founderDraws(state, founderId, from, to) {
  return state.draws
    .filter((item) => item.founderId === founderId)
    .filter((item) => (from && to ? inRange(item.date, from, to) : true))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Долг студии перед коллегой по валютам: 2000 сомони, которые он заплатил
// за студию, гасятся возвратом 2000 сомони по любому курсу. Возврат в другой
// валюте засчитывается по курсу самих расходов. overBase — вернули больше,
// чем были должны.
export function founderDebt(draws) {
  const balances = new Map(); // валюта -> { amount, base }
  for (const item of draws) {
    if ((item.kind || 'draw') !== 'spend') continue;
    const key = item.currency || 'USD';
    const entry = balances.get(key) || { amount: 0, base: 0 };
    entry.amount += Number(item.amount) || 0;
    entry.base += Number(item.base) || 0;
    balances.set(key, entry);
  }
  let extraBase = 0;
  for (const item of draws) {
    if ((item.kind || 'draw') !== 'repay') continue;
    const amount = Number(item.amount) || 0;
    const base = Number(item.base) || 0;
    const entry = balances.get(item.currency || 'USD');
    if (entry && entry.amount > 0.005 && amount > 0) {
      const take = Math.min(amount, entry.amount);
      entry.base -= entry.base * (take / entry.amount);
      entry.amount -= take;
      if (amount - take > 0.005) extraBase += base * ((amount - take) / amount);
    } else {
      extraBase += base;
    }
  }
  // Возврат сверх долга в своей валюте гасит долг в других валютах.
  for (const entry of balances.values()) {
    if (extraBase <= 0.004 || entry.base <= 0) continue;
    const cut = Math.min(entry.base, extraBase);
    entry.amount -= entry.amount * (cut / entry.base);
    entry.base -= cut;
    extraBase -= cut;
  }
  let owedBase = 0;
  for (const entry of balances.values()) {
    if (entry.amount > 0.005) owedBase += entry.base;
  }
  return { owedBase: round(owedBase), overBase: round(Math.max(0, extraBase)) };
}

export function founderState(state, founder, from, to) {
  if (!founder) return null;
  const all = founderDraws(state, founder.id);
  const period = from && to ? all.filter((item) => inRange(item.date, from, to)) : all;
  const of = (list, kind) => list.filter((item) => (item.kind || 'draw') === kind);

  // Три разных движения, и путать их нельзя:
  //   взял для себя — доля прибыли, студия ничего не должна;
  //   оплатил из своих — расход студии, и студия остаётся должна коллеге;
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
    owedBase: founderDebt(all).owedBase,
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
  // Остаток — в валюте начисления: 5000 сомони, выплаченные сомони по
  // другому курсу, — это полная выплата.
  let leftBase;
  if (isBase(payroll?.currency) || !(Number(payroll?.amount) > 0)) {
    leftBase = round(Math.max(0, accruedBase - paidBase));
  } else {
    const fx = Number(payroll.fx) > 0 ? Number(payroll.fx) : 1;
    const paidInCurrency = (payroll.payments || []).reduce((acc, item) => acc + (item.currency === payroll.currency
      ? Number(item.amount) || 0
      : (Number(item.base) || 0) / fx), 0);
    const left = Number(payroll.amount) - paidInCurrency;
    leftBase = left <= 0.005 ? 0 : round(left * fx);
  }
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
  const start = monthKey(employee.startDate || employee.createdAt || nowIso);
  // activeFrom: с какого месяца сотрудник снова (или впервые) в штате.
  const back = employee.activeFrom ? monthKey(employee.activeFrom) : start;
  const from = back > start ? back : start;
  const to = monthKey(nowIso);
  if (from > to) return [];
  return monthKeysBetween(from, to);
}

// --------------------------------------------------------------- сотрудники

export function employeeFinance(state, employee) {
  if (!employee) return null;
  // Считаем и зарплату, и сдельные работы: сотрудника могли перевести с одной
  // оплаты на другую, а начатые работы и начисления никуда не деваются.
  const payrolls = employeePayrolls(state, employee.id);
  const rows = employeeAssignments(state, employee.id).map((assignment) => {
    const project = state.projects.find((item) => item.id === assignment.projectId) || null;
    return { assignment, project, state: assignmentState(assignment, project) };
  });
  const openRows = rows.filter((row) => !(row.project && CLOSED_PROJECT_STATUSES.includes(row.project.status)));
  const payrollAccrued = sum(payrolls, (item) => item.accruedBase);
  const payrollOwed = sum(payrolls, (item) => payrollState(item).leftBase);
  // «К выплате сейчас» — только зарплата, срок которой уже наступил.
  const nowIso = today();
  const payrollDue = sum(
    payrolls.filter((item) => !item.dueDate || item.dueDate <= nowIso),
    (item) => payrollState(item).leftBase,
  );
  // Выплачено — всё, что реально ушло сотруднику, по его расходам.
  // Так сумма совпадает с «Историей выплат», даже если работу, за которую
  // платили, потом удалили из проекта.
  const paidOut = sum(state.expenses.filter((item) => item.employeeId === employee.id), (item) => item.base);
  return {
    type: employee.payType === 'fixed' ? 'fixed' : 'piecework',
    payrolls,
    rows,
    accruedBase: round(payrollAccrued + sum(rows, (row) => row.state.accruedBase)),
    paidBase: paidOut,
    // Как в «Платежах»: работы по отменённым проектам не считаются,
    // аванс — когда наступил его срок.
    dueNowBase: round(payrollDue + sum(openRows, (row) => (advanceDueDate(row.assignment, row.project) <= nowIso
      ? row.state.advanceLeftBase : 0) + (row.state.remainderAvailable ? row.state.remainderBase : 0))),
    lockedBase: sum(openRows, (row) => row.state.lockedBase),
    owedBase: round(payrollOwed + sum(openRows, (row) => row.state.owedBase)),
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
  // Деньги, которые коллеги взяли себе. Прибыль от них не меняется —
  // это её раздел, а не расход, — но из общей суммы они уходят:
  // «осталось в студии» = прибыль минус то, что забрали.
  const draws = (state.draws || [])
    .filter((item) => (item.kind || 'draw') === 'draw')
    .filter((item) => inRange(item.date, from, to));
  const drawBase = sum(draws, (item) => item.base);

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
    draws,
    drawBase,
    leftBase: round(incomeBase - expenseBase - drawBase),
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
      drawBase: totals.drawBase,
      leftBase: totals.leftBase,
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
    // Сумма строк плана не может быть больше долга по договору: если цену
    // проекта уменьшили, а план остался прежним, лишнее не показываем.
    let budget = finance.toReceiveBase;
    for (const item of finance.plan) {
      if (item.leftBase <= 0.01 || budget <= 0.01) continue;
      const amount = round(Math.min(item.leftBase, budget));
      budget = round(budget - amount);
      const fx = Number(project.fx) > 0 ? Number(project.fx) : 1;
      rows.push({
        amount: amount === item.leftBase ? item.leftAmount
          : (isBase(project.currency) ? amount : round(amount / fx)),
        id: `${project.id}:${item.id}`,
        projectId: project.id,
        project,
        client,
        title: item.title || labelOfPlanType(item.type),
        type: item.type,
        amountBase: amount,
        dueDate: item.dueDate,
        overdue: Boolean(item.overdue),
        status: item.status,
      });
    }
    // Часть долга, не покрытая планом платежей, показывается отдельной строкой.
    const uncovered = round(budget);
    // Копейки округления не выносим отдельной строкой, а добавляем к
    // последней — так сумма строк совпадает с долгом в карточке проекта.
    const projectRows = rows.filter((row) => row.projectId === project.id);
    if (uncovered > 0 && uncovered <= planTolerance(project) && projectRows.length) {
      const last = projectRows[projectRows.length - 1];
      last.amountBase = round(last.amountBase + uncovered);
    }
    if (uncovered > planTolerance(project)) {
      rows.push({
        amount: isBase(project.currency) ? uncovered
          : round(uncovered / (Number(project.fx) > 0 ? Number(project.fx) : 1)),
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
    if (info.advanceLeftBase > 0.01) {
      rows.push({
        id: `${assignment.id}:advance`,
        kind: 'assignment-advance',
        title: `Аванс — ${employee?.name || 'сотрудник'}`,
        subtitle: project?.name || '',
        amountBase: info.advanceLeftBase,
        dueDate: advanceDueDate(assignment, project),
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
        // Срока нет: одобренный клиентом остаток можно платить сразу.
        dueDate: '',
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
  // «Ожидается выплатить» — то, что уже пора платить; будущие сроки
  // (зарплата до дня выплаты, плановые платежи) сюда не входят.
  const nowIso = today();
  const toPay = sum(payables(state).filter((item) => item.ready && !(item.dueDate && item.dueDate > nowIso)),
    (item) => item.amountBase);
  const locked = sum(payables(state).filter((item) => !item.ready), (item) => item.amountBase);
  return { ...totals, toReceiveBase: toReceive, toPayBase: toPay, lockedPayBase: locked };
}

// ------------------------------------------------------------ уведомления

export function notifications(state, nowIso = today()) {
  const days = Number(state.settings.notifyDaysAhead);
  const horizon = Number.isFinite(days) && days >= 0 ? days : 7;
  const limit = addDaysIso(nowIso, horizon);
  const items = [];

  for (const row of receivables(state)) {
    if (row.overdue) {
      items.push({
        id: `late:${row.id}`, tone: 'danger', icon: '!',
        title: 'Просрочен платёж клиента',
        text: `${row.client?.name || 'Без клиента'} · ${row.project.name} · ${row.title}`,
        amountBase: row.amountBase, href: row.href || `#/projects/${row.projectId}`,
      });
    } else if (row.dueDate && row.dueDate <= limit) {
      items.push({
        id: `soon:${row.id}`, tone: 'warn', icon: '→',
        title: 'Клиент должен оплатить',
        text: `${row.project.name} · ${row.title} · до ${formatDate(row.dueDate, { short: true })}`,
        amountBase: row.amountBase, href: row.href || `#/projects/${row.projectId}`,
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
    // Остаток, который клиент ещё не одобрил, платить пока нельзя —
    // и тревожить «просрочкой» по нему незачем.
    if (row.ready === false) continue;
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
  // Одна система времени — местная: смешение UTC и местного сдвигало дату.
  return addDays(iso, days);
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

  // Лучшие проекты — среди проектов этого года.
  const ranked = projects
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
