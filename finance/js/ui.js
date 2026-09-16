// Небольшой набор готовых элементов интерфейса: карточки, списки, формы,
// нижние панели. Цель — чтобы любое действие занимало минимум шагов
// (пункт 29 ТЗ), поэтому формы собираются из описаний полей,
// а всё необязательное прячется под «Дополнительно».

import { CURRENCY_LIST, formatAmount, defaultRate, toBase } from './money.js';
import { getState } from './store.js';
import { formatDate } from './dates.js';

// Мгновенное нажатие: действие выполняется по касанию, а не по отпусканию
// пальца — так же ведут себя родные приложения iPhone.
export function fastTap(element, handler) {
  if (!element) return;
  let handled = false;
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    handled = true;
    handler(event);
    setTimeout(() => { handled = false; }, 500);
  });
  element.addEventListener('click', (event) => {
    event.preventDefault();
    if (handled) return;
    handler(event);
  });
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Значение, которое уже является готовой разметкой.
export function raw(value) {
  return { __html: String(value ?? '') };
}

export function html(strings, ...values) {
  return strings.reduce((acc, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    let piece;
    if (value == null || value === false) piece = '';
    else if (value?.__html !== undefined) piece = value.__html;
    else if (Array.isArray(value)) {
      piece = value.map((item) => (item?.__html !== undefined ? item.__html : esc(item))).join('');
    } else piece = esc(value);
    return acc + piece + part;
  }, '');
}

export const money = (base, options) => formatAmount(base, 'TJS', options);

export function badge(label, tone = 'neutral') {
  return html`<span class="badge badge--${raw(tone)}">${label}</span>`;
}

export function statCard({ label, value, hint, tone = 'neutral', href }) {
  const inner = html`
    <span class="stat__label">${label}</span>
    <strong class="stat__value">${value}</strong>
    ${hint ? raw(html`<span class="stat__hint">${hint}</span>`) : ''}`;
  return href
    ? html`<a class="stat stat--${raw(tone)}" href="${href}">${raw(inner)}</a>`
    : html`<div class="stat stat--${raw(tone)}">${raw(inner)}</div>`;
}

export function emptyState(text, actionHtml = '') {
  return html`<div class="empty"><p>${text}</p>${raw(actionHtml)}</div>`;
}

export function rowItem({ title, subtitle, amount, amountTone = '', meta, href, badgeHtml, actions }) {
  const body = html`
    <div class="row__main">
      <span class="row__title">${title}</span>
      ${subtitle ? raw(html`<span class="row__subtitle">${subtitle}</span>`) : ''}
      ${badgeHtml ? raw(badgeHtml) : ''}
    </div>
    <div class="row__side">
      ${amount ? raw(html`<span class="row__amount ${raw(amountTone)}">${amount}</span>`) : ''}
      ${meta ? raw(html`<span class="row__meta">${meta}</span>`) : ''}
      ${actions ? raw(actions) : ''}
    </div>`;
  return href
    ? html`<a class="row" href="${href}">${raw(body)}</a>`
    : html`<div class="row">${raw(body)}</div>`;
}

export function sectionTitle(title, actionHtml = '') {
  return html`<div class="section-title"><h2>${title}</h2>${raw(actionHtml)}</div>`;
}

export function progressBar(percent, tone = 'good') {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return html`<div class="progress"><span class="progress__fill progress__fill--${raw(tone)}" style="width:${raw(value)}%"></span></div>`;
}

// --------------------------------------------------------------- всплывашки

let toastTimer = null;

export function toast(message, tone = 'info') {
  const host = document.getElementById('toast');
  if (!host) return;
  host.className = `toast toast--${tone} is-visible`;
  host.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('is-visible'), 3200);
}

function lockScroll(locked) {
  document.body.classList.toggle('is-locked', locked);
}

export function closeSheet() {
  const host = document.getElementById('sheet');
  if (!host) return;
  host.classList.remove('is-open');
  host.innerHTML = '';
  lockScroll(false);
}

// Универсальная нижняя панель (на телефоне выезжает снизу, на компьютере —
// это диалог по центру).
export function openSheet({ title, body, footer = '', onMount, size = '' }) {
  const host = document.getElementById('sheet');
  if (!host) return;
  host.innerHTML = html`
    <div class="sheet__backdrop" data-close="1"></div>
    <div class="sheet__panel ${raw(size ? `sheet__panel--${size}` : '')}" role="dialog" aria-modal="true">
      <div class="sheet__head">
        <h3>${title}</h3>
        <button class="icon-btn" data-close="1" aria-label="Закрыть">✕</button>
      </div>
      <div class="sheet__body">${raw(body)}</div>
      ${footer ? raw(html`<div class="sheet__foot">${raw(footer)}</div>`) : ''}
    </div>`;
  host.classList.add('is-open');
  lockScroll(true);
  host.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', () => closeSheet());
  });
  onMount?.(host.querySelector('.sheet__panel'));
}

export function confirmDialog(message, { confirmLabel = 'Удалить', tone = 'danger' } = {}) {
  return new Promise((resolve) => {
    openSheet({
      title: 'Подтвердите действие',
      body: html`<p class="confirm-text">${message}</p>`,
      footer: html`
        <button class="btn btn--ghost" data-act="cancel">Отмена</button>
        <button class="btn btn--${raw(tone)}" data-act="ok">${confirmLabel}</button>`,
      onMount: (panel) => {
        panel.querySelector('[data-act="cancel"]').addEventListener('click', () => {
          closeSheet();
          resolve(false);
        });
        panel.querySelector('[data-act="ok"]').addEventListener('click', () => {
          closeSheet();
          resolve(true);
        });
      },
    });
  });
}

// ------------------------------------------------------------------- формы

function fieldControl(field) {
  const id = `f_${field.name}`;
  const required = field.required ? 'required' : '';
  const value = field.value ?? '';
  switch (field.type) {
    case 'select':
      return html`<select id="${id}" name="${field.name}" ${raw(required)}>
        ${raw((field.options || []).map((option) => html`
          <option value="${option.value}" ${raw(String(option.value) === String(value) ? 'selected' : '')}>${option.label}</option>`).join(''))}
      </select>`;
    case 'textarea':
      return html`<textarea id="${id}" name="${field.name}" rows="3" placeholder="${field.placeholder || ''}">${value}</textarea>`;
    case 'date':
      return html`<input id="${id}" name="${field.name}" type="date" value="${value}" ${raw(required)}>`;
    case 'number':
      return html`<input id="${id}" name="${field.name}" type="number" inputmode="decimal" step="${field.step || 'any'}"
        min="${field.min ?? ''}" max="${field.max ?? ''}" value="${value}" placeholder="${field.placeholder || ''}" ${raw(required)}>`;
    case 'checkbox':
      return html`<label class="switch">
        <input id="${id}" name="${field.name}" type="checkbox" ${raw(field.value ? 'checked' : '')}>
        <span>${field.hint || ''}</span>
      </label>`;
    case 'segmented':
      return html`<div class="segmented" data-field="${field.name}">
        ${raw((field.options || []).map((option) => html`
          <button type="button" class="segmented__item ${raw(String(option.value) === String(value) ? 'is-active' : '')}"
            data-value="${option.value}">${option.label}</button>`).join(''))}
        <input type="hidden" name="${field.name}" value="${value}">
      </div>`;
    case 'money':
      return moneyControl(field);
    case 'password':
      return html`<input id="${id}" name="${field.name}" type="password" value="${value}"
        autocomplete="${field.autocomplete || 'current-password'}" ${raw(required)}>`;
    default:
      return html`<input id="${id}" name="${field.name}" type="text" value="${value}"
        placeholder="${field.placeholder || ''}" autocomplete="off" ${raw(required)}>`;
  }
}

// Денежное поле: сумма + валюта + курс. Курс запрашивается только тогда,
// когда валюта не базовая, и сохраняется вместе с операцией.
function moneyControl(field) {
  const settings = getState().settings;
  const currency = field.currency || settings.baseCurrency;
  const fx = field.fx ?? defaultRate(currency, settings);
  const suffix = field.suffix ? html`<span class="money-suffix">${field.suffix}</span>` : '';
  return html`<div class="money-field" data-money="${field.name}">
    <div class="money-field__row">
      <input name="${field.name}" type="number" inputmode="decimal" step="any" value="${field.value ?? ''}"
        placeholder="0" ${raw(field.required ? 'required' : '')}>
      ${raw(suffix)}
      <div class="segmented segmented--sm" data-field="${field.name}__currency">
        ${raw(CURRENCY_LIST.map((item) => html`
          <button type="button" class="segmented__item ${raw(item.code === currency ? 'is-active' : '')}"
            data-value="${item.code}">${item.code}</button>`).join(''))}
        <input type="hidden" name="${field.name}__currency" value="${currency}">
      </div>
    </div>
    <div class="money-field__fx ${raw(currency === settings.baseCurrency ? 'is-hidden' : '')}">
      <label>Курс 1 <span data-fx-code>${currency}</span> =</label>
      <input name="${field.name}__fx" type="number" inputmode="decimal" step="any" value="${fx}">
      <span>${settings.baseCurrency}</span>
      <span class="money-field__base" data-fx-base></span>
    </div>
  </div>`;
}

function fieldBlock(field) {
  if (field.type === 'hidden') {
    return html`<input type="hidden" name="${field.name}" value="${field.value ?? ''}">`;
  }
  return html`<div class="field ${raw(field.wide ? 'field--wide' : '')}" data-field-name="${field.name}">
    <label for="f_${field.name}">${field.label}</label>
    ${raw(fieldControl(field))}
    ${field.hint && field.type !== 'checkbox' ? raw(html`<span class="field__hint">${field.hint}</span>`) : ''}
  </div>`;
}

function collectValues(form) {
  const data = new FormData(form);
  const values = {};
  for (const [key, value] of data.entries()) values[key] = value;
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    values[input.name] = input.checked;
  }
  // Сводим поля «сумма/валюта/курс» в один объект.
  for (const node of form.querySelectorAll('[data-money]')) {
    const name = node.dataset.money;
    values[`${name}Currency`] = values[`${name}__currency`];
    values[`${name}Fx`] = Number(values[`${name}__fx`]) || 1;
    delete values[`${name}__currency`];
    delete values[`${name}__fx`];
  }
  return values;
}

// Основная форма приложения. Возвращает элемент панели.
export function openForm({
  title, fields = [], advanced = [], submitLabel = 'Сохранить', onSubmit,
  intro = '', extraHtml = '', size = '',
}) {
  const body = html`
    ${intro ? raw(html`<p class="form-intro">${intro}</p>`) : ''}
    <form class="form" novalidate>
      <div class="form__grid">${raw(fields.map(fieldBlock).join(''))}</div>
      ${advanced.length ? raw(html`
        <details class="form__advanced">
          <summary>Дополнительно</summary>
          <div class="form__grid">${raw(advanced.map(fieldBlock).join(''))}</div>
        </details>`) : ''}
      ${raw(extraHtml)}
      <div class="form__error" hidden></div>
    </form>`;

  openSheet({
    title,
    body,
    size,
    footer: html`
      <button class="btn btn--ghost" data-act="cancel" type="button">Отмена</button>
      <button class="btn btn--primary" data-act="submit" type="button">${submitLabel}</button>`,
    onMount: (panel) => {
      const form = panel.querySelector('form');
      bindSegmented(form);
      bindMoney(form);
      panel.querySelector('[data-act="cancel"]').addEventListener('click', () => closeSheet());
      const submit = panel.querySelector('[data-act="submit"]');
      const run = () => {
        const errorBox = form.querySelector('.form__error');
        errorBox.hidden = true;
        const missing = [...form.querySelectorAll('[required]')]
          .find((input) => !String(input.value).trim());
        if (missing) {
          errorBox.textContent = 'Заполните обязательные поля';
          errorBox.hidden = false;
          missing.focus();
          return;
        }
        const result = onSubmit?.(collectValues(form), { panel, form });
        if (result === false) return;
        if (result instanceof Promise) {
          result.then((ok) => { if (ok !== false) closeSheet(); });
          return;
        }
        closeSheet();
      };
      submit.addEventListener('click', run);
      form.addEventListener('submit', (event) => { event.preventDefault(); run(); });
      form.querySelector('input:not([type="hidden"]), select, textarea')?.focus();
    },
  });
}

export function bindSegmented(scope) {
  scope.querySelectorAll('.segmented').forEach((group) => {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('.segmented__item');
      if (!button) return;
      group.querySelectorAll('.segmented__item').forEach((item) => item.classList.remove('is-active'));
      button.classList.add('is-active');
      const input = group.querySelector('input[type="hidden"]');
      if (input) {
        input.value = button.dataset.value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

// Показывает курс и пересчёт в сомони, когда выбрана не базовая валюта.
export function bindMoney(scope) {
  const settings = getState().settings;
  scope.querySelectorAll('[data-money]').forEach((node) => {
    const name = node.dataset.money;
    const amountInput = node.querySelector(`input[name="${name}"]`);
    const currencyInput = node.querySelector(`input[name="${name}__currency"]`);
    const fxWrap = node.querySelector('.money-field__fx');
    const fxInput = node.querySelector(`input[name="${name}__fx"]`);
    const fxCode = node.querySelector('[data-fx-code]');
    const baseOut = node.querySelector('[data-fx-base]');

    // Курс относится к конкретной валюте. При переключении валюты
    // подставляем текущий курс компании, но у сохранённой операции
    // её исторический курс не трогаем.
    let fxOwner = currencyInput.value;
    fxInput?.addEventListener('input', () => { fxOwner = currencyInput.value; });

    const refresh = () => {
      const currency = currencyInput.value;
      const isBase = currency === settings.baseCurrency;
      fxWrap.classList.toggle('is-hidden', isBase);
      if (fxCode) fxCode.textContent = currency;
      if (!isBase && (fxOwner !== currency || !(Number(fxInput.value) > 0))) {
        fxInput.value = defaultRate(currency, settings);
        fxOwner = currency;
      }
      if (baseOut) {
        const base = toBase(Number(amountInput.value) || 0, currency, Number(fxInput.value) || 1);
        baseOut.textContent = isBase ? '' : `= ${formatAmount(base)}`;
      }
    };
    currencyInput.addEventListener('change', refresh);
    amountInput.addEventListener('input', refresh);
    fxInput?.addEventListener('input', refresh);
    refresh();
  });
}

// ------------------------------------------------------------------ фильтры

export function searchBar({ value = '', placeholder = 'Поиск' }) {
  return html`<div class="searchbar">
    <input type="search" data-search value="${value}" placeholder="${placeholder}" autocomplete="off">
  </div>`;
}

export function chips(items, activeValue, name = 'filter') {
  return html`<div class="chips" data-chips="${name}">
    ${raw(items.map((item) => html`
      <button type="button" class="chip ${raw(String(item.value) === String(activeValue) ? 'is-active' : '')}"
        data-value="${item.value}">${item.label}</button>`).join(''))}
  </div>`;
}

export function dateLine(iso) {
  return formatDate(iso, { short: true });
}
