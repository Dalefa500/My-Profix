// Клиенты: список с суммами договоров и задолженностью.

import { html, raw, money, emptyState, searchBar } from '../ui.js';
import { getState } from '../store.js';
import { clientFinance } from '../calc.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';

const filters = { query: '' };

export default function clients() {
  const state = getState();
  const query = filters.query.trim().toLowerCase();
  const visible = state.clients.filter((client) => !query
    || [client.name, client.phone, client.email].filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)));

  const rows = visible.map((client) => {
    const finance = clientFinance(state, client.id);
    return html`
      <a class="row" href="#/clients/${client.id}">
        <div class="row__main">
          <span class="row__title">${client.name}</span>
          <span class="row__subtitle">${finance.projects.length} проектов${client.phone ? ` · ${client.phone}` : ''}</span>
        </div>
        <div class="row__side">
          <span class="row__amount">${money(finance.contractBase)}</span>
          <span class="row__meta ${raw(finance.toReceiveBase > 0 ? 'danger-text' : 'good-text')}">
            ${finance.toReceiveBase > 0 ? `Долг ${money(finance.toReceiveBase)}` : 'Оплачено'}</span>
        </div>
      </a>`;
  }).join('');

  const body = html`
    ${raw(searchBar({ value: filters.query, placeholder: 'Поиск клиента' }))}
    <div class="card card--flat">
      ${visible.length ? raw(html`<div class="list">${raw(rows)}</div>`)
        : raw(emptyState('Клиентов не найдено', '<button class="btn btn--primary btn--sm" data-act="add">Добавить клиента</button>'))}
    </div>
    ${visible.length ? raw(html`<button class="btn btn--primary btn--block" data-act="add">Добавить клиента</button>`) : ''}`;

  return {
    title: 'Клиенты',
    subtitle: `${state.clients.length} всего`,
    back: '#/',
    body,
    mount(root) {
      root.querySelector('[data-search]')?.addEventListener('input', (event) => {
        filters.query = event.target.value;
        refresh();
      });
      root.querySelector('[data-act="add"]').onclick = () => forms.openClientForm(null, refresh);
    },
  };
}
