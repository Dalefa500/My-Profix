// Карточка одной операции: приход или расход.
//
// Живёт отдельным модулем, потому что открывается с нескольких экранов:
// из «Финансов», из истории выплат сотрудника и из движения денег по проекту.
// Чтобы удалить ошибочную запись, не нужно искать её в общем списке —
// достаточно нажать на неё там, где она попалась на глаза.

import {
  html, raw, money, openSheet, closeSheet, confirmDialog, toast,
} from './ui.js';
import { getState, byId } from './store.js';
import { formatDate } from './dates.js';
import { INCOME_TYPES, PAYMENT_METHODS, categoryLabel, labelOf } from './model.js';
import { formatAmount, formatUsdRate, rateToHuman } from './money.js';
import * as forms from './forms.js';
import * as actions from './actions.js';
import { refresh } from './refresh.js';

export function openOperation(tab, id) {
  const state = getState();
  const isIncome = tab === 'income';
  const item = byId(isIncome ? 'incomes' : 'expenses', id);
  if (!item) return;
  const project = byId('projects', item.projectId);
  const client = byId('clients', item.clientId);
  const barter = item.barterId ? byId('barters', item.barterId) : null;
  const system = !isIncome && Boolean(item.source);

  openSheet({
    title: isIncome ? 'Приход' : 'Расход',
    body: html`
      <p class="hero__value" style="color:var(--ink)">${money(item.base)}</p>
      <div class="list">
        <div class="row"><div class="row__main"><span class="row__subtitle">Дата</span><span class="row__title">${formatDate(item.date)}</span></div></div>
        ${!isIncome ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Категория</span>
          <span class="row__title">${categoryLabel(item.category, state.settings)}</span></div></div>`) : ''}
        ${isIncome ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Тип платежа</span>
          <span class="row__title">${labelOf(INCOME_TYPES, item.type)}</span></div></div>`) : ''}
        ${project ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Проект</span>
          <span class="row__title">${project.name}</span></div></div>`) : ''}
        ${client ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Клиент</span>
          <span class="row__title">${client.name}</span></div></div>`) : ''}
        <div class="row"><div class="row__main"><span class="row__subtitle">Способ оплаты</span>
          <span class="row__title">${labelOf(PAYMENT_METHODS, item.method, 'Наличные')}</span></div></div>
        ${item.currency !== 'USD' ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Введено в сомони</span>
          <span class="row__title">${formatAmount(item.amount, item.currency)} по курсу ${formatUsdRate(rateToHuman(item.fx))}</span></div></div>`) : ''}
        ${barter ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Зачтено с имущества</span>
          <span class="row__title">${barter.title}</span></div></div>`) : ''}
        ${item.comment ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Комментарий</span>
          <span class="row__title">${item.comment}</span></div></div>`) : ''}
        ${item.createdBy ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Внёс</span>
          <span class="row__title">${item.createdBy}</span></div></div>`) : ''}
      </div>
      ${system ? raw(html`<p class="muted">${item.source === 'founder'
        ? 'Расход оплачен партнёром из своих денег. При удалении пропадёт и запись о его деньгах, а долг студии уменьшится.'
        : 'Операция создана выплатой сотруднику или плановым платежом. При удалении обязательство вернётся.'}</p>`) : ''}`,
    footer: html`
      ${system ? '' : raw(html`<button class="btn" data-act="edit">Изменить</button>`)}
      <button class="btn btn--danger" data-act="delete">Удалить</button>`,
    onMount: (panel) => {
      panel.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
        closeSheet();
        if (isIncome) forms.openIncomeForm({ id }, refresh);
        else forms.openExpenseForm({ id }, refresh);
      });
      panel.querySelector('[data-act="delete"]').onclick = async () => {
        closeSheet();
        const ok = await confirmDialog('Удалить операцию? Это изменит отчёты за период.');
        if (!ok) return;
        if (isIncome) actions.deleteIncome(id);
        else actions.deleteExpense(id);
        toast('Операция удалена');
        refresh();
      };
    },
  });
}
