// Партнёры студии: сколько каждый взял из кассы.
//
// Деньги, которые партнёр берёт для себя, — это его доля прибыли,
// а не расход студии. Поэтому они не уменьшают прибыль и живут отдельно
// от расходов: в отчётах видно и то, и другое, но не вперемешку.

import {
  html, raw, money, emptyState, sectionTitle, statCard, chips, confirmDialog, toast,
  openSheet, closeSheet,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { foundersSummary, periodTotals } from '../calc.js';
import { rangeFor, formatDate } from '../dates.js';
import { PAYMENT_METHODS, labelOf } from '../model.js';
import * as forms from '../forms.js';
import * as actions from '../actions.js';
import { refresh } from '../refresh.js';
import { openReport } from '../report.js';

const PERIODS = [
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: '3 месяца' },
  { value: 'half', label: '6 месяцев' },
  { value: 'year', label: 'Год' },
  { value: 'all', label: 'Всё время' },
];

const periodState = { preset: 'month' };

function currentRange() {
  return rangeFor(periodState.preset);
}

export default function founders() {
  const state = getState();
  const range = currentRange();
  const summary = foundersSummary(state, range.from, range.to);
  const totals = periodTotals(state, range.from, range.to);
  // Сколько прибыли осталось нераспределённой за тот же период.
  const leftBase = totals.profitBase - summary.periodBase;

  const body = html`
    <div class="chips" data-period>
      ${raw(PERIODS.map((item) => html`
        <button type="button" class="chip ${raw(item.value === periodState.preset ? 'is-active' : '')}"
          data-value="${item.value}">${item.label}</button>`).join(''))}
    </div>

    <div class="stats">
      ${raw(statCard({
        label: `Прибыль · ${range.label}`,
        value: money(totals.profitBase),
        hint: 'доходы минус расходы студии',
      }))}
      ${raw(statCard({
        label: 'Взяли партнёры',
        value: money(summary.periodBase),
        hint: 'за тот же период',
        tone: 'warn',
      }))}
      ${raw(statCard({
        label: 'Осталось в деле',
        value: money(leftBase),
        hint: leftBase < 0 ? 'взяли больше, чем заработали' : 'прибыль за вычетом изъятий',
        tone: leftBase < 0 ? 'danger' : 'good',
      }))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Партнёры', '<button class="btn btn--sm" data-act="add-founder">Добавить</button>'))}
      ${summary.rows.length
        ? raw(html`<div class="list">${raw(summary.rows.map((row) => html`
          <a class="row" href="#/founders/${row.founder.id}">
            <div class="row__main">
              <span class="row__title">${row.founder.name}</span>
              <span class="row__subtitle">${row.founder.role || 'Партнёр'}
                · всего взял ${money(row.totalBase)}</span>
            </div>
            <div class="row__side">
              <span class="row__amount">${money(row.periodBase)}</span>
              <span class="row__meta">${range.label.toLowerCase()}</span>
            </div>
          </a>`).join(''))}</div>`)
        : raw(emptyState('Партнёры не заведены. Добавьте Шохина и Ризвона, чтобы вести их выплаты.'))}
    </div>

    ${summary.rows.length ? raw(html`
      <button class="btn btn--primary btn--block" data-act="add-draw">Записать выдачу</button>`) : ''}

    <p class="muted">Деньги, которые партнёр берёт для себя, — это его доля прибыли.
      В расходы студии они не попадают, поэтому прибыль от них не уменьшается.</p>`;

  return {
    title: 'Партнёры',
    subtitle: range.label,
    back: '#/',
    body,
    mount(root) {
      root.querySelector('[data-period]').addEventListener('click', (event) => {
        const button = event.target.closest('.chip');
        if (!button) return;
        periodState.preset = button.dataset.value;
        refresh();
      });
      root.querySelector('[data-act="add-founder"]').onclick = () => forms.openFounderForm(null, refresh);
      root.querySelector('[data-act="add-draw"]')?.addEventListener('click', () => {
        forms.openDrawForm('', null, refresh);
      });
    },
  };
}

// ---------------------------------------------------------- карточка

export function founderDetail(params) {
  const state = getState();
  const founder = byId('founders', params.id);
  if (!founder) {
    return { title: 'Партнёр', back: '#/founders', body: emptyState('Партнёр не найден') };
  }
  const range = currentRange();
  const row = foundersSummary(state, range.from, range.to).rows
    .find((item) => item.founder.id === founder.id);

  const body = html`
    <div class="card">
      <h2>${founder.name}</h2>
      <p class="muted">${founder.role || 'Партнёр'}</p>
      ${founder.note ? raw(html`<p class="muted">${founder.note}</p>`) : ''}
      <div class="btn-row">
        <button class="btn btn--sm" data-act="edit">Изменить</button>
        <button class="btn btn--sm btn--ghost" data-act="delete">Удалить</button>
        <button class="btn btn--sm btn--ghost" data-report>Отчёт PDF</button>
      </div>
    </div>

    <div class="stats">
      ${raw(statCard({ label: `Взял · ${range.label}`, value: money(row.periodBase) }))}
      ${raw(statCard({ label: 'Всего за всё время', value: money(row.totalBase), tone: 'warn' }))}
    </div>

    <button class="btn btn--primary btn--block" data-act="add-draw">Записать выдачу</button>

    <div class="card">
      ${raw(sectionTitle('История выдач'))}
      ${row.draws.length
        ? raw(html`<div class="list">${raw(row.draws.map((item) => html`
          <button class="row" data-open-draw="${item.id}" style="width:100%;text-align:left">
            <div class="row__main">
              <span class="row__title">${item.comment || labelOf(PAYMENT_METHODS, item.method, 'Наличные')}</span>
              <span class="row__subtitle">${formatDate(item.date, { short: true })}</span>
            </div>
            <span class="row__amount">${money(item.base)}</span>
          </button>`).join(''))}</div>`)
        : raw(emptyState('Выдач ещё не было'))}
    </div>`;

  return {
    title: founder.name,
    subtitle: 'Партнёр',
    back: '#/founders',
    body,
    mount(root) {
      root.querySelector('[data-report]').onclick = () => openReport({
        type: 'founder', id: founder.id, from: range.from, to: range.to,
      });
      root.querySelector('[data-act="edit"]').onclick = () => forms.openFounderForm(founder.id, refresh);
      root.querySelector('[data-act="add-draw"]').onclick = () => forms.openDrawForm(founder.id, null, refresh);
      root.querySelectorAll('[data-open-draw]').forEach((button) => {
        button.onclick = () => openDrawSheet(button.dataset.openDraw);
      });
      root.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await confirmDialog(`Удалить партнёра «${founder.name}»? Все его выдачи тоже удалятся.`);
        if (!ok) return;
        actions.deleteFounder(founder.id);
        toast('Партнёр удалён');
        window.history.back();
      };
    },
  };
}

function openDrawSheet(id) {
  const draw = byId('draws', id);
  if (!draw) return;
  const founder = byId('founders', draw.founderId);

  openSheet({
    title: 'Выдача партнёру',
    body: html`
      <p class="hero__value" style="color:var(--ink)">${money(draw.base)}</p>
      <div class="list">
        <div class="row"><div class="row__main"><span class="row__subtitle">Кто взял</span>
          <span class="row__title">${founder?.name || '—'}</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Дата</span>
          <span class="row__title">${formatDate(draw.date)}</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Чем выдано</span>
          <span class="row__title">${labelOf(PAYMENT_METHODS, draw.method, 'Наличные')}</span></div></div>
        ${draw.comment ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Комментарий</span>
          <span class="row__title">${draw.comment}</span></div></div>`) : ''}
        ${draw.createdBy ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Внёс</span>
          <span class="row__title">${draw.createdBy}</span></div></div>`) : ''}
      </div>`,
    footer: html`
      <button class="btn" data-act="edit">Изменить</button>
      <button class="btn btn--danger" data-act="delete">Удалить</button>`,
    onMount: (panel) => {
      panel.querySelector('[data-act="edit"]').onclick = () => {
        closeSheet();
        forms.openDrawForm(draw.founderId, id, refresh);
      };
      panel.querySelector('[data-act="delete"]').onclick = async () => {
        closeSheet();
        const ok = await confirmDialog('Удалить запись о выдаче?');
        if (!ok) return;
        actions.deleteDraw(id);
        toast('Запись удалена');
        refresh();
      };
    },
  });
}
