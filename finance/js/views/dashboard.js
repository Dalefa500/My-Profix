// Главный экран. Задача — за 10–20 секунд показать состояние компании.

import { html, raw, statCard, sectionTitle, rowItem, emptyState, money, openForm, toast } from '../ui.js';
import { getState, byId } from '../store.js';
import * as store from '../store.js';
import { dashboardTotals, notifications } from '../calc.js';
import { rangeFor, today, formatDate, monthLabel, monthKey } from '../dates.js';
import { categoryLabel } from '../model.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';
import { go } from '../router.js';
import { quickAction } from '../icons.js';
import { formatUsdRate } from '../money.js';

const PERIODS = [
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'half', label: '6 месяцев' },
  { value: 'year', label: 'Год' },
  { value: 'custom', label: 'Период' },
];

// Выбранный период переживает перерисовку экрана.
const periodState = { preset: 'month', from: null, to: null };

export function currentRange() {
  if (periodState.preset === 'custom' && periodState.from && periodState.to) {
    return { from: periodState.from, to: periodState.to, label: `${formatDate(periodState.from, { short: true })} — ${formatDate(periodState.to, { short: true })}` };
  }
  const range = rangeFor(periodState.preset, today());
  if (periodState.preset === 'month') range.label = monthLabel(monthKey(today()));
  return range;
}

function recentOperations(state, limit = 8) {
  const incomes = state.incomes.map((item) => ({
    kind: 'income',
    id: item.id,
    date: item.date,
    title: byId('projects', item.projectId)?.name || byId('clients', item.clientId)?.name || 'Прочий доход',
    subtitle: item.comment || '',
    base: item.base,
  }));
  const expenses = state.expenses.map((item) => ({
    kind: 'expense',
    id: item.id,
    date: item.date,
    title: categoryLabel(item.category, state.settings),
    subtitle: item.comment || byId('projects', item.projectId)?.name || '',
    base: item.base,
  }));
  return [...incomes, ...expenses]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)))
    .slice(0, limit);
}

function openCustomPeriod() {
  const range = currentRange();
  openForm({
    title: 'Произвольный период',
    fields: [
      { name: 'from', label: 'С какой даты', type: 'date', required: true, value: range.from },
      { name: 'to', label: 'По какую дату', type: 'date', required: true, value: range.to },
    ],
    submitLabel: 'Показать',
    onSubmit: (values) => {
      if (values.from > values.to) {
        toast('Начало периода позже конца', 'danger');
        return false;
      }
      periodState.preset = 'custom';
      periodState.from = values.from;
      periodState.to = values.to;
      refresh();
      return true;
    },
  });
}

export default function dashboard() {
  const state = getState();
  const range = currentRange();
  const totals = dashboardTotals(state, range.from, range.to);
  const alerts = notifications(state).filter((item) => item.tone === 'danger').slice(0, 2);
  const recent = recentOperations(state);

  const body = html`
    <div class="chips" data-period>
      ${raw(PERIODS.map((item) => html`
        <button type="button" class="chip ${raw(item.value === periodState.preset ? 'is-active' : '')}"
          data-value="${item.value}">${item.label}</button>`).join(''))}
    </div>

    <!-- Курс на виду: по нему пересчитываются все суммы, введённые в сомони. -->
    <div class="rate-bar" data-act="rate">
      <span class="rate-bar__label">Курс НБТ</span>
      <b class="rate-bar__value">${formatUsdRate(state.settings.usdRate)}</b>
      <span class="rate-bar__note">${state.settings.usdRateDate
        ? `на ${formatDate(state.settings.usdRateDate, { short: true })}`
        : 'введён вручную'}</span>
    </div>

    <div class="hero">
      <span class="hero__label">Прибыль · ${range.label}</span>
      <div class="hero__value">${money(totals.profitBase)}</div>
      <div class="hero__row">
        <span class="hero__cell">Доход<b>${money(totals.incomeBase)}</b></span>
        <span class="hero__cell">Расход<b>${money(totals.expenseBase)}</b></span>
      </div>
    </div>

    <div class="stats">
      ${raw(statCard({
        label: 'Ожидается получить',
        value: money(totals.toReceiveBase),
        hint: 'Долг клиентов',
        tone: 'good',
        href: '#/payments/get',
      }))}
      ${raw(statCard({
        label: 'Ожидается выплатить',
        value: money(totals.toPayBase),
        hint: totals.lockedPayBase > 0 ? `Ещё ${money(totals.lockedPayBase)} после согласования` : 'Готово к выплате',
        tone: 'warn',
        href: '#/payments/pay',
      }))}
    </div>

    ${alerts.length ? raw(html`
      <div class="card card--flat">
        ${raw(sectionTitle('Требует внимания'))}
        <div class="list">
          ${raw(alerts.map((item) => rowItem({
            title: item.title,
            subtitle: item.text,
            amount: item.amountBase ? money(item.amountBase) : '',
            amountTone: 'danger',
            href: item.href,
          })).join(''))}
        </div>
      </div>`) : ''}

    <div class="quick">
      ${raw(quickAction({ act: 'income', icon: 'income', label: 'Добавить приход', tone: 'good', index: 0 }))}
      ${raw(quickAction({ act: 'expense', icon: 'expense', label: 'Добавить расход', tone: 'danger', index: 1 }))}
      ${raw(quickAction({ act: 'project', icon: 'project', label: 'Создать проект', index: 2 }))}
      ${raw(quickAction({ act: 'employee', icon: 'employee', label: 'Добавить сотрудника', index: 3 }))}
    </div>

    <div class="card card--flat">
      ${raw(sectionTitle('Последние операции', '<a href="#/finance">Все</a>'))}
      ${recent.length ? raw(html`<div class="list">${raw(recent.map((item) => rowItem({
        title: item.title,
        subtitle: item.subtitle,
        amount: `${item.kind === 'income' ? '+' : '−'}${money(item.base)}`,
        amountTone: item.kind === 'income' ? 'good' : 'danger',
        meta: formatDate(item.date, { short: true, withYear: false }),
      })).join(''))}</div>`)
      : raw(emptyState('Операций пока нет. Начните с прихода или расхода.'))}
    </div>`;

  return {
    title: 'Главная',
    subtitle: '',
    body,
    mount(root) {
      root.querySelector('[data-period]').addEventListener('click', (event) => {
        const button = event.target.closest('.chip');
        if (!button) return;
        if (button.dataset.value === 'custom') {
          openCustomPeriod();
          return;
        }
        periodState.preset = button.dataset.value;
        refresh();
      });
      // Нажатие на строку курса просит сервер сходить на сайт НБТ за свежим.
      root.querySelector('[data-act="rate"]').onclick = async (event) => {
        const bar = event.currentTarget;
        if (bar.dataset.busy) return;
        bar.dataset.busy = '1';
        bar.classList.add('is-busy');
        const result = await store.refreshUsdRate();
        delete bar.dataset.busy;
        bar.classList.remove('is-busy');
        if (!result.ok) toast(result.error || 'Сайт НБТ не ответил', 'danger');
        refresh();
      };
      root.querySelector('[data-act="income"]').onclick = () => forms.openIncomeForm({}, refresh);
      root.querySelector('[data-act="expense"]').onclick = () => forms.openExpenseForm({}, refresh);
      root.querySelector('[data-act="project"]').onclick = () => forms.openProjectForm(null, (project) => {
        go(`#/projects/${project.id}`);
      });
      root.querySelector('[data-act="employee"]').onclick = () => forms.openEmployeeForm(null, refresh);
    },
  };
}
