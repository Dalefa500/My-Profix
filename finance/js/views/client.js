// Карточка клиента: проекты и расчёты по ним.

import {
  html, raw, money, emptyState, sectionTitle, badge, confirmDialog, toast,
} from '../ui.js';
import { getState, byId } from '../store.js';
import { clientFinance, projectFinance } from '../calc.js';
import { PROJECT_STATUSES, labelOf, toneOf } from '../model.js';
import { formatDate } from '../dates.js';
import * as forms from '../forms.js';
import * as actions from '../actions.js';
import { refresh } from '../refresh.js';
import { go } from '../router.js';
import { openReport } from '../report.js';

export default function clientDetail(params) {
  const state = getState();
  const client = byId('clients', params.id);
  if (!client) {
    return { title: 'Клиент', back: '#/clients', body: emptyState('Клиент не найден') };
  }
  const finance = clientFinance(state, client.id);
  const payments = state.incomes
    .filter((item) => item.clientId === client.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 10);

  const body = html`
    <div class="card">
      <div class="section-title"><h2>${client.name}</h2></div>
      ${client.phone ? raw(html`<p class="muted"><a href="tel:${client.phone}">${client.phone}</a></p>`) : ''}
      ${client.email ? raw(html`<p class="muted">${client.email}</p>`) : ''}
      ${client.note ? raw(html`<p class="muted">${client.note}</p>`) : ''}
      <div class="btn-row">
        <button class="btn btn--sm" data-act="edit">Изменить</button>
        <button class="btn btn--sm btn--ghost" data-act="delete">Удалить</button>
        <button class="btn btn--sm btn--ghost" data-report>Отчёт PDF</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><span class="stat__label">Сумма договоров</span><strong class="stat__value">${money(finance.contractBase)}</strong></div>
      <div class="stat stat--good"><span class="stat__label">Получено</span><strong class="stat__value">${money(finance.receivedBase)}</strong></div>
      <div class="stat stat--warn"><span class="stat__label">Осталось получить</span><strong class="stat__value">${money(finance.toReceiveBase)}</strong></div>
    </div>

    <div class="card card--flat">
      ${raw(sectionTitle('Проекты клиента', '<button class="btn btn--sm" data-act="add-project">Новый проект</button>'))}
      ${finance.projects.length ? raw(html`<div class="list">${raw(finance.projects.map((project) => {
        const info = projectFinance(state, project);
        return html`
          <a class="row" href="#/projects/${project.id}">
            <div class="row__main">
              <span class="row__title">${project.name}</span>
              <span class="row__subtitle">${project.area ? `${project.area} м² · ` : ''}${formatDate(project.startDate, { short: true })}</span>
              ${raw(badge(labelOf(PROJECT_STATUSES, project.status), toneOf(PROJECT_STATUSES, project.status)))}
            </div>
            <div class="row__side">
              <span class="row__amount">${money(info.contractBase)}</span>
              <span class="row__meta">Долг ${money(info.toReceiveBase)}</span>
            </div>
          </a>`;
      }).join(''))}</div>`) : raw(emptyState('У клиента ещё нет проектов'))}
    </div>

    <div class="card card--flat">
      ${raw(sectionTitle('Платежи клиента'))}
      ${payments.length ? raw(html`<div class="list">${raw(payments.map((item) => html`
        <div class="row">
          <div class="row__main">
            <span class="row__title">${byId('projects', item.projectId)?.name || 'Без проекта'}</span>
            <span class="row__subtitle">${formatDate(item.date, { short: true })}${item.comment ? ` · ${item.comment}` : ''}</span>
          </div>
          <span class="row__amount good">+${money(item.base)}</span>
        </div>`).join(''))}</div>`) : raw(emptyState('Платежей ещё не было'))}
    </div>`;

  return {
    title: client.name,
    subtitle: 'Клиент',
    back: '#/clients',
    body,
    mount(root) {
      root.querySelector('[data-report]').onclick = () => openReport({ type: 'client', id: client.id });
      root.querySelector('[data-act="edit"]').onclick = () => forms.openClientForm(client.id, refresh);
      root.querySelector('[data-act="add-project"]').onclick = () => forms.openProjectForm(null, (project) => {
        go(`#/projects/${project.id}`);
      });
      root.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await confirmDialog(`Удалить клиента «${client.name}»? Проекты и платежи останутся, но потеряют привязку.`);
        if (!ok) return;
        actions.deleteClient(client.id);
        toast('Клиент удалён');
        go('#/clients');
      };
    },
  };
}
