// Настройки: валюта и курс, правила расчёта, категории, учётная запись.

import {
  html, raw, sectionTitle, openForm, toast, confirmDialog, emptyState,
} from '../ui.js';
import * as store from '../store.js';
import * as actions from '../actions.js';
import { expenseGroups, SYSTEM_CATEGORIES, categoryLabel } from '../model.js';
import { formatAmount } from '../money.js';
import { formatDate } from '../dates.js';
import { THEMES, getTheme, setTheme } from '../theme.js';
import * as passkey from '../passkey.js';
import { refresh } from '../refresh.js';

function openCompanyForm(settings) {
  openForm({
    title: 'Компания и расчёты',
    fields: [
      { name: 'companyName', label: 'Название студии', type: 'text', value: settings.companyName, wide: true },
      {
        name: 'usdRate', label: 'Курс доллара, TJS за $1', type: 'number', step: '0.01',
        value: settings.rates.USD,
        hint: 'Применяется к новым операциям. Старые сохраняют свой курс.',
      },
      {
        name: 'defaultAdvancePercent', label: 'Аванс по умолчанию, %', type: 'number', min: 0, max: 100,
        value: settings.defaultAdvancePercent,
      },
      { name: 'salaryDay', label: 'День выплаты зарплаты', type: 'number', min: 1, max: 28, value: settings.salaryDay },
      {
        name: 'notifyDaysAhead', label: 'Напоминать за, дней', type: 'number', min: 1, max: 60,
        value: settings.notifyDaysAhead,
      },
    ],
    onSubmit: (values) => {
      actions.saveSettings(values);
      toast('Настройки сохранены', 'good');
      refresh();
    },
  });
}

function openCategoryForm() {
  const groups = expenseGroups(store.getState().settings);
  openForm({
    title: 'Новая категория расходов',
    fields: [
      {
        name: 'group', label: 'Раздел', type: 'select',
        options: groups.map((group) => ({ value: group.id, label: group.label })),
        value: 'other',
      },
      { name: 'label', label: 'Название категории', type: 'text', required: true },
    ],
    onSubmit: (values) => {
      actions.addCategory(values.group, values.label);
      toast('Категория добавлена', 'good');
      refresh();
    },
  });
}

function openNameForm(user) {
  openForm({
    title: 'Как вас подписывать',
    intro: store.isAuthDisabled()
      ? 'Имя хранится в этом браузере и подставляется в операции, которые вы вносите.'
      : '',
    fields: [{ name: 'name', label: 'Имя', type: 'text', required: true, value: user?.name || '', wide: true }],
    onSubmit: async (values) => {
      if (store.isAuthDisabled()) {
        store.setLocalName(values.name);
        toast('Имя сохранено', 'good');
        refresh();
        return true;
      }
      try {
        await store.saveUserName(user.id, values.name);
        await store.pull();
        toast('Имя сохранено', 'good');
        refresh();
        return true;
      } catch (error) {
        toast(error.message, 'danger');
        return false;
      }
    },
  });
}

function openPasswordForm() {
  openForm({
    title: 'Смена кода',
    intro: 'Код заменяет логин и пароль: по нему приложение узнаёт, кто вошёл.',
    fields: [
      { name: 'currentPassword', label: 'Текущий код', type: 'password', required: true, wide: true },
      {
        name: 'newPassword', label: 'Новый код', type: 'password', required: true, wide: true,
        autocomplete: 'new-password', hint: 'Не короче 4 символов, у второго пользователя должен быть другой',
      },
    ],
    onSubmit: async (values) => {
      try {
        await store.changePassword(values.currentPassword, values.newPassword);
        toast('Код изменён', 'good');
        return true;
      } catch (error) {
        toast(error.message || 'Не удалось сменить код', 'danger');
        return false;
      }
    },
  });
}

// Раздел Face ID заполняется после ответа сервера: нужно знать,
// защищён ли адрес и какие телефоны уже привязаны.
async function renderPasskeys(host, user) {
  if (!passkey.isSupported()) {
    host.innerHTML = html`
      <p class="muted">Face ID включится после того, как приложение откроется
      по защищённому адресу с доменом. По IP-адресу браузер эту возможность не даёт —
      это его правило, обойти нельзя.</p>`;
    return;
  }
  if (!(await passkey.isPhoneReady())) {
    host.innerHTML = html`<p class="muted">Это устройство не поддерживает Face ID или Touch ID.</p>`;
    return;
  }

  const { passkeys = [] } = await passkey.list();
  host.innerHTML = html`
    ${passkeys.length ? raw(html`<div class="list">${raw(passkeys.map((item) => html`
      <div class="row">
        <div class="row__main">
          <span class="row__title">${item.label}</span>
          <span class="row__subtitle">Привязан ${formatDate(String(item.createdAt).slice(0, 10), { short: true })}</span>
        </div>
        <button class="btn btn--sm btn--ghost" data-remove-key="${item.id}">Отвязать</button>
      </div>`).join(''))}</div>`)
      : raw(html`<p class="muted">Телефон пока не привязан — вход только по коду.</p>`)}
    <button class="btn btn--primary btn--block" data-add-key>Привязать этот телефон</button>
    <p class="muted">После привязки на экране входа появится кнопка «Войти по Face ID».
      Код останется запасным способом.</p>`;

  host.querySelector('[data-add-key]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Поднесите лицо…';
    try {
      const label = /iPhone|iPad/.test(navigator.userAgent)
        ? `iPhone · ${user?.name || ''}`.trim()
        : `Устройство · ${user?.name || ''}`.trim();
      await passkey.register(label);
      toast('Face ID подключён', 'good');
      renderPasskeys(host, user);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Привязать этот телефон';
      toast(error?.name === 'NotAllowedError' ? 'Привязка отменена' : (error.message || 'Не получилось'), 'danger');
    }
  });

  host.querySelectorAll('[data-remove-key]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog('Отвязать это устройство? Вход по коду сохранится.', { confirmLabel: 'Отвязать' });
      if (!ok) return;
      await passkey.remove(button.dataset.removeKey);
      toast('Устройство отвязано');
      renderPasskeys(host, user);
    });
  });
}

export default function settings() {
  const state = store.getState();
  const user = store.getUser();
  const status = store.getStatus();
  const openMode = store.isAuthDisabled();
  const theme = getTheme();
  const groups = expenseGroups(state.settings);
  const planned = state.planned.filter((item) => item.status !== 'paid');

  const statusLabel = status.status === 'online' ? 'Данные синхронизированы с сервером'
    : status.status === 'saving' ? `Сохраняем изменения (${status.pending})`
      : 'Нет связи с сервером — изменения отправятся позже';

  const body = html`
    <div class="card">
      ${raw(sectionTitle('Компания', '<button class="btn btn--sm" data-act="company">Изменить</button>'))}
      <div class="list">
        <div class="row"><div class="row__main"><span class="row__subtitle">Название</span><span class="row__title">${state.settings.companyName}</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Базовая валюта</span><span class="row__title">TJS — сомони</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Курс доллара</span>
          <span class="row__title">1 $ = ${state.settings.rates.USD} TJS</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">Аванс по умолчанию</span>
          <span class="row__title">${state.settings.defaultAdvancePercent}%</span></div></div>
        <div class="row"><div class="row__main"><span class="row__subtitle">День зарплаты</span>
          <span class="row__title">${state.settings.salaryDay} числа</span></div></div>
      </div>
      <p class="muted">Курс сохраняется вместе с операцией: старые операции не пересчитываются при изменении курса.</p>
    </div>

    ${openMode ? '' : raw(html`
      <div class="card">
        ${raw(sectionTitle('Вход по Face ID'))}
        <div data-passkeys><p class="muted">Проверяем…</p></div>
      </div>`)}

    <div class="card">
      ${raw(sectionTitle('Оформление'))}
      <div class="segmented segmented--full" data-theme-switch>
        ${raw(THEMES.map((item) => html`
          <button type="button" class="segmented__item ${raw(item.id === theme ? 'is-active' : '')}"
            data-value="${item.id}">${item.label}</button>`).join(''))}
      </div>
      <p class="muted">Выбор сохраняется в этом телефоне — у второго учредителя может быть своё.</p>
    </div>

    <div class="card">
      ${raw(sectionTitle('Регулярные платежи', '<button class="btn btn--sm" data-act="add-planned">Добавить</button>'))}
      ${planned.length ? raw(html`<div class="list">${raw(planned.map((item) => html`
        <button class="row" data-planned="${item.id}" style="width:100%;text-align:left">
          <div class="row__main">
            <span class="row__title">${item.title}</span>
            <span class="row__subtitle">${categoryLabel(item.category, state.settings)} · ${formatDate(item.dueDate, { short: true })}${item.repeat === 'monthly' ? ' · ежемесячно' : ''}</span>
          </div>
          <span class="row__amount">${formatAmount(item.amount, item.currency)}</span>
        </button>`).join(''))}</div>`)
        : raw(emptyState('Добавьте аренду, налоги и коммунальные — они появятся в разделе «Выплатить»'))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Категории расходов', '<button class="btn btn--sm" data-act="add-category">Добавить</button>'))}
      ${raw(groups.map((group) => html`
        <div>
          <p class="muted"><b>${group.label}</b></p>
          <div class="list">${raw(group.items.map((item) => html`
            <div class="row">
              <div class="row__main"><span class="row__title">${item.label}</span>
                ${SYSTEM_CATEGORIES.includes(item.id) ? raw(html`<span class="row__subtitle">Создаётся автоматически при выплатах</span>`) : ''}
              </div>
              ${item.custom ? raw(html`<button class="btn btn--sm btn--ghost" data-remove-category="${item.id}">Удалить</button>`) : ''}
            </div>`).join(''))}</div>
        </div>`).join(''))}
    </div>

    <div class="card">
      ${raw(sectionTitle('Учётная запись'))}
      <div class="list">
        <div class="row">
          <div class="row__main"><span class="row__subtitle">${openMode ? 'Операции подписываются именем' : 'Вы вошли как'}</span>
            <span class="row__title">${user?.name || ''}${openMode ? '' : ` · ${user?.login || ''}`}</span></div>
          <button class="btn btn--sm" data-act="name">Имя</button>
        </div>
        ${openMode ? '' : raw(html`
          <div class="row">
            <div class="row__main"><span class="row__subtitle">Код входа</span><span class="row__title">••••••</span></div>
            <button class="btn btn--sm" data-act="password">Сменить</button>
          </div>`)}
        ${openMode ? '' : raw(html`
          <div class="row">
            <div class="row__main"><span class="row__subtitle">Доступ</span>
              <span class="row__title">${store.canEdit() ? 'Полный: внесение, изменение, удаление' : 'Только просмотр'}</span></div>
          </div>`)}
        <div class="row">
          <div class="row__main"><span class="row__subtitle">Синхронизация</span><span class="row__title">${statusLabel}</span></div>
        </div>
      </div>
      <p class="muted">Данные хранятся на сервере студии. Оба учредителя видят одни и те же цифры.</p>
      ${openMode ? raw(html`
        <p class="form__error">Вход в приложение отключён: страницу может открыть любой, кто знает адрес сервера.
          Включается обратно на сервере — см. finance/README.md.</p>`)
        : raw(html`<button class="btn btn--block" data-act="logout">Выйти</button>`)}
    </div>`;

  return {
    title: 'Настройки',
    subtitle: state.settings.companyName,
    back: '#/',
    body,
    mount(root) {
      const passkeyHost = root.querySelector('[data-passkeys]');
      if (passkeyHost) renderPasskeys(passkeyHost, user);

      root.querySelector('[data-theme-switch]')?.addEventListener('click', (event) => {
        const button = event.target.closest('.segmented__item');
        if (!button) return;
        setTheme(button.dataset.value);
        refresh();
      });
      root.querySelector('[data-act="company"]')?.addEventListener('click', () => openCompanyForm(state.settings));
      root.querySelector('[data-act="add-category"]').onclick = () => openCategoryForm();
      root.querySelector('[data-act="add-planned"]').onclick = async () => {
        const { openPlannedForm } = await import('../forms.js');
        openPlannedForm(null, refresh);
      };
      root.querySelectorAll('[data-planned]').forEach((button) => {
        button.onclick = async () => {
          const { openPlannedForm } = await import('../forms.js');
          openPlannedForm(button.dataset.planned, refresh);
        };
      });
      root.querySelectorAll('[data-remove-category]').forEach((button) => {
        button.onclick = async () => {
          const ok = await confirmDialog('Удалить категорию? Операции с ней останутся в истории.');
          if (!ok) return;
          actions.removeCategory(button.dataset.removeCategory);
          refresh();
        };
      });
      root.querySelector('[data-act="name"]').onclick = () => openNameForm(user);
      root.querySelector('[data-act="password"]')?.addEventListener('click', () => openPasswordForm());
      root.querySelector('[data-act="logout"]')?.addEventListener('click', async () => {
        const ok = await confirmDialog('Выйти из приложения?', { confirmLabel: 'Выйти', tone: 'danger' });
        if (ok) await store.signOut();
      });
    },
  };
}
