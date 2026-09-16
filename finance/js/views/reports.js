// Отчёты за месяц, 3 и 6 месяцев, год и произвольный период.

import { html, raw, money, sectionTitle, emptyState, openForm, toast } from '../ui.js';
import { formatPlain } from '../money.js';
import { getState } from '../store.js';
import { periodTotals, monthlySeries, yearSummary } from '../calc.js';
import { monthlyChart, breakdownBars } from '../charts.js';
import {
  today, monthKey, monthLabel, lastMonthKeys, monthKeysBetween, rangeFor, formatDate, parse,
} from '../dates.js';
import { categoryLabel, categoryGroupLabel, INCOME_TYPES, labelOf } from '../model.js';
import { refresh } from '../refresh.js';
import { openReport } from '../report.js';

const PERIODS = [
  { value: 'month', label: 'Месяц', months: 1 },
  { value: 'quarter', label: '3 месяца', months: 3 },
  { value: 'half', label: '6 месяцев', months: 6 },
  { value: 'calendarYear', label: 'Год', months: 12 },
  { value: 'custom', label: 'Период', months: 0 },
];

const reportState = { preset: 'month', from: null, to: null };

function activeRange() {
  if (reportState.preset === 'custom' && reportState.from && reportState.to) {
    return {
      from: reportState.from,
      to: reportState.to,
      label: `${formatDate(reportState.from, { short: true })} — ${formatDate(reportState.to, { short: true })}`,
    };
  }
  const range = rangeFor(reportState.preset, today());
  if (reportState.preset === 'month') range.label = monthLabel(monthKey(today()));
  return range;
}

function monthKeysFor(range) {
  return monthKeysBetween(monthKey(range.from), monthKey(range.to));
}

function expenseBreakdown(totals, settings) {
  return [...totals.expenseByCategory.entries()]
    .map(([category, value]) => ({
      label: `${categoryGroupLabel(category, settings)} · ${categoryLabel(category, settings)}`,
      value,
    }))
    .sort((a, b) => b.value - a.value);
}

function incomeBreakdown(totals) {
  return [...totals.incomeByType.entries()]
    .map(([type, value]) => ({ label: labelOf(INCOME_TYPES, type, 'Прочий доход'), value }))
    .sort((a, b) => b.value - a.value);
}

function monthsTable(series) {
  const total = series.reduce((acc, row) => ({
    income: acc.income + row.incomeBase,
    expense: acc.expense + row.expenseBase,
    profit: acc.profit + row.profitBase,
  }), { income: 0, expense: 0, profit: 0 });

  return html`
    <p class="table-caption">Суммы в долларах (USD)</p>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>Месяц</th><th>Доход</th><th>Расход</th><th>Прибыль</th></tr>
        </thead>
        <tbody>
          ${raw(series.map((row) => html`
            <tr>
              <td>${monthLabel(row.key)}</td>
              <td>${formatPlain(row.incomeBase)}</td>
              <td>${formatPlain(row.expenseBase)}</td>
              <td class="${raw(row.profitBase >= 0 ? 'good' : 'danger')}">${formatPlain(row.profitBase)}</td>
            </tr>`).join(''))}
        </tbody>
        <tfoot>
          <tr>
            <td>Итого</td>
            <td>${formatPlain(total.income)}</td>
            <td>${formatPlain(total.expense)}</td>
            <td class="${raw(total.profit >= 0 ? 'good' : 'danger')}">${formatPlain(total.profit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

function yearBlock(state) {
  const year = parse(today()).getFullYear();
  const summary = yearSummary(state, year);
  return html`
    <div class="card">
      ${raw(sectionTitle(`Итоги ${year} года`))}
      <div class="stats">
        <div class="stat"><span class="stat__label">Проектов начато</span><strong class="stat__value">${summary.projectCount}</strong></div>
        <div class="stat"><span class="stat__label">Средний доход с проекта</span><strong class="stat__value">${money(summary.avgIncomePerProject)}</strong></div>
        <div class="stat"><span class="stat__label">Расходы на сотрудников</span><strong class="stat__value">${money(summary.staffBase)}</strong></div>
        <div class="stat"><span class="stat__label">Постоянные расходы</span><strong class="stat__value">${money(summary.fixedCostsBase)}</strong>
          <span class="stat__hint">Офис и налоги</span></div>
      </div>
      ${raw(sectionTitle('Самые прибыльные проекты'))}
      ${summary.topProjects.length ? raw(html`<div class="list">${raw(summary.topProjects.map((item) => html`
        <a class="row" href="#/projects/${item.project.id}">
          <div class="row__main">
            <span class="row__title">${item.project.name}</span>
            <span class="row__subtitle">Доход ${money(item.contractBase)} · расходы ${money(item.costPlanBase)}</span>
          </div>
          <span class="row__amount ${raw(item.profitPlanBase >= 0 ? 'good' : 'danger')}">${money(item.profitPlanBase)}</span>
        </a>`).join(''))}</div>`) : raw(emptyState('Пока нет проектов с рассчитанной прибылью'))}
    </div>`;
}

function openCustomPeriod() {
  const range = activeRange();
  openForm({
    title: 'Произвольный период',
    fields: [
      { name: 'from', label: 'С какой даты', type: 'date', required: true, value: range.from },
      { name: 'to', label: 'По какую дату', type: 'date', required: true, value: range.to },
    ],
    submitLabel: 'Построить отчёт',
    onSubmit: (values) => {
      if (values.from > values.to) {
        toast('Начало периода позже конца', 'danger');
        return false;
      }
      reportState.preset = 'custom';
      reportState.from = values.from;
      reportState.to = values.to;
      refresh();
      return true;
    },
  });
}

export default function reports() {
  const state = getState();
  const range = activeRange();
  const totals = periodTotals(state, range.from, range.to);
  const keys = monthKeysFor(range);
  const series = monthlySeries(state, keys.length ? keys : lastMonthKeys(today(), 1));
  const expenses = expenseBreakdown(totals, state.settings);
  const incomes = incomeBreakdown(totals);
  const isYear = reportState.preset === 'calendarYear';

  const body = html`
    <div class="chips" data-period>
      ${raw(PERIODS.map((item) => html`
        <button type="button" class="chip ${raw(item.value === reportState.preset ? 'is-active' : '')}"
          data-value="${item.value}">${item.label}</button>`).join(''))}
    </div>

    <button class="btn btn--block btn--ghost" data-report>Скачать отчёт за период в PDF</button>

    <div class="hero">
      <span class="hero__label">Прибыль · ${range.label}</span>
      <div class="hero__value">${money(totals.profitBase)}</div>
      <div class="hero__row">
        <span class="hero__cell">Доход<b>${money(totals.incomeBase)}</b></span>
        <span class="hero__cell">Расход<b>${money(totals.expenseBase)}</b></span>
      </div>
    </div>

    ${series.length > 1 ? raw(html`
      <div class="card">
        ${raw(sectionTitle('Доход, расход и прибыль по месяцам'))}
        ${raw(monthlyChart(series))}
      </div>`) : ''}

    <div class="card">
      ${raw(sectionTitle('Помесячно'))}
      ${raw(monthsTable(series))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Структура расходов'))}
      ${raw(breakdownBars(expenses, { total: totals.expenseBase }))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Структура доходов'))}
      ${raw(breakdownBars(incomes, { total: totals.incomeBase }))}
    </div>

    ${isYear ? raw(yearBlock(state)) : ''}`;

  return {
    title: 'Отчёты',
    subtitle: range.label,
    body,
    mount(root) {
      root.querySelector('[data-period]').addEventListener('click', (event) => {
        const button = event.target.closest('.chip');
        if (!button) return;
        if (button.dataset.value === 'custom') {
          openCustomPeriod();
          return;
        }
        reportState.preset = button.dataset.value;
        refresh();
      });
      root.querySelector('[data-report]').onclick = () => openReport({
        type: 'period', from: range.from, to: range.to,
      });
    },
  };
}
