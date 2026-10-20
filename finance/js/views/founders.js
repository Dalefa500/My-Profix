// Коллеги студии: сколько каждый взял из кассы.
//
// Деньги, которые коллега берёт для себя, — это его доля прибыли,
// а не расход студии. Поэтому они не уменьшают прибыль и живут отдельно
// от расходов: в отчётах видно и то, и другое, но не вперемешку.

import {
  html, raw, money, emptyState, sectionTitle, statCard, chips, confirmDialog, toast,
  openSheet, closeSheet,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { foundersSummary, periodTotals } from '../calc.js';
import { rangeFor, formatDate } from '../dates.js';
import { PAYMENT_METHODS, FOUNDER_MOVES, labelOf, categoryLabel } from '../model.js';
import * as forms from '../forms.js';
import * as actions from '../actions.js';
import { refresh } from '../refresh.js';
import { openReport } from '../report.js';
import { go, leave } from '../router.js';

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
  // Сколько осталось в студии за тот же период: прибыль минус изъятия
  // плюс вклады учредителей.
  const leftBase = totals.leftBase;
  // Окупаемость вложений: сколько прибыли студия заработала за всё время
  // против того, сколько учредители вложили.
  // Прибыль берём без расходов, оплаченных самими вкладами (ремонт,
  // техника): иначе вложения вычитались бы дважды.
  const allTime = periodTotals(state, '0000-01-01', '9999-12-31');
  const paidByInvest = (state.draws || []).filter((item) => ['invest', 'spend'].includes(item.kind) && item.expenseId)
    .reduce((acc, item) => acc + (Number(item.base) || 0), 0);
  const operatingProfit = allTime.profitBase + paidByInvest;
  const payback = summary.investedBase > 0
    ? Math.max(0, Math.min(100, Math.round((operatingProfit / summary.investedBase) * 100))) : 0;
  // Показываем всех учредителей, как только кто-то что-то вложил:
  // видно и того, кто пока не вкладывал.
  const investors = summary.rows.some((row) => row.investedBase > 0 || row.repaidBase > 0) ? summary.rows : [];

  const body = html`
    <div class="chips" data-period>
      ${raw(PERIODS.map((item) => html`
        <button type="button" class="chip ${raw(item.value === periodState.preset ? 'is-active' : '')}"
          data-value="${item.value}">${item.label}</button>`).join(''))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Вложения учредителей', '<span class="muted">за всё время</span>'))}
      ${investors.length ? raw(html`
        <div class="list">${raw(investors.map((row) => html`
          <a class="row" href="#/founders/${row.founder.id}">
            <div class="row__main">
              <span class="row__title">${row.founder.name}</span>
              <span class="row__subtitle">вложил ${money(row.investedBase)}${row.repaidBase > 0 ? ` · забрал ${money(row.repaidBase)}` : ''}</span>
            </div>
            <div class="row__side">
              <span class="row__amount ${raw(row.owedBase > 0 ? 'danger' : 'good')}">${money(row.owedBase)}</span>
              <span class="row__meta">${row.owedBase > 0 ? 'студия должна' : 'всё вернули'}</span>
            </div>
          </a>`).join(''))}
          <div class="row">
            <div class="row__main">
              <span class="row__title">Итого студия должна учредителям</span>
              <span class="row__subtitle">вложили ${money(summary.investedBase)}${summary.repaidBase > 0 ? ` · вернули ${money(summary.repaidBase)}` : ''} · прибыль студии окупила ${payback}%</span>
            </div>
            <div class="row__side"><span class="row__amount ${raw(summary.owedBase > 0 ? 'danger' : 'good')}">${money(summary.owedBase)}</span></div>
          </div>
        </div>`)
        : raw(emptyState('Учредители пока ничего не вкладывали. Когда учредитель платит за студию из своего кармана (аренда, мелкие расходы) — нажмите «Записать вклад».'))}
    </div>

    ${summary.rows.length ? raw(html`
      <div class="btn-row">
        <button class="btn btn--primary" data-act="add-invest">Записать вклад</button>
        <button class="btn" data-act="add-repay">Забрал вложенное</button>
        <button class="btn btn--ghost" data-act="add-draw">Взял для себя</button>
      </div>`) : ''}

    <div class="stats">
      ${raw(statCard({
        label: `Прибыль · ${range.label}`,
        value: money(totals.profitBase),
        hint: 'доходы минус расходы студии',
      }))}
      ${raw(statCard({
        label: 'Взяли коллеги',
        value: money(summary.periodBase),
        hint: 'за тот же период',
        tone: 'warn',
      }))}
      ${raw(statCard({
        label: 'Осталось в студии',
        value: money(leftBase),
        hint: leftBase < 0 ? 'потратили больше, чем было' : 'прибыль минус изъятия, плюс вложенное, минус возвращённое',
        tone: leftBase < 0 ? 'danger' : 'good',
      }))}
      ${raw(statCard({
        label: `Вложили · ${range.label}`,
        value: money(summary.periodInvestedBase),
        hint: totals.repayBase > 0 ? `вернули учредителям ${money(totals.repayBase)}` : 'учредители из своего кармана',
      }))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Коллеги', '<button class="btn btn--sm" data-act="add-founder">Добавить</button>'))}
      ${summary.rows.length
        ? raw(html`<div class="list">${raw(summary.rows.map((row) => html`
          <a class="row" href="#/founders/${row.founder.id}">
            <div class="row__main">
              <span class="row__title">${row.founder.name}</span>
              <span class="row__subtitle">${row.founder.role || 'Коллега'}
                · всего взял ${money(row.totalBase)}${row.investedBase > 0 ? ` · вложил ${money(row.investedBase)}` : ''}</span>
            </div>
            <div class="row__side">
              <span class="row__amount">${money(row.periodBase)}</span>
              <span class="row__meta">${row.owedBase > 0
                ? `студия должна ${money(row.owedBase)}`
                : range.label.toLowerCase()}</span>
            </div>
          </a>`).join(''))}</div>`)
        : raw(emptyState('Коллеги не заведены. Добавьте владельцев студии, чтобы вести их выплаты.'))}
    </div>

    <p class="muted">«Вложил в студию» — учредитель внёс свои деньги в кассу или сам оплатил
      расход студии (аренду, мелкие расходы, технику). Оплаченный расход попадает в расходы
      студии, а студия становится должна учредителю эту сумму. Когда студия выйдет в прибыль,
      учредитель забирает вложенное — запишите «Забрал вложенное», и долг уменьшится.
      «Взял для себя» — деньги на личные расходы из прибыли: долг студии они не меняют.</p>`;

  return {
    title: 'Коллеги',
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
      root.querySelector('[data-act="add-invest"]')?.addEventListener('click', () => forms.openDrawForm('', null, refresh, 'invest'));
      root.querySelector('[data-act="add-repay"]')?.addEventListener('click', () => forms.openDrawForm(
        investors.find((row) => row.owedBase > 0)?.founder.id || '', null, refresh, 'repay'));
      root.querySelector('[data-act="add-draw"]')?.addEventListener('click', () => forms.openDrawForm('', null, refresh, 'draw'));
    },
  };
}

// ---------------------------------------------------------- карточка

export function founderDetail(params) {
  const state = getState();
  const founder = byId('founders', params.id);
  if (!founder) {
    return { title: 'Коллега', back: '#/founders', body: emptyState('Коллега не найден') };
  }
  const range = currentRange();
  const row = foundersSummary(state, range.from, range.to).rows
    .find((item) => item.founder.id === founder.id);

  const body = html`
    <div class="card">
      <h2>${founder.name}</h2>
      <p class="muted">${founder.role || 'Коллега'}</p>
      ${founder.note ? raw(html`<p class="muted">${founder.note}</p>`) : ''}
      <div class="btn-row">
        <button class="btn btn--sm" data-act="edit">Изменить</button>
        <button class="btn btn--sm btn--ghost" data-act="delete">Удалить</button>
        <button class="btn btn--sm btn--ghost" data-report>Отчёт PDF</button>
      </div>
    </div>

    <div class="stats">
      ${raw(statCard({
        label: 'Вложил в студию',
        value: money(row.investedBase),
        hint: row.periodInvestedBase > 0 ? `${range.label.toLowerCase()}: ${money(row.periodInvestedBase)}` : 'за всё время',
        tone: 'good',
      }))}
      ${raw(statCard({ label: 'Забрал вложенное', value: money(row.repaidBase), hint: 'за всё время' }))}
      ${raw(statCard({
        label: 'Студия должна сейчас',
        value: money(row.owedBase),
        hint: row.owedBase > 0 ? 'вернуть, когда студия выйдет в прибыль' : 'долга нет',
        tone: row.owedBase > 0 ? 'danger' : 'neutral',
      }))}
      ${raw(statCard({
        label: `Взял для себя · ${range.label}`,
        value: money(row.periodBase),
        hint: `за всё время ${money(row.takenBase)}`,
        tone: 'warn',
      }))}
    </div>

    <div class="btn-row">
      <button class="btn btn--primary" data-act="add-invest">Вложил</button>
      ${row.owedBase > 0 ? raw(html`<button class="btn" data-act="add-repay">Забрал вложенное</button>`) : ''}
      <button class="btn btn--ghost" data-act="add-draw">Взял для себя</button>
    </div>

    <div class="card">
      ${raw(sectionTitle('История операций'))}
      ${row.draws.length
        ? raw(html`<div class="list">${raw(row.draws.map((item) => html`
          <button class="row" data-open-draw="${item.id}" style="width:100%;text-align:left">
            <div class="row__main">
              <span class="row__title">${labelOf(FOUNDER_MOVES, item.kind || 'draw', 'Взял для себя')}</span>
              <span class="row__subtitle">${formatDate(item.date, { short: true })}${item.comment ? ` · ${item.comment}` : ''}</span>
            </div>
            <span class="row__amount ${raw(['spend', 'invest'].includes(item.kind || 'draw') ? 'good' : '')}">${raw(['spend', 'invest'].includes(item.kind || 'draw') ? '+' : '−')}${money(item.base)}</span>
          </button>`).join(''))}</div>`)
        : raw(emptyState('Операций ещё не было'))}
    </div>`;

  return {
    title: founder.name,
    subtitle: 'Коллега',
    back: '#/founders',
    body,
    mount(root) {
      // «Всё время» — отчёт без границ периода.
      root.querySelector('[data-report]').onclick = () => openReport(periodState.preset === 'all'
        ? { type: 'founder', id: founder.id }
        : { type: 'founder', id: founder.id, from: range.from, to: range.to });
      root.querySelector('[data-act="edit"]').onclick = () => forms.openFounderForm(founder.id, refresh);
      root.querySelector('[data-act="add-invest"]').onclick = () => forms.openDrawForm(founder.id, null, refresh, 'invest');
      root.querySelector('[data-act="add-repay"]')?.addEventListener('click', () => forms.openDrawForm(founder.id, null, refresh, 'repay'));
      root.querySelector('[data-act="add-draw"]').onclick = () => forms.openDrawForm(founder.id, null, refresh, 'draw');
      root.querySelectorAll('[data-open-draw]').forEach((button) => {
        button.onclick = () => openDrawSheet(button.dataset.openDraw);
      });
      root.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await confirmDialog(`Удалить коллегу «${founder.name}»? Записи «Взял для себя» и «Забрал вложенное» тоже удалятся.`);
        if (!ok) return;
        const result = actions.deleteFounder(founder.id);
        if (result?.ok === false) {
          toast(result.error, 'danger');
          return;
        }
        toast('Коллега удалён');
        leave('#/founders');
      };
    },
  };
}

export function openDrawSheet(id) {
  const draw = byId('draws', id);
  if (!draw) return;
  const founder = byId('founders', draw.founderId);

  const kind = draw.kind || 'draw';
  openSheet({
    title: labelOf(FOUNDER_MOVES, kind, 'Операция коллеги'),
    body: html`
      <p class="hero__value" style="color:var(--ink)">${money(draw.base)}</p>
      <p class="muted">${FOUNDER_MOVES.find((item) => item.id === kind)?.hint || ''}</p>
      <div class="list">
        <div class="row"><div class="row__main"><span class="row__subtitle">Коллега</span>
          <span class="row__title">${founder?.name || '—'}</span></div></div>
        ${kind === 'invest' ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">Как</span>
          <span class="row__title">${draw.investWay === 'cash' ? 'Деньгами в кассу студии' : 'Оплатил расход за студию'}</span></div></div>`) : ''}
        ${draw.expenseId ? raw(html`<div class="row"><div class="row__main"><span class="row__subtitle">На что</span>
          <span class="row__title">${categoryLabel(draw.category, getState().settings)}</span></div></div>`) : ''}
        <div class="row"><div class="row__main"><span class="row__subtitle">Дата</span>
          <span class="row__title">${formatDate(draw.date)}</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Чем</span>
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
        const ok = await confirmDialog(draw.expenseId
          ? 'Удалить запись? Связанный расход студии тоже удалится.'
          : 'Удалить запись?');
        if (!ok) return;
        const result = actions.deleteDraw(id);
        if (result?.ok === false) {
          toast(result.error, 'danger');
          return;
        }
        toast('Запись удалена');
        refresh();
      };
    },
  });
}
