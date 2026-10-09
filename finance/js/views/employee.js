// Карточка сотрудника: начислено, выплачено, остаток.

import {
  html, raw, money, sectionTitle, emptyState, badge, confirmDialog, toast,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { employeeFinance, payrollState } from '../calc.js';
import { formatAmount, formatRate, formatArea } from '../money.js';
import { monthLabel, formatDate } from '../dates.js';
import * as forms from '../forms.js';
import * as actions from '../actions.js';
import { refresh } from '../refresh.js';
import { go, leave } from '../router.js';
import { openReport } from '../report.js';
import { openOperation } from '../operation.js';

function payrollCard(payroll) {
  const info = payrollState(payroll);
  return html`
    <div class="row">
      <div class="row__main">
        <span class="row__title">${monthLabel(payroll.month)}</span>
        <span class="row__subtitle">Начислено ${money(info.accruedBase)} · выплачено ${money(info.paidBase)}</span>
        ${raw(badge(info.label, info.tone))}
      </div>
      <div class="row__side">
        <span class="row__amount ${raw(info.leftBase > 0 ? 'danger' : 'good')}">${money(info.leftBase)}</span>
        <span class="row__meta">остаток</span>
        ${info.leftBase > 0.01
          ? raw(html`<button class="btn btn--sm btn--primary" data-pay-salary="${payroll.id}">Выплатить</button>`)
          : ''}
      </div>
    </div>`;
}

function shareCard(row) {
  const { assignment, project, state: info } = row;
  return html`
    <div class="row row--stack">
      <div class="row__main">
        <a class="row__title" href="#/projects/${assignment.projectId}">${project?.name || 'Проект удалён'}</a>
        <span class="row__subtitle">${info.percent}% от суммы проекта = ${formatAmount(info.accrued, info.currency)}</span>
        <span class="row__subtitle">Клиент оплатил — доля ${formatAmount(info.earned, info.currency)} · выплачено ${formatAmount(info.paidCur, info.currency)}</span>
        ${raw(badge(info.label, info.tone))}
      </div>
      <div class="row__side">
        <span class="row__amount">${money(info.accruedBase)}</span>
        <div class="btn-row">
          ${info.available > 0
            ? raw(html`<button class="btn btn--sm btn--good" data-pay-share="${assignment.id}">Выплатить ${formatAmount(info.available, info.currency)}</button>`) : ''}
        </div>
      </div>
    </div>`;
}

function assignmentCard(row) {
  if (row.state.mode === 'percent') return shareCard(row);
  const { assignment, project, state: info } = row;
  return html`
    <div class="row row--stack">
      <div class="row__main">
        <a class="row__title" href="#/projects/${assignment.projectId}">${project?.name || 'Проект удалён'}</a>
        <span class="row__subtitle">${assignment.role} · ${formatArea(info.area)} × ${formatAmount(info.rate, info.currency)} = ${formatAmount(info.accrued, info.currency)}</span>
        <span class="row__subtitle">${info.advance > 0 || info.advancePaid
          ? `Аванс ${formatAmount(info.advance, info.currency)} ${info.advancePaid ? '✓'
            : info.advancePaidCur > 0 ? `— выплачено ${formatAmount(info.advancePaidCur, info.currency)}` : '— не выплачен'}`
          : 'Без аванса'}
          · остаток ${formatAmount(info.remainder, info.currency)} ${info.remainderPaid ? '✓' : ''}</span>
        ${raw(badge(info.label, info.tone))}
      </div>
      <div class="row__side">
        <span class="row__amount">${money(info.accruedBase)}</span>
        <div class="btn-row">
          ${info.advanceLeft > 0
            ? raw(html`<button class="btn btn--sm btn--primary" data-pay-advance="${assignment.id}">Аванс</button>`) : ''}
          ${!info.remainderPaid && info.remainderAvailable
            ? raw(html`<button class="btn btn--sm btn--good" data-pay-final="${assignment.id}">Остаток</button>`) : ''}
        </div>
      </div>
    </div>`;
}

export default function employeeDetail(params) {
  const state = getState();
  const employee = byId('employees', params.id);
  if (!employee) {
    return { title: 'Сотрудник', back: '#/employees', body: emptyState('Сотрудник не найден') };
  }
  const finance = employeeFinance(state, employee);
  const isFixed = employee.payType === 'fixed';

  // Все выплаты, а не последние десять: «Выплачено» выше считается по ним всем.
  const payments = state.expenses
    .filter((item) => item.employeeId === employee.id);

  const body = html`
    <div class="card">
      <div class="section-title">
        <h2>${employee.name}</h2>
        ${raw(employee.active === false ? badge('Не работает', 'muted')
          : badge(isFixed ? 'Зарплата' : employee.payType === 'percent' ? 'Процент от проекта' : 'Сдельно', 'info'))}
      </div>
      <p class="muted">
        ${employee.position || '—'} ·
        ${isFixed
          ? `${formatAmount(employee.salary, employee.salaryCurrency)} в месяц, выплата ${employee.payday} числа`
          : employee.payType === 'percent'
            ? `${employee.percent ?? 50}% от суммы каждого проекта`
            : formatRate(employee.rate, employee.rateCurrency)}
      </p>
      ${employee.phone ? raw(html`<p class="muted">${employee.phone}</p>`) : ''}
      <div class="btn-row">
        <button class="btn btn--sm" data-act="edit">Изменить</button>
        <button class="btn btn--sm btn--ghost" data-act="delete">Удалить</button>
        <button class="btn btn--sm btn--ghost" data-report>Отчёт PDF</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><span class="stat__label">Начислено</span><strong class="stat__value">${money(finance.accruedBase)}</strong></div>
      <div class="stat stat--good"><span class="stat__label">Выплачено</span><strong class="stat__value">${money(finance.paidBase)}</strong></div>
      <div class="stat stat--warn"><span class="stat__label">К выплате сейчас</span><strong class="stat__value">${money(finance.dueNowBase)}</strong></div>
      <div class="stat"><span class="stat__label">Ждёт клиента</span><strong class="stat__value">${money(finance.lockedBase)}</strong></div>
    </div>

    ${isFixed || finance.payrolls.length ? raw(html`
      <div class="card">
        ${raw(sectionTitle('Зарплата по месяцам'))}
        ${finance.payrolls.length
          ? raw(html`<div class="list">${raw(finance.payrolls.map(payrollCard).join(''))}</div>`)
          : raw(emptyState('Начислений пока нет'))}
        ${isFixed ? raw(html`<p class="muted">Начисление создаётся автоматически в начале каждого месяца.</p>`) : ''}
      </div>`) : ''}
    ${!isFixed || finance.rows.length ? raw(html`
      <div class="card">
        ${raw(sectionTitle('Работа по проектам'))}
        ${finance.rows.length
          ? raw(html`<div class="list">${raw(finance.rows.map(assignmentCard).join(''))}</div>`)
          : raw(emptyState(employee.payType === 'percent'
            ? 'Добавьте сотрудника в проект: карточка проекта → «Сотрудники на проекте» → «Добавить»'
            : 'Сотрудник пока не назначен ни на один проект'))}
      </div>`) : ''}

    <div class="card">
      ${raw(sectionTitle('История выплат'))}
      ${payments.length
        ? raw(html`<div class="list">${raw(payments.map((item) => html`
          <button class="row" data-open="${item.id}" style="width:100%;text-align:left">
            <div class="row__main">
              <span class="row__title">${item.comment || 'Выплата'}</span>
              <span class="row__subtitle">${formatDate(item.date, { short: true })}</span>
            </div>
            <span class="row__amount danger">−${money(item.base)}</span>
          </button>`).join(''))}</div>`)
        : raw(emptyState('Выплат ещё не было'))}
    </div>`;

  return {
    title: employee.name,
    subtitle: employee.position || '',
    back: '#/employees',
    body,
    mount(root) {
      // Нажатие на выплату открывает её карточку: оттуда ошибочную запись
      // можно сразу удалить, не разыскивая её в общем списке операций.
      root.querySelectorAll('[data-open]').forEach((button) => {
        button.onclick = () => openOperation('expense', button.dataset.open);
      });
      root.querySelector('[data-report]').onclick = () => openReport({ type: 'employee', id: employee.id });
      root.querySelector('[data-act="edit"]').onclick = () => forms.openEmployeeForm(employee.id, refresh);
      root.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await confirmDialog(`Удалить сотрудника «${employee.name}»? Его начисления будут удалены, а проведённые выплаты останутся в расходах.`);
        if (!ok) return;
        actions.deleteEmployee(employee.id);
        toast('Сотрудник удалён');
        leave('#/employees');
      };
      root.querySelectorAll('[data-pay-salary]').forEach((button) => {
        button.onclick = () => forms.openPayrollPayment(button.dataset.paySalary, refresh);
      });
      root.querySelectorAll('[data-pay-advance]').forEach((button) => {
        button.onclick = () => forms.openAssignmentPayment(button.dataset.payAdvance, 'advance', refresh);
      });
      root.querySelectorAll('[data-pay-final]').forEach((button) => {
        button.onclick = () => forms.openAssignmentPayment(button.dataset.payFinal, 'final', refresh);
      });
      root.querySelectorAll('[data-pay-share]').forEach((button) => {
        button.onclick = () => forms.openAssignmentPayment(button.dataset.payShare, 'share', refresh);
      });
    },
  };
}
