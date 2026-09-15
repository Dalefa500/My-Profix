// Список проектов с поиском и фильтрами.

import { html, raw, emptyState, money, searchBar, chips, badge, progressBar } from '../ui.js';
import { getState, byId } from '../store.js';
import { projectFinance } from '../calc.js';
import { PROJECT_STATUSES, labelOf, toneOf } from '../model.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';

const filters = { query: '', status: 'all', client: 'all' };

export default function projects() {
  const state = getState();

  const statusChips = [
    { value: 'all', label: 'Все' },
    { value: 'active', label: 'В работе' },
    ...PROJECT_STATUSES.map((item) => ({ value: item.id, label: item.label })),
  ];

  const query = filters.query.trim().toLowerCase();
  const visible = state.projects.filter((project) => {
    if (filters.status === 'active' && ['done', 'cancelled'].includes(project.status)) return false;
    if (!['all', 'active'].includes(filters.status) && project.status !== filters.status) return false;
    if (filters.client !== 'all' && project.clientId !== filters.client) return false;
    if (!query) return true;
    const client = byId('clients', project.clientId);
    return [project.name, project.address, project.objectType, client?.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  const rows = visible.map((project) => {
    const finance = projectFinance(state, project);
    const client = byId('clients', project.clientId);
    const percent = finance.contractBase > 0 ? finance.receivedBase / finance.contractBase * 100 : 0;
    return html`
      <a class="row" href="#/projects/${project.id}">
        <div class="row__main">
          <span class="row__title">${project.name}</span>
          <span class="row__subtitle">${client?.name || 'Без клиента'}${project.area ? ` · ${project.area} м²` : ''}</span>
          ${raw(badge(labelOf(PROJECT_STATUSES, project.status), toneOf(PROJECT_STATUSES, project.status)))}
          ${raw(progressBar(percent, percent >= 99.5 ? 'good' : 'warn'))}
        </div>
        <div class="row__side">
          <span class="row__amount">${money(finance.contractBase)}</span>
          <span class="row__meta">Получено ${money(finance.receivedBase)}</span>
          <span class="row__meta ${raw(finance.profitPlanBase >= 0 ? 'good-text' : 'danger-text')}">Прибыль ${money(finance.profitPlanBase)}</span>
        </div>
      </a>`;
  }).join('');

  const clientChips = [
    { value: 'all', label: 'Все клиенты' },
    ...state.clients.map((client) => ({ value: client.id, label: client.name })),
  ];

  const body = html`
    ${raw(searchBar({ value: filters.query, placeholder: 'Поиск по проекту, адресу, клиенту' }))}
    ${raw(chips(statusChips, filters.status, 'status'))}
    ${state.clients.length > 1 ? raw(chips(clientChips, filters.client, 'client')) : ''}
    <div class="card card--flat">
      ${visible.length
        ? raw(html`<div class="list">${raw(rows)}</div>`)
        : raw(emptyState('Проектов не найдено', '<button class="btn btn--primary btn--sm" data-act="add">Создать проект</button>'))}
    </div>
    <button class="btn btn--primary btn--block" data-act="add">Создать проект</button>`;

  return {
    title: 'Проекты',
    subtitle: `${visible.length} из ${state.projects.length}`,
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
      root.querySelectorAll('[data-act="add"]').forEach((button) => {
        button.onclick = () => forms.openProjectForm(null, (project) => {
          window.location.hash = `#/projects/${project.id}`;
        });
      });
    },
  };
}
