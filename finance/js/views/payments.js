// Платежи: что получить от клиентов и что выплатить.

import { html, raw, money, emptyState, badge, sectionTitle, toast } from '../ui.js';
import { getState, byId } from '../store.js';
import { receivables, payables } from '../calc.js';
import { formatDate, today, daysUntil } from '../dates.js';
import { categoryLabel } from '../model.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';

function dueBadge(dueDate) {
  if (!dueDate) return badge('Без срока', 'muted');
  const days = daysUntil(dueDate, today());
  if (days < 0) return badge(`Просрочено на ${Math.abs(days)} дн.`, 'danger');
  if (days === 0) return badge('Сегодня', 'warn');
  if (days <= 7) return badge(`Через ${days} дн.`, 'warn');
  return badge(formatDate(dueDate, { short: true }), 'muted');
}

function receiveTab(state) {
  const rows = receivables(state);
  const total = rows.reduce((acc, row) => acc + row.amountBase, 0);

  return html`
    <div class="stat stat--good">
      <span class="stat__label">Всего к получению</span>
      <strong class="stat__value">${money(total)}</strong>
      <span class="stat__hint">${rows.length} платежей от клиентов</span>
    </div>
    <div class="card card--flat">
      ${rows.length ? raw(html`<div class="list">${raw(rows.map((row) => html`
        <div class="row">
          <div class="row__main">
            <a class="row__title" href="#/projects/${row.projectId}">${row.project.name}</a>
            <span class="row__subtitle">${row.client?.name || 'Без клиента'} · ${row.title}</span>
            ${raw(dueBadge(row.dueDate))}
          </div>
          <div class="row__side">
            <span class="row__amount good">${money(row.amountBase)}</span>
            <button class="btn btn--sm btn--primary" data-receive="${row.projectId}" data-amount="${row.amountBase}" data-type="${row.type}">Получено</button>
          </div>
        </div>`).join(''))}</div>`)
        : raw(emptyState('Все клиенты рассчитались'))}
    </div>`;
}

function payTab(state) {
  const rows = payables(state);
  const ready = rows.filter((row) => row.ready);
  const waiting = rows.filter((row) => !row.ready);
  const readyTotal = ready.reduce((acc, row) => acc + row.amountBase, 0);
  const waitingTotal = waiting.reduce((acc, row) => acc + row.amountBase, 0);

  const renderRow = (row) => html`
    <div class="row">
      <div class="row__main">
        <span class="row__title">${row.title}</span>
        <span class="row__subtitle">${row.kind === 'planned' ? categoryLabel(row.subtitle, state.settings) : row.subtitle}</span>
        ${raw(row.ready ? dueBadge(row.dueDate) : badge('Ждёт одобрения клиента', 'warn'))}
      </div>
      <div class="row__side">
        <span class="row__amount danger">${money(row.amountBase)}</span>
        ${row.ready ? raw(html`<button class="btn btn--sm btn--primary"
          data-pay="${row.id}" data-kind="${row.kind}"
          data-assignment="${row.assignmentId || ''}" data-payroll="${row.payrollId || ''}"
          data-planned="${row.plannedId || ''}">Выплатить</button>`) : ''}
      </div>
    </div>`;

  return html`
    <div class="stats">
      <div class="stat stat--warn"><span class="stat__label">Готово к выплате</span><strong class="stat__value">${money(readyTotal)}</strong></div>
      <div class="stat"><span class="stat__label">После согласования</span><strong class="stat__value">${money(waitingTotal)}</strong></div>
    </div>

    <div class="card card--flat">
      ${raw(sectionTitle('Можно выплачивать', '<button class="btn btn--sm" data-act="add-planned">Плановый платёж</button>'))}
      ${ready.length ? raw(html`<div class="list">${raw(ready.map(renderRow).join(''))}</div>`)
        : raw(emptyState('Нет обязательств к выплате'))}
    </div>

    ${waiting.length ? raw(html`
      <div class="card card--flat">
        ${raw(sectionTitle('Ждут одобрения клиента'))}
        <div class="list">${raw(waiting.map(renderRow).join(''))}</div>
        <p class="muted">Остаток сдельного сотрудника выплачивается после того, как клиент одобрил работу.</p>
      </div>`) : ''}`;
}

export default function payments(params) {
  const state = getState();
  const tab = params.tab === 'pay' ? 'pay' : 'get';

  const body = html`
    <div class="tabs">
      <a class="tabs__item ${raw(tab === 'get' ? 'is-active' : '')}" href="#/payments/get">Получить</a>
      <a class="tabs__item ${raw(tab === 'pay' ? 'is-active' : '')}" href="#/payments/pay">Выплатить</a>
    </div>
    ${raw(tab === 'get' ? receiveTab(state) : payTab(state))}`;

  return {
    title: 'Платежи',
    subtitle: tab === 'get' ? 'Долг клиентов' : 'Обязательства компании',
    back: '#/',
    body,
    mount(root) {
      root.querySelectorAll('[data-receive]').forEach((button) => {
        button.onclick = () => {
          const project = byId('projects', button.dataset.receive);
          forms.openIncomeForm({
            projectId: project.id,
            clientId: project.clientId,
            type: button.dataset.type === 'extra' ? 'extra' : button.dataset.type,
            amount: Number(button.dataset.amount) / (project.fx || 1),
            currency: project.currency,
            fx: project.fx,
          }, refresh);
        };
      });
      root.querySelector('[data-act="add-planned"]')?.addEventListener('click', () => {
        forms.openPlannedForm(null, refresh);
      });
      root.querySelectorAll('[data-pay]').forEach((button) => {
        button.onclick = () => {
          const { kind } = button.dataset;
          if (kind === 'assignment-advance') forms.openAssignmentPayment(button.dataset.assignment, 'advance', refresh);
          else if (kind === 'assignment-final') forms.openAssignmentPayment(button.dataset.assignment, 'final', refresh);
          else if (kind === 'payroll') forms.openPayrollPayment(button.dataset.payroll, refresh);
          else if (kind === 'planned') forms.openPlannedPayment(button.dataset.planned, refresh);
          else toast('Неизвестный тип платежа', 'danger');
        };
      });
    },
  };
}
