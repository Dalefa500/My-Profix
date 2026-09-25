// Взаиморасчёты: клиент платит не деньгами, а квартирой, машиной или
// материалами. Мы записываем оценку имущества, а выполненные работы
// списываем с неё по этапам, пока оценка не будет отработана.
//
// Модуль общий: карточка имущества открывается из экрана «Взаиморасчёты»,
// из карточки клиента и из отчётов.

import {
  html, raw, money, openSheet, closeSheet, confirmDialog, toast, openForm, progressBar,
} from './ui.js';
import { getState, byId, canEdit } from './store.js';
import { barterState } from './calc.js';
import { BARTER_KINDS, labelOf } from './model.js';
import { formatDate, today } from './dates.js';
import { formatAmount } from './money.js';
import * as forms from './forms.js';
import * as actions from './actions.js';
import { refresh } from './refresh.js';
import { openOperation } from './operation.js';

// Карточка имущества: сколько стоит, сколько уже отработано, что осталось,
// и все этапы списания по порядку.
export function openBarterSheet(id) {
  const state = getState();
  const barter = byId('barters', id);
  if (!barter) return;
  const row = barterState(state, barter);
  const client = byId('clients', barter.clientId);
  const editable = canEdit();

  openSheet({
    title: barter.title,
    body: html`
      <p class="muted">${client?.name || 'Без клиента'} · ${labelOf(BARTER_KINDS, barter.kind, 'Имущество')}</p>
      <p class="hero__value" style="color:var(--ink)">${money(row.leftBase)}</p>
      <p class="muted">${row.done ? 'Имущество полностью отработано' : 'осталось отработать'}</p>
      ${raw(progressBar(row.percent, row.done ? 'good' : 'warn'))}

      <div class="list">
        <div class="row"><div class="row__main"><span class="row__subtitle">Оценка имущества</span>
          <span class="row__title">${money(row.totalBase)}</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Отработано работами</span>
          <span class="row__title">${money(row.usedBase)} · ${row.percent}%</span></div></div>
        ${row.overBase > 0 ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Сверх оценки</span>
          <span class="row__title danger-text">${money(row.overBase)} — клиент должен деньгами</span></div></div>`) : ''}
        <div class="row"><div class="row__main"><span class="row__subtitle">Дата договорённости</span>
          <span class="row__title">${formatDate(barter.date)}</span></div></div>
        ${barter.note ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Заметка</span>
          <span class="row__title">${barter.note}</span></div></div>`) : ''}
      </div>

      <p class="muted" style="margin-top:14px">${row.stages.length
        ? 'Этапы — нажмите, чтобы исправить или удалить'
        : 'Работы ещё не списывались. Нажмите «Списать работы», когда этап выполнен.'}</p>
      ${row.stages.length ? raw(html`<div class="list">${raw(row.stages.map((stage, index) => html`
        <button class="row" data-stage-income="${stage.income.id}" style="width:100%;text-align:left">
          <div class="row__main">
            <span class="row__title">${index + 1}. ${stage.income.comment || byId('projects', stage.income.projectId)?.name || 'Выполненные работы'}</span>
            <span class="row__subtitle">${formatDate(stage.income.date, { short: true })} · осталось ${money(Math.max(0, stage.leftAfterBase))}</span>
          </div>
          <div class="row__side"><span class="row__amount">−${money(stage.income.base)}</span></div>
        </button>`).join(''))}</div>`) : ''}`,
    // Главная кнопка — первой и во всю ширину: три кнопки в ряд
    // на узком экране не помещались и обрезались.
    footer: editable ? html`
      ${row.done ? '' : raw(html`<button class="btn btn--primary sheet__main" data-act="use">Списать работы</button>`)}
      <button class="btn" data-act="edit">Изменить</button>
      <button class="btn btn--danger" data-act="delete">Удалить</button>` : '',
    onMount: (panel) => {
      panel.querySelectorAll('[data-stage-income]').forEach((button) => {
        button.onclick = () => {
          closeSheet();
          openOperation('income', button.dataset.stageIncome);
        };
      });
      panel.querySelector('[data-act="use"]')?.addEventListener('click', () => {
        closeSheet();
        openBarterUseForm(id);
      });
      panel.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
        closeSheet();
        forms.openBarterForm(id, {}, refresh);
      });
      panel.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
        closeSheet();
        const ok = await confirmDialog('Удалить взаимозачёт? Уже списанные работы останутся доходом.');
        if (!ok) return;
        actions.deleteBarter(id);
        toast('Взаимозачёт удалён');
        refresh();
      });
    },
  });
}

// Списать выполненные работы с имущества. Отдельная короткая форма:
// сумма работ, дата, что сделано. Всё остальное подставляется само.
export function openBarterUseForm(id, onDone = refresh) {
  const state = getState();
  const barter = byId('barters', id);
  if (!barter) return;
  const row = barterState(state, barter);
  const projects = state.projects
    .filter((item) => item.clientId === barter.clientId && item.status !== 'cancelled');

  openForm({
    title: 'Списать выполненные работы',
    intro: `${barter.title}${byId('clients', barter.clientId) ? ` · ${byId('clients', barter.clientId).name}` : ''}. `
      + `Осталось отработать ${formatAmount(row.leftBase)} из ${formatAmount(row.totalBase)}.`,
    fields: [
      {
        name: 'amount', label: 'На сколько выполнено работ', type: 'money', required: true,
        value: '',
        hint: 'Эта сумма спишется с оценки имущества и попадёт в доход студии.',
      },
      {
        name: 'comment', label: 'Какие работы', type: 'text', wide: true, value: '',
        placeholder: 'Например: дизайн-проект 2 этажа',
      },
      { name: 'date', label: 'Дата', type: 'date', required: true, value: today() },
      ...(projects.length ? [{
        name: 'projectId', label: 'По какому проекту', type: 'select',
        options: [{ value: '', label: 'Без проекта' }, ...projects.map((item) => ({ value: item.id, label: item.name }))],
        value: projects.length === 1 ? projects[0].id : '',
      }] : []),
    ],
    submitLabel: 'Списать',
    onSubmit: (values) => {
      const amount = Number(values.amount);
      if (!(amount > 0)) {
        toast('Укажите сумму работ', 'danger');
        return false;
      }
      const record = {
        amount: values.amount,
        currency: values.amountCurrency,
        fx: values.amountFx,
        date: values.date,
        projectId: values.projectId || null,
        clientId: barter.clientId,
        method: 'barter',
        barterId: id,
        type: values.projectId ? 'final' : 'other',
        comment: values.comment,
      };
      actions.saveIncome(record);
      const after = barterState(getState(), byId('barters', id));
      if (after.overBase > 0) {
        toast(`Списано. Работ больше оценки на ${formatAmount(after.overBase)} — клиент должен доплатить`, 'danger');
      } else {
        toast(after.done ? 'Списано. Имущество полностью отработано' : `Списано. Осталось ${formatAmount(after.leftBase)}`, 'good');
      }
      onDone?.();
      return true;
    },
  });
}
