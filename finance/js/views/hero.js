// Итог периода — большая карточка на Главной и в Отчётах.
//
// Прибыль = доходы минус расходы студии. Деньги, которые коллеги взяли
// себе, расходом не считаются, но из общей суммы уходят. Поэтому главная
// цифра — «Осталось в студии»: прибыль минус то, что забрали коллеги.
// Если за период никто ничего не брал, это просто прибыль.

import { html, raw, money } from '../ui.js';

export function heroBlock(totals, label) {
  const took = totals.drawBase > 0;
  const invested = totals.investBase > 0;
  const showLeft = took || invested;
  return html`
    <div class="hero">
      <span class="hero__label">${showLeft ? 'Осталось в студии' : 'Прибыль'} · ${label}</span>
      <div class="hero__value">${money(showLeft ? totals.leftBase : totals.profitBase)}</div>
      <div class="hero__row">
        <span class="hero__cell">Доход<b>${money(totals.incomeBase)}</b></span>
        <span class="hero__cell">Расход<b>${totals.expenseBase > 0 ? '−' : ''}${money(totals.expenseBase)}</b></span>
        ${took ? raw(html`<a class="hero__cell" href="#/founders">Коллеги взяли<b>−${money(totals.drawBase)}</b></a>`) : ''}
        ${invested ? raw(html`<a class="hero__cell" href="#/founders">Вложили<b>+${money(totals.investBase)}</b></a>`) : ''}
      </div>
      ${showLeft ? raw(html`<p class="hero__note">Прибыль ${money(totals.profitBase)}${took ? `, коллеги взяли ${money(totals.drawBase)}` : ''}${invested ? `, учредители вложили ${money(totals.investBase)}` : ''}</p>`) : ''}
      ${totals.incomeBarterBase > 0 ? raw(html`
        <p class="hero__note">Из дохода ${money(totals.incomeBarterBase)} — взаимозачётом,
          деньгами пришло ${money(totals.incomeCashBase)}</p>`) : ''}
    </div>`;
}
