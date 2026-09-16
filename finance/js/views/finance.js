// Финансы: приходы и расходы с поиском и фильтрами.

import {
  html, raw, money, emptyState, searchBar, chips, sectionTitle,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { periodTotals } from '../calc.js';
import { rangeFor, today, formatDate } from '../dates.js';
import {
  INCOME_TYPES, PAYMENT_METHODS, EXPENSE_GROUPS, categoryLabel, labelOf,
} from '../model.js';
import { openOperation } from '../operation.js';
import { formatAmount } from '../money.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';

const filters = {
  period: 'month',
  query: '',
  incomeType: 'all',
  expenseGroup: 'all',
  projectId: 'all',
};

const PERIODS = [
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: '3 месяца' },
  { value: 'half', label: '6 месяцев' },
  { value: 'year', label: 'Год' },
  { value: 'all', label: 'Всё время' },
];

function activeRange() {
  if (filters.period === 'all') return { from: '1970-01-01', to: '2999-12-31', label: 'Всё время' };
  return rangeFor(filters.period, today());
}

function matchesQuery(text, query) {
  return !query || String(text || '').toLowerCase().includes(query);
}

function incomeRows(state, range) {
  const query = filters.query.trim().toLowerCase();
  return state.incomes
    .filter((item) => item.date >= range.from && item.date <= range.to)
    .filter((item) => filters.incomeType === 'all' || item.type === filters.incomeType)
    .filter((item) => filters.projectId === 'all' || item.projectId === filters.projectId)
    .filter((item) => {
      if (!query) return true;
      const project = byId('projects', item.projectId);
      const client = byId('clients', item.clientId);
      return matchesQuery(item.comment, query)
        || matchesQuery(project?.name, query)
        || matchesQuery(client?.name, query);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function expenseRows(state, range) {
  const query = filters.query.trim().toLowerCase();
  return state.expenses
    .filter((item) => item.date >= range.from && item.date <= range.to)
    .filter((item) => filters.expenseGroup === 'all' || String(item.category).startsWith(`${filters.expenseGroup}/`))
    .filter((item) => filters.projectId === 'all' || item.projectId === filters.projectId)
    .filter((item) => {
      if (!query) return true;
      const project = byId('projects', item.projectId);
      return matchesQuery(item.comment, query)
        || matchesQuery(categoryLabel(item.category, state.settings), query)
        || matchesQuery(project?.name, query);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export default function finance(params) {
  const state = getState();
  const tab = params.tab === 'expense' ? 'expense' : 'income';
  const range = activeRange();
  const totals = periodTotals(state, range.from, range.to);
  const rows = tab === 'income' ? incomeRows(state, range) : expenseRows(state, range);
  const listTotal = rows.reduce((acc, item) => acc + (Number(item.base) || 0), 0);

  const projectChips = [
    { value: 'all', label: 'Все проекты' },
    ...state.projects.slice(0, 20).map((project) => ({ value: project.id, label: project.name })),
  ];

  const typeChips = tab === 'income'
    ? [{ value: 'all', label: 'Все типы' }, ...INCOME_TYPES.map((item) => ({ value: item.id, label: item.label }))]
    : [{ value: 'all', label: 'Все категории' }, ...EXPENSE_GROUPS.map((item) => ({ value: item.id, label: item.label }))];

  const list = rows.map((item) => {
    const project = byId('projects', item.projectId);
    const title = tab === 'income'
      ? (project?.name || byId('clients', item.clientId)?.name || labelOf(INCOME_TYPES, item.type, 'Доход'))
      : categoryLabel(item.category, state.settings);
    const subtitle = tab === 'income'
      ? `${labelOf(INCOME_TYPES, item.type)} · ${labelOf(PAYMENT_METHODS, item.method, 'Наличные')}${item.comment ? ` · ${item.comment}` : ''}`
      : `${project ? `${project.name} · ` : ''}${item.comment || labelOf(PAYMENT_METHODS, item.method, 'Наличные')}`;
    return html`
      <button class="row" data-open="${item.id}" style="width:100%;text-align:left">
        <div class="row__main">
          <span class="row__title">${title}</span>
          <span class="row__subtitle">${subtitle}</span>
        </div>
        <div class="row__side">
          <span class="row__amount ${raw(tab === 'income' ? 'good' : 'danger')}">
            ${raw(tab === 'income' ? '+' : '−')}${money(item.base)}</span>
          <span class="row__meta">${formatDate(item.date, { short: true, withYear: false })}</span>
          ${item.currency !== 'USD' ? raw(html`<span class="row__meta">${formatAmount(item.amount, item.currency)}</span>`) : ''}
        </div>
      </button>`;
  }).join('');

  const body = html`
    <div class="tabs">
      <a class="tabs__item ${raw(tab === 'income' ? 'is-active' : '')}" href="#/finance/income">Приход</a>
      <a class="tabs__item ${raw(tab === 'expense' ? 'is-active' : '')}" href="#/finance/expense">Расход</a>
    </div>

    <div class="stats">
      <div class="stat stat--good"><span class="stat__label">Доход за период</span><strong class="stat__value">${money(totals.incomeBase)}</strong></div>
      <div class="stat stat--danger"><span class="stat__label">Расход за период</span><strong class="stat__value">${money(totals.expenseBase)}</strong></div>
    </div>

    ${raw(chips(PERIODS, filters.period, 'period'))}
    ${raw(searchBar({ value: filters.query, placeholder: tab === 'income' ? 'Поиск по проекту, клиенту' : 'Поиск по категории, комментарию' }))}
    ${raw(chips(typeChips, tab === 'income' ? filters.incomeType : filters.expenseGroup, tab === 'income' ? 'incomeType' : 'expenseGroup'))}
    ${state.projects.length ? raw(chips(projectChips, filters.projectId, 'projectId')) : ''}

    <div class="card card--flat">
      ${raw(sectionTitle(`${rows.length} операций`, `<span class="muted">${money(listTotal)}</span>`))}
      ${rows.length ? raw(html`<div class="list">${raw(list)}</div>`) : raw(emptyState('Операций за этот период нет'))}
    </div>

    <button class="btn btn--primary btn--block" data-act="add">
      ${tab === 'income' ? 'Добавить приход' : 'Добавить расход'}
    </button>`;

  return {
    title: 'Финансы',
    subtitle: range.label,
    body,
    mount(root) {
      root.querySelector('[data-search]')?.addEventListener('input', (event) => {
        filters.query = event.target.value;
        refresh();
      });
      root.querySelectorAll('[data-chips]').forEach((group) => {
        group.addEventListener('click', (event) => {
          const chip = event.target.closest('.chip');
          if (!chip) return;
          filters[group.dataset.chips] = chip.dataset.value;
          refresh();
        });
      });
      root.querySelector('[data-act="add"]').onclick = () => (tab === 'income'
        ? forms.openIncomeForm({}, refresh)
        : forms.openExpenseForm({}, refresh));
      root.querySelectorAll('[data-open]').forEach((button) => {
        button.onclick = () => openOperation(tab, button.dataset.open);
      });
    },
  };
}
