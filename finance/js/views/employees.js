// Сотрудники: штатные (зарплата) и сдельные (оплата от площади).

import { html, raw, money, emptyState, searchBar, chips, badge } from '../ui.js';
import { getState } from '../store.js';
import { employeeFinance } from '../calc.js';
import { formatRate, formatAmount } from '../money.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';

const filters = { query: '', type: 'all' };

export default function employees() {
  const state = getState();
  const query = filters.query.trim().toLowerCase();

  const visible = state.employees.filter((employee) => {
    if (filters.type !== 'all' && employee.payType !== filters.type) return false;
    if (!query) return true;
    return [employee.name, employee.position].filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  const totals = visible.reduce((acc, employee) => {
    const finance = employeeFinance(state, employee);
    acc.due += finance.dueNowBase;
    acc.locked += finance.lockedBase;
    return acc;
  }, { due: 0, locked: 0 });

  const rows = visible.map((employee) => {
    const finance = employeeFinance(state, employee);
    const payLabel = employee.payType === 'fixed'
      ? `${formatAmount(employee.salary, employee.salaryCurrency)} / месяц`
      : formatRate(employee.rate, employee.rateCurrency);
    return html`
      <a class="row" href="#/employees/${employee.id}">
        <div class="row__main">
          <span class="row__title">${employee.name}</span>
          <span class="row__subtitle">${employee.position || (employee.payType === 'fixed' ? 'Штатный' : 'Сдельный')} · ${payLabel}</span>
          ${raw(employee.active === false ? badge('Не работает', 'muted') : '')}
        </div>
        <div class="row__side">
          <span class="row__amount ${raw(finance.dueNowBase > 0 ? 'danger' : '')}">${money(finance.dueNowBase)}</span>
          <span class="row__meta">к выплате</span>
        </div>
      </a>`;
  }).join('');

  const body = html`
    ${raw(searchBar({ value: filters.query, placeholder: 'Поиск сотрудника' }))}
    ${raw(chips([
      { value: 'all', label: 'Все' },
      { value: 'fixed', label: 'Зарплата' },
      { value: 'piecework', label: 'Сдельные' },
    ], filters.type, 'type'))}

    <div class="stats">
      <div class="stat stat--warn"><span class="stat__label">К выплате сейчас</span><strong class="stat__value">${money(totals.due)}</strong></div>
      <div class="stat"><span class="stat__label">Ждёт согласования</span><strong class="stat__value">${money(totals.locked)}</strong>
        <span class="stat__hint">Остатки до одобрения клиентом</span></div>
    </div>

    <div class="card card--flat">
      ${visible.length
        ? raw(html`<div class="list">${raw(rows)}</div>`)
        : raw(emptyState('Сотрудников не найдено', '<button class="btn btn--primary btn--sm" data-act="add">Добавить сотрудника</button>'))}
    </div>
    ${visible.length ? raw(html`<button class="btn btn--primary btn--block" data-act="add">Добавить сотрудника</button>`) : ''}`;

  return {
    title: 'Сотрудники',
    subtitle: `${visible.length} из ${state.employees.length}`,
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
      root.querySelector('[data-act="add"]').onclick = () => forms.openEmployeeForm(null, refresh);
    },
  };
}
