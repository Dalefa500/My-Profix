// Взаиморасчёты: все случаи, когда клиент платит имуществом.
// Отсюда видно, сколько квартир и машин получено, сколько по ним уже
// отработано и сколько ещё осталось, и отсюда же списываются работы.

import { html, raw, money, emptyState, sectionTitle, statCard, progressBar } from '../ui.js';
import { getState, byId } from '../store.js';
import { barterTotals } from '../calc.js';
import { BARTER_KINDS, labelOf } from '../model.js';
import * as forms from '../forms.js';
import { refresh } from '../refresh.js';
import { openBarterSheet } from '../barter.js';

function barterRow(row) {
  const client = byId('clients', row.barter.clientId);
  return html`
    <button class="row" data-open-barter="${row.barter.id}" style="width:100%;text-align:left">
      <div class="row__main">
        <span class="row__title">${row.barter.title}</span>
        <span class="row__subtitle">${client?.name || 'Без клиента'} · ${labelOf(BARTER_KINDS, row.barter.kind, 'Имущество')}
          · оценка ${money(row.totalBase)}</span>
        ${raw(progressBar(row.percent, row.done ? 'good' : 'warn'))}
      </div>
      <div class="row__side">
        <span class="row__amount ${raw(row.done ? 'good' : 'warn')}">${money(row.leftBase)}</span>
        <span class="row__meta">${row.done ? 'отработано' : 'осталось'}</span>
      </div>
    </button>`;
}

export default function barters() {
  const state = getState();
  const totals = barterTotals(state);
  const open = totals.rows.filter((row) => !row.done).sort((a, b) => b.leftBase - a.leftBase);
  const done = totals.rows.filter((row) => row.done);

  const body = html`
    <div class="stats">
      ${raw(statCard({ label: 'Получено имуществом', value: money(totals.totalBase), hint: `${totals.rows.length} шт.` }))}
      ${raw(statCard({ label: 'Осталось отработать', value: money(totals.leftBase), tone: totals.leftBase > 0 ? 'warn' : 'good', hint: `отработано ${money(totals.usedBase)}` }))}
    </div>

    <div class="card">
      ${raw(sectionTitle('В работе', '<button class="btn btn--sm" data-act="add-barter">Добавить</button>'))}
      ${open.length ? raw(html`<div class="list">${raw(open.map(barterRow).join(''))}</div>`)
        : raw(emptyState('Нет имущества, по которому нужно отработать. Добавьте, если застройщик рассчитался квартирой или машиной.'))}
    </div>

    ${done.length ? raw(html`
      <div class="card card--flat">
        ${raw(sectionTitle('Отработано полностью'))}
        <div class="list">${raw(done.map(barterRow).join(''))}</div>
      </div>`) : ''}

    <p class="muted">Как это работает: записываете, что передал клиент и во сколько это оценили.
      Когда этап работ выполнен — откройте имущество и нажмите «Списать работы».
      Сумма уменьшает остаток и попадает в доход студии.</p>`;

  return {
    title: 'Взаиморасчёты',
    subtitle: open.length ? `${open.length} в работе` : '',
    back: '#/clients',
    body,
    mount(root) {
      root.querySelector('[data-act="add-barter"]').onclick = () => forms.openBarterForm(null, {}, refresh);
      root.querySelectorAll('[data-open-barter]').forEach((button) => {
        button.onclick = () => openBarterSheet(button.dataset.openBarter);
      });
    },
  };
}
