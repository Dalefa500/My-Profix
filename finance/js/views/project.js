// Карточка проекта: деньги клиента, сдельные сотрудники, расходы, прибыль.

import {
  html, raw, money, sectionTitle, emptyState, badge, progressBar,
  openSheet, closeSheet, confirmDialog, toast,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { openReport } from '../report.js';
import { openOperation } from '../operation.js';
import { projectFinance, assignmentState } from '../calc.js';
import { PROJECT_STATUSES, WORK_STAGES, labelOf, categoryLabel } from '../model.js';
import { formatAmount, formatWithOriginal } from '../money.js';
import { formatDate } from '../dates.js';
import * as forms from '../forms.js';
import * as actions from '../actions.js';
import { refresh } from '../refresh.js';
import { go } from '../router.js';

function planRow(project, item) {
  const tone = item.status === 'received' ? 'good' : item.overdue ? 'danger' : 'warn';
  const label = item.status === 'received' ? 'Получен'
    : item.status === 'partial' ? 'Получен частично'
      : item.overdue ? 'Просрочен' : 'Ожидается';
  return html`
    <div class="row" data-plan="${item.id}">
      <div class="row__main">
        <span class="row__title">${item.title || labelOf([
          { id: 'advance', label: 'Аванс' },
          { id: 'final', label: 'Остаток' },
          { id: 'extra', label: 'Дополнительная работа' },
        ], item.type, 'Платёж')}</span>
        <span class="row__subtitle">${item.dueDate ? formatDate(item.dueDate, { short: true }) : 'Без срока'}</span>
        ${raw(badge(label, tone))}
      </div>
      <div class="row__side">
        <span class="row__amount">${formatAmount(item.amount, project.currency)}</span>
        ${item.leftBase > 0.01 ? raw(html`
          <button class="btn btn--sm btn--primary" data-receive="${item.id}">Получен</button>`) : ''}
        <button class="btn btn--sm btn--ghost" data-edit-plan="${item.id}">Изменить</button>
      </div>
    </div>`;
}

function assignmentRow(row, info) {
  const employee = byId('employees', row.employeeId);
  return html`
    <div class="row" data-assignment="${row.id}">
      <div class="row__main">
        <a class="row__title" href="#/employees/${row.employeeId}">${employee?.name || 'Сотрудник'}</a>
        <span class="row__subtitle">${row.role} · ${info.area} м² × ${formatAmount(info.rate, info.currency)} = ${formatAmount(info.accrued, info.currency)}</span>
        <span class="row__subtitle">Аванс ${info.percent}% · ${formatAmount(info.advance, info.currency)} ${info.advancePaid ? '· выплачен' : '· не выплачен'}</span>
        ${raw(badge(info.label, info.tone))}
      </div>
      <div class="row__side">
        <span class="row__amount">${money(info.accruedBase)}</span>
        <span class="row__meta">Выплачено ${money(info.paidBase)}</span>
        <div class="btn-row">
          ${!info.advancePaid && info.advance > 0
            ? raw(html`<button class="btn btn--sm btn--primary" data-pay-advance="${row.id}">Аванс</button>`)
            : ''}
          ${!info.remainderPaid && info.remainder > 0
            ? raw(info.remainderAvailable
              ? html`<button class="btn btn--sm btn--good" data-pay-final="${row.id}">Остаток</button>`
              : html`<button class="btn btn--sm" data-locked="${row.id}">Остаток заблокирован</button>`)
            : ''}
          <button class="btn btn--sm btn--ghost" data-edit-assignment="${row.id}">⋯</button>
        </div>
      </div>
    </div>`;
}

export default function projectDetail(params) {
  const state = getState();
  const project = byId('projects', params.id);
  if (!project) {
    return { title: 'Проект', back: '#/projects', body: emptyState('Проект не найден') };
  }

  const finance = projectFinance(state, project);
  const client = byId('clients', project.clientId);
  const lead = byId('employees', project.leadId);
  const receivedPercent = finance.contractBase > 0 ? finance.receivedBase / finance.contractBase * 100 : 0;

  const body = html`
    <div class="card">
      <div class="section-title">
        <h2>${project.name}</h2>
        <button class="btn btn--sm" data-act="status">${labelOf(PROJECT_STATUSES, project.status)}</button>
      </div>
      <p class="muted">
        ${client ? raw(html`<a href="#/clients/${client.id}">${client.name}</a> · `) : ''}
        ${project.objectType || 'Объект'}${project.area ? ` · ${project.area} м²` : ''}
        ${project.address ? ` · ${project.address}` : ''}
      </p>
      <p class="muted">
        Начало ${formatDate(project.startDate, { short: true })}
        ${project.dueDate ? ` · завершение ${formatDate(project.dueDate, { short: true })}` : ''}
        ${lead ? ` · ответственный ${lead.name}` : ''}
      </p>
      <div class="btn-row">
        <button class="btn btn--sm" data-act="edit">Изменить проект</button>
        <button class="btn btn--sm btn--ghost" data-act="delete">Удалить</button>
        <button class="btn btn--sm btn--ghost" data-report>Отчёт PDF</button>
      </div>
    </div>

    <div class="card">
      ${raw(sectionTitle('Деньги клиента'))}
      <div class="stats">
        <div class="stat"><span class="stat__label">Стоимость</span><strong class="stat__value">${money(finance.contractBase)}</strong>
          <span class="stat__hint">${project.currency !== 'USD' ? formatAmount(project.price, project.currency) : ''}</span></div>
        <div class="stat stat--good"><span class="stat__label">Получено</span><strong class="stat__value">${money(finance.receivedBase)}</strong>
          <span class="stat__hint">${Math.round(receivedPercent)}% от суммы</span></div>
        <div class="stat stat--warn"><span class="stat__label">Осталось получить</span><strong class="stat__value">${money(finance.toReceiveBase)}</strong></div>
        <div class="stat"><span class="stat__label">Прибыль проекта</span>
          <strong class="stat__value ${raw(finance.profitPlanBase >= 0 ? 'good-text' : 'danger-text')}">${money(finance.profitPlanBase)}</strong>
          <span class="stat__hint">Факт: ${money(finance.profitActualBase)}</span></div>
      </div>
      ${raw(progressBar(receivedPercent, receivedPercent >= 99.5 ? 'good' : 'warn'))}
      <button class="btn btn--primary btn--block" data-act="income">Записать приход по проекту</button>
    </div>

    <div class="card">
      ${raw(sectionTitle('План платежей', '<button class="btn btn--sm" data-act="add-plan">Добавить</button>'))}
      ${finance.plan.length
        ? raw(html`<div class="list">${raw(finance.plan.map((item) => planRow(project, item)).join(''))}</div>`)
        : raw(emptyState('План платежей пуст'))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Сдельные сотрудники', '<button class="btn btn--sm" data-act="add-assignment">Добавить</button>'))}
      ${finance.assignments.length
        ? raw(html`<div class="list">${raw(finance.assignments
          .map((row, index) => assignmentRow(row, finance.assignmentStates[index])).join(''))}</div>`)
        : raw(emptyState('Сотрудники на проект не назначены'))}
      ${finance.assignments.length ? raw(html`
        <p class="muted">Начислено ${money(finance.pieceworkAccruedBase)} · выплачено ${money(finance.pieceworkPaidBase)} · к выплате ${money(finance.pieceworkDueBase)}</p>`) : ''}
    </div>

    <div class="card">
      ${raw(sectionTitle('Расходы проекта', '<button class="btn btn--sm" data-act="add-expense">Добавить</button>'))}
      ${finance.directExpenses.length
        ? raw(html`<div class="list">${raw(finance.directExpenses.map((expense) => html`
          <button class="row" data-open-expense="${expense.id}" style="width:100%;text-align:left">
            <div class="row__main">
              <span class="row__title">${categoryLabel(expense.category, state.settings)}</span>
              <span class="row__subtitle">${expense.comment || formatDate(expense.date, { short: true })}</span>
            </div>
            <span class="row__amount danger">−${money(expense.base)}</span>
          </button>`).join(''))}</div>`)
        : raw(emptyState('Прямых расходов по проекту нет'))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Расчёт прибыли'))}
      <table class="data">
        <tbody>
          <tr><td>Доход по договору</td><td>${money(finance.contractBase)}</td></tr>
          <tr><td>Сдельные сотрудники</td><td class="danger">${raw(finance.pieceworkAccruedBase > 0 ? '−' : '')}${money(finance.pieceworkAccruedBase)}</td></tr>
          <tr><td>Другие расходы проекта</td><td class="danger">${raw(finance.directBase > 0 ? '−' : '')}${money(finance.directBase)}</td></tr>
        </tbody>
        <tfoot>
          <tr><td>Прибыль проекта</td><td class="${raw(finance.profitPlanBase >= 0 ? 'good' : 'danger')}">${money(finance.profitPlanBase)}</td></tr>
        </tfoot>
      </table>
      <p class="muted">Общие расходы компании (аренда, налоги, коммунальные) в прибыль проекта не включаются.</p>
    </div>`;

  return {
    title: project.name,
    subtitle: client?.name || '',
    back: '#/projects',
    body,
    mount(root) {
      root.querySelectorAll('[data-open-expense]').forEach((button) => {
        button.onclick = () => openOperation('expense', button.dataset.openExpense);
      });
      root.querySelector('[data-report]').onclick = () => openReport({ type: 'project', id: project.id });
      root.querySelector('[data-act="edit"]').onclick = () => forms.openProjectForm(project.id, refresh);
      root.querySelector('[data-act="income"]').onclick = () => forms.openIncomeForm({
        projectId: project.id,
        clientId: project.clientId,
        type: finance.receivedBase > 0 ? 'final' : 'advance',
        currency: project.currency,
        fx: project.fx,
      }, refresh);
      root.querySelector('[data-act="add-plan"]').onclick = () => forms.openPlanItemForm(project.id, null, refresh);
      root.querySelector('[data-act="add-assignment"]').onclick = () => forms.openAssignmentForm(project.id, null, refresh);
      root.querySelector('[data-act="add-expense"]').onclick = () => forms.openExpenseForm({ projectId: project.id }, refresh);

      root.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await confirmDialog(`Удалить проект «${project.name}»? Приходы и расходы останутся в истории компании.`);
        if (!ok) return;
        actions.deleteProject(project.id);
        toast('Проект удалён');
        go('#/projects');
      };

      root.querySelector('[data-act="status"]').onclick = () => openStatusSheet(project);

      root.querySelectorAll('[data-receive]').forEach((button) => {
        button.onclick = () => {
          const item = finance.plan.find((row) => row.id === button.dataset.receive);
          forms.openIncomeForm({
            projectId: project.id,
            clientId: project.clientId,
            type: item.type === 'extra' ? 'extra' : item.type,
            amount: item.leftBase / (project.fx || 1),
            currency: project.currency,
            fx: project.fx,
          }, refresh);
        };
      });
      root.querySelectorAll('[data-edit-plan]').forEach((button) => {
        button.onclick = () => openPlanSheet(project, button.dataset.editPlan);
      });
      root.querySelectorAll('[data-pay-advance]').forEach((button) => {
        button.onclick = () => forms.openAssignmentPayment(button.dataset.payAdvance, 'advance', refresh);
      });
      root.querySelectorAll('[data-pay-final]').forEach((button) => {
        button.onclick = () => forms.openAssignmentPayment(button.dataset.payFinal, 'final', refresh);
      });
      root.querySelectorAll('[data-locked]').forEach((button) => {
        button.onclick = () => toast('Остаток станет доступен после того, как клиент одобрит работу', 'danger');
      });
      root.querySelectorAll('[data-edit-assignment]').forEach((button) => {
        button.onclick = () => openAssignmentSheet(project, button.dataset.editAssignment);
      });
    },
  };
}

// Смена статуса проекта. Одобрение клиента открывает выплату остатков.
function openStatusSheet(project) {
  openSheet({
    title: 'Статус проекта',
    body: html`<div class="list">${raw(PROJECT_STATUSES.map((status) => html`
      <button class="row" data-status="${status.id}" style="width:100%;text-align:left">
        <div class="row__main">
          <span class="row__title">${status.label}</span>
          ${status.id === 'approved' ? raw(html`<span class="row__subtitle">Открывает выплату остатков сотрудникам</span>`) : ''}
        </div>
        ${raw(project.status === status.id ? badge('Текущий', 'info') : '')}
      </button>`).join(''))}</div>`,
    onMount: (panel) => {
      panel.querySelectorAll('[data-status]').forEach((button) => {
        button.onclick = () => {
          actions.setProjectStatus(project.id, button.dataset.status);
          closeSheet();
          toast('Статус обновлён', 'good');
          refresh();
        };
      });
    },
  });
}

function openPlanSheet(project, itemId) {
  openSheet({
    title: 'Платёж клиента',
    body: html`<div class="btn-row">
      <button class="btn" data-act="edit">Изменить</button>
      <button class="btn btn--danger" data-act="delete">Удалить</button>
    </div>`,
    onMount: (panel) => {
      panel.querySelector('[data-act="edit"]').onclick = () => {
        closeSheet();
        forms.openPlanItemForm(project.id, itemId, refresh);
      };
      panel.querySelector('[data-act="delete"]').onclick = () => {
        actions.deletePlanItem(project.id, itemId);
        closeSheet();
        refresh();
      };
    },
  });
}

// Этап работы сотрудника и действия с назначением.
function openAssignmentSheet(project, assignmentId) {
  const assignment = byId('assignments', assignmentId);
  const employee = byId('employees', assignment?.employeeId);
  const info = assignmentState(assignment, project);
  openSheet({
    title: employee?.name || 'Сотрудник',
    body: html`
      <p class="muted">${info.area} м² × ${formatAmount(info.rate, info.currency)} = ${formatAmount(info.accrued, info.currency)}
        · ${formatWithOriginal({ base: info.accruedBase, amount: info.accrued, currency: info.currency, fx: assignment.fx })}</p>
      ${raw(sectionTitle('Этап работы'))}
      <div class="list">${raw(WORK_STAGES.map((stage) => html`
        <button class="row" data-stage="${stage.id}" style="width:100%;text-align:left">
          <div class="row__main"><span class="row__title">${stage.label}</span></div>
          ${raw(assignment.stage === stage.id ? badge('Сейчас', 'info') : '')}
        </button>`).join(''))}</div>
      <div class="btn-row">
        <button class="btn" data-act="edit">Изменить расчёт</button>
        <button class="btn btn--danger" data-act="delete">Убрать из проекта</button>
      </div>`,
    onMount: (panel) => {
      panel.querySelectorAll('[data-stage]').forEach((button) => {
        button.onclick = () => {
          actions.setAssignmentStage(assignmentId, button.dataset.stage);
          closeSheet();
          toast('Этап обновлён', 'good');
          refresh();
        };
      });
      panel.querySelector('[data-act="edit"]').onclick = () => {
        closeSheet();
        forms.openAssignmentForm(project.id, assignmentId, refresh);
      };
      panel.querySelector('[data-act="delete"]').onclick = async () => {
        closeSheet();
        const ok = await confirmDialog('Убрать сотрудника из проекта? Уже сделанные выплаты останутся в расходах.', { confirmLabel: 'Убрать' });
        if (!ok) return;
        actions.deleteAssignment(assignmentId);
        refresh();
      };
    },
  });
}
