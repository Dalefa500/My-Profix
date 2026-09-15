// Точка входа приложения: вход в систему, общий каркас, навигация.

import * as store from './store.js';
import * as router from './router.js';
import { html, raw, openSheet, closeSheet, money } from './ui.js';
import { ensurePayrolls } from './actions.js';
import { notifications } from './calc.js';
import * as forms from './forms.js';
import { mountCharts } from './charts.js';
import { setRefresh } from './refresh.js';

import dashboard from './views/dashboard.js';
import projects from './views/projects.js';
import projectDetail from './views/project.js';
import employees from './views/employees.js';
import employeeDetail from './views/employee.js';
import finance from './views/finance.js';
import reports from './views/reports.js';
import clients from './views/clients.js';
import clientDetail from './views/client.js';
import payments from './views/payments.js';
import settings from './views/settings.js';

const root = document.getElementById('app');
let currentView = null;

const ICONS = {
  home: '<path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  people: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6zm15.5 0c0-2.1-.8-3.9-2.1-5.2 3 .4 5.6 2.4 5.6 5.2z"/>',
  money: '<path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6"/>',
  reports: '<path d="M4 20V10h4v10zm6 0V4h4v16zm6 0v-7h4v7z"/>',
};

const TABS = [
  { href: '#/', label: 'Главная', icon: 'home', match: ['/'] },
  { href: '#/projects', label: 'Проекты', icon: 'projects', match: ['/projects', '/projects/:id'] },
  { href: '#/employees', label: 'Сотрудники', icon: 'people', match: ['/employees', '/employees/:id'] },
  { href: '#/finance', label: 'Финансы', icon: 'money', match: ['/finance', '/finance/:tab'] },
  { href: '#/reports', label: 'Отчёты', icon: 'reports', match: ['/reports', '/reports/:period'] },
];

// ------------------------------------------------------------------ вход

function renderAuth(error = '') {
  document.body.classList.remove('is-locked');
  root.className = 'auth';
  root.innerHTML = html`
    <div class="auth__card">
      <h1>Line Design</h1>
      <p>Финансы студии. Вход для учредителей — все данные хранятся на сервере, доступ у обоих одинаковый.</p>
      <form class="auth__form">
        <div class="field">
          <label for="login">Логин</label>
          <input id="login" name="login" type="text" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="password">Пароль</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        ${error ? raw(html`<div class="form__error">${error}</div>`) : ''}
        <button class="btn btn--primary btn--block" type="submit">Войти</button>
      </form>
    </div>`;

  const form = root.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Проверяем…';
    try {
      await store.signIn(form.login.value.trim(), form.password.value);
      store.startSync();
      startApp();
    } catch (requestError) {
      renderAuth(requestError.message || 'Не удалось войти');
    }
  });
  root.querySelector('#login')?.focus();
}

// ------------------------------------------------------------------ каркас

function shellHtml() {
  const state = store.getState();
  return html`
    <header class="topbar">
      <div class="topbar__back" data-back hidden>‹</div>
      <div class="topbar__title">
        <h1 data-title>Главная</h1>
        <span data-subtitle></span>
      </div>
      <button class="icon-btn" data-notifications aria-label="Уведомления">🔔<span class="icon-btn__dot" data-bell hidden></span></button>
      <button class="icon-btn" data-more aria-label="Ещё">⋯</button>
    </header>
    <main class="view" id="view"></main>
    <button class="fab" data-quick aria-label="Быстрое действие">+</button>
    <nav class="tabbar" data-brand="${state.settings.companyName || 'Line Design'}">
      ${raw(TABS.map((tab) => html`
        <a class="tabbar__item" href="${tab.href}" data-tab="${tab.href}">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${raw(ICONS[tab.icon])}</svg>
          ${tab.label}
        </a>`).join(''))}
    </nav>`;
}

function renderShell() {
  root.className = 'app';
  root.innerHTML = shellHtml();
  root.querySelector('[data-quick]').addEventListener('click', openQuickActions);
  root.querySelector('[data-more]').addEventListener('click', openMoreMenu);
  root.querySelector('[data-notifications]').addEventListener('click', openNotifications);
  root.querySelector('[data-back]').addEventListener('click', () => window.history.back());
}

const VIEWS = {
  '/': dashboard,
  '/projects': projects,
  '/projects/:id': projectDetail,
  '/employees': employees,
  '/employees/:id': employeeDetail,
  '/finance': finance,
  '/finance/:tab': finance,
  '/reports': reports,
  '/reports/:period': reports,
  '/clients': clients,
  '/clients/:id': clientDetail,
  '/payments': payments,
  '/payments/:tab': payments,
  '/settings': settings,
};

function renderView() {
  if (!currentView) return;
  const host = document.getElementById('view');
  if (!host) return;

  // Сохраняем позицию прокрутки и активное поле поиска при перерисовке.
  const active = document.activeElement;
  const searchValue = active?.hasAttribute?.('data-search') ? active.value : null;
  const caret = searchValue !== null ? active.selectionStart : null;

  const result = currentView.view(currentView.params) || {};
  host.innerHTML = result.body || '';
  document.querySelector('[data-title]').textContent = result.title || '';
  const subtitle = document.querySelector('[data-subtitle]');
  subtitle.textContent = result.subtitle || '';
  const back = document.querySelector('[data-back]');
  back.hidden = !result.back;
  if (result.back) {
    back.onclick = () => router.go(result.back);
  }

  for (const tab of document.querySelectorAll('[data-tab]')) {
    const config = TABS.find((item) => item.href === tab.dataset.tab);
    tab.classList.toggle('is-active', config.match.includes(router.currentRoute().pattern));
  }

  result.mount?.(host);
  mountCharts(host);
  updateBell();

  if (searchValue !== null) {
    const input = host.querySelector('[data-search]');
    if (input) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }
  }
}

function show(view) {
  return (params) => {
    currentView = { view, params };
    renderView();
    window.scrollTo({ top: 0 });
  };
}

function updateBell() {
  const dot = document.querySelector('[data-bell]');
  if (!dot) return;
  const count = notifications(store.getState()).length;
  dot.hidden = count === 0;
  dot.textContent = count > 9 ? '9+' : String(count);
}

// ---------------------------------------------------------- меню и панели

function openQuickActions() {
  openSheet({
    title: 'Быстрое действие',
    body: html`<div class="quick">
      <button class="quick__item" data-act="income"><span class="quick__icon quick__icon--good">+</span>Добавить приход</button>
      <button class="quick__item" data-act="expense"><span class="quick__icon quick__icon--danger">−</span>Добавить расход</button>
      <button class="quick__item" data-act="project"><span class="quick__icon">П</span>Создать проект</button>
      <button class="quick__item" data-act="employee"><span class="quick__icon">С</span>Добавить сотрудника</button>
    </div>`,
    onMount: (panel) => {
      const run = (fn) => { closeSheet(); setTimeout(fn, 60); };
      panel.querySelector('[data-act="income"]').onclick = () => run(() => forms.openIncomeForm({}, renderView));
      panel.querySelector('[data-act="expense"]').onclick = () => run(() => forms.openExpenseForm({}, renderView));
      panel.querySelector('[data-act="project"]').onclick = () => run(() => forms.openProjectForm(null, (project) => router.go(`#/projects/${project.id}`)));
      panel.querySelector('[data-act="employee"]').onclick = () => run(() => forms.openEmployeeForm(null, renderView));
    },
  });
}

function openMoreMenu() {
  const user = store.getUser();
  openSheet({
    title: 'Ещё',
    body: html`<div class="list">
      <a class="row" href="#/clients" data-close="1"><div class="row__main"><span class="row__title">Клиенты</span></div><span class="row__meta">›</span></a>
      <a class="row" href="#/payments" data-close="1"><div class="row__main"><span class="row__title">Платежи</span><span class="row__subtitle">Что получить и что выплатить</span></div><span class="row__meta">›</span></a>
      <a class="row" href="#/settings" data-close="1"><div class="row__main"><span class="row__title">Настройки</span><span class="row__subtitle">Курс, категории, пароль</span></div><span class="row__meta">›</span></a>
      <div class="row"><div class="row__main"><span class="row__title">${user?.name || ''}</span>
        <span class="row__subtitle">${store.isAuthDisabled() ? 'вход в приложение отключён' : (user?.login || '')}</span></div>
        ${raw(store.isAuthDisabled() ? '' : '<button class="btn btn--sm" data-act="logout">Выйти</button>')}</div>
    </div>`,
    onMount: (panel) => {
      panel.querySelector('[data-act="logout"]')?.addEventListener('click', async () => {
        closeSheet();
        await store.signOut();
      });
    },
  });
}

function openNotifications() {
  const items = notifications(store.getState());
  openSheet({
    title: 'Уведомления',
    body: items.length
      ? html`<div class="list">${raw(items.map((item) => html`
          <a class="row" href="${item.href}" data-close="1">
            <div class="row__main">
              <span class="row__title">${item.title}</span>
              <span class="row__subtitle">${item.text}</span>
            </div>
            <div class="row__side">
              ${item.amountBase ? raw(html`<span class="row__amount">${money(item.amountBase)}</span>`) : ''}
              <span class="badge badge--${raw(item.tone)}">${item.icon}</span>
            </div>
          </a>`).join(''))}</div>`
      : html`<div class="empty"><p>Всё спокойно: сроков и просрочек нет.</p></div>`,
  });
}

// ------------------------------------------------------------------ запуск

function registerRoutes() {
  for (const [pattern, view] of Object.entries(VIEWS)) {
    router.route(pattern, show(view));
  }
  router.setNotFound(() => router.go('#/'));
}

function startApp() {
  renderShell();
  ensurePayrolls();
  registerRoutes();
  router.start();
}

store.subscribe((_, reason) => {
  if (reason === 'auth' && !store.getUser() && !store.isAuthDisabled()) {
    renderAuth();
    return;
  }
  if (root.classList.contains('app')) renderView();
});

async function boot() {
  root.className = 'auth';
  root.innerHTML = '<div class="auth__card"><h1>Line Design</h1><p>Загружаем данные…</p></div>';
  const user = await store.init();
  if (!user) {
    renderAuth();
    return;
  }
  startApp();
}

setRefresh(renderView);
boot();
