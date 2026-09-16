// Точка входа приложения: вход в систему, общий каркас, навигация.

import * as store from './store.js';
import * as router from './router.js';
import { html, raw, openSheet, closeSheet, money, toast } from './ui.js';
import { ensurePayrolls } from './actions.js';
import { notifications } from './calc.js';
import * as forms from './forms.js';
import { mountCharts } from './charts.js';
import { setRefresh } from './refresh.js';
import { ICONS, quickAction } from './icons.js';

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

const TABS = [
  { href: '#/', label: 'Главная', icon: 'home', match: ['/'], view: () => dashboard },
  { href: '#/projects', label: 'Проекты', icon: 'folder', match: ['/projects', '/projects/:id'], view: () => projects },
  { href: '#/employees', label: 'Сотрудники', icon: 'people', match: ['/employees', '/employees/:id'], view: () => employees },
  { href: '#/finance', label: 'Финансы', icon: 'wallet', match: ['/finance', '/finance/:tab'], view: () => finance },
  { href: '#/reports', label: 'Отчёты', icon: 'chart', match: ['/reports', '/reports/:period'], view: () => reports },
];

// ------------------------------------------------------------------ вход

// Вход по коду: логин вводить не нужно — код сам определяет, кто вошёл
// и что ему разрешено.
function renderAuth(error = '') {
  document.body.classList.remove('is-locked');
  root.className = 'auth';
  root.innerHTML = html`
    <div class="auth__card">
      <div class="auth__logo" aria-hidden="true">
        <span>LD</span>
        <div><i style="height:38%"></i><i style="height:68%"></i><i style="height:100%"></i></div>
      </div>
      <h1>Line Design</h1>
      <p>Финансы студии</p>
      <form class="auth__form">
        <label class="auth__label" for="code">Введите код</label>
        <input id="code" name="code" class="auth__code" type="password" inputmode="numeric"
          autocomplete="one-time-code" maxlength="12" placeholder="••••••" required>
        ${error ? raw(html`<div class="form__error">${error}</div>`) : ''}
        <button class="btn btn--primary btn--block" type="submit">Войти</button>
      </form>
      <p class="auth__hint">У каждого свой код: он определяет, кто вносит данные, а кто только смотрит.</p>
    </div>`;

  const form = root.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    const code = form.code.value.trim();
    if (!code) return;
    button.disabled = true;
    button.textContent = 'Проверяем…';
    try {
      await store.signIn(code);
      store.startSync();
      startApp();
    } catch (requestError) {
      renderAuth(requestError.message || 'Не удалось войти');
    }
  });
  root.querySelector('#code')?.focus();
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
    <main class="viewport" id="viewport">
      <div class="view" id="view"></div>
      <div class="view view--ghost" id="viewGhost" aria-hidden="true"></div>
    </main>
    <button class="fab" data-quick aria-label="Быстрое действие">+</button>
    <nav class="tabbar" data-brand="${state.settings.companyName || 'Line Design'}">
      ${raw(TABS.map((tab) => html`
        <a class="tabbar__item" href="${tab.href}" data-tab="${tab.href}">
          ${raw(ICONS[tab.icon])}
          ${tab.label}
        </a>`).join(''))}
    </nav>`;
}

function renderShell() {
  root.className = store.canEdit() ? 'app' : 'app is-viewer';
  root.innerHTML = shellHtml();
  root.querySelector('[data-quick]').addEventListener('click', openQuickActions);
  root.querySelector('[data-more]').addEventListener('click', openMoreMenu);
  root.querySelector('[data-notifications]').addEventListener('click', openNotifications);
  root.querySelector('[data-back]').addEventListener('click', () => window.history.back());
  setupSwipe();
}

// Перелистывание разделов пальцем: страница едет за пальцем, при отпускании
// плавно доезжает сама. Шапка, нижнее меню и фон остаются на месте.
function setupSwipe() {
  const viewport = document.getElementById('viewport');
  const current = document.getElementById('view');
  const ghost = document.getElementById('viewGhost');
  if (!viewport || !current || !ghost) return;

  const THRESHOLD = 0.28; // какую часть экрана нужно протянуть
  let startX = 0;
  let startY = 0;
  let shift = 0;
  let width = 1;
  let delta = 0; // +1 — следующий раздел, −1 — предыдущий
  let tracking = false;
  let active = false;

  const tabIndex = () => TABS.findIndex((tab) => tab.match.includes(router.currentRoute().pattern));

  const finish = () => {
    viewport.classList.remove('is-swiping', 'is-animating');
    current.style.transform = '';
    ghost.style.transform = '';
    ghost.innerHTML = '';
    tracking = false;
    active = false;
    shift = 0;
    delta = 0;
  };

  viewport.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || document.body.classList.contains('is-locked')) return;
    if (viewport.classList.contains('is-animating')) return;
    if (tabIndex() === -1) return;
    // не перехватываем жест на том, что прокручивается вбок или принимает ввод
    if (event.target.closest('.chips, .table-wrap, .segmented, .chart, input, textarea, select')) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    width = viewport.clientWidth || 1;
    tracking = true;
    active = false;
  }, { passive: true });

  viewport.addEventListener('touchmove', (event) => {
    if (!tracking) return;
    const x = event.touches[0].clientX - startX;
    const y = event.touches[0].clientY - startY;

    if (!active) {
      if (Math.abs(x) < 12 && Math.abs(y) < 12) return;
      if (Math.abs(x) < Math.abs(y) * 1.2) { tracking = false; return; } // это прокрутка вверх-вниз
      const index = tabIndex();
      delta = x < 0 ? 1 : -1;
      const next = TABS[index + delta];
      if (next) {
        const result = next.view()({}) || {};
        ghost.innerHTML = result.body || '';
        ghost.style.transform = `translate3d(${delta * width}px, 0, 0)`;
      } else {
        delta = 0; // края списка: только лёгкое сопротивление
      }
      viewport.classList.add('is-swiping');
      active = true;
    }

    event.preventDefault();
    shift = delta === 0 ? x * 0.22 : x;
    current.style.transform = `translate3d(${shift}px, 0, 0)`;
    if (delta !== 0) {
      ghost.style.transform = `translate3d(${shift + delta * width}px, 0, 0)`;
    }
  }, { passive: false });

  const release = () => {
    if (!tracking) return;
    if (!active) { tracking = false; return; }

    const index = tabIndex();
    const target = TABS[index + delta];
    const passed = delta !== 0 && Math.abs(shift) > width * THRESHOLD;

    viewport.classList.add('is-animating');
    if (passed && target) {
      current.style.transform = `translate3d(${-delta * width}px, 0, 0)`;
      ghost.style.transform = 'translate3d(0, 0, 0)';
      const done = () => {
        current.removeEventListener('transitionend', done);
        // подставляем готовую разметку соседа, чтобы не было мигания,
        // а затем отдаём управление маршрутизатору — он вернёт обработчики
        current.innerHTML = ghost.innerHTML;
        finish();
        router.go(target.href);
      };
      current.addEventListener('transitionend', done, { once: true });
      setTimeout(() => { if (viewport.classList.contains('is-animating')) done(); }, 420);
    } else {
      current.style.transform = 'translate3d(0, 0, 0)';
      if (delta !== 0) ghost.style.transform = `translate3d(${delta * width}px, 0, 0)`;
      const back = () => {
        current.removeEventListener('transitionend', back);
        finish();
      };
      current.addEventListener('transitionend', back, { once: true });
      setTimeout(() => { if (viewport.classList.contains('is-animating')) finish(); }, 420);
    }
  };

  viewport.addEventListener('touchend', release, { passive: true });
  viewport.addEventListener('touchcancel', release, { passive: true });
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
  root.classList.toggle('is-viewer', !store.canEdit());

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
      ${raw(quickAction({ act: 'income', icon: 'income', label: 'Добавить приход', tone: 'good', index: 0 }))}
      ${raw(quickAction({ act: 'expense', icon: 'expense', label: 'Добавить расход', tone: 'danger', index: 1 }))}
      ${raw(quickAction({ act: 'project', icon: 'project', label: 'Создать проект', index: 2 }))}
      ${raw(quickAction({ act: 'employee', icon: 'employee', label: 'Добавить сотрудника', index: 3 }))}
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
        <span class="row__subtitle">${store.isAuthDisabled() ? 'вход в приложение отключён'
          : `${user?.login || ''}${store.canEdit() ? '' : ' · только просмотр'}`}</span></div>
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
  if (reason === 'denied') {
    toast('У вас доступ только для просмотра', 'danger');
    return;
  }
  if (reason === 'auth' && !store.getUser() && !store.isAuthDisabled()) {
    renderAuth();
    return;
  }
  if (root.classList.contains('app')) renderView();
});

async function boot() {
  root.className = 'auth';
  root.innerHTML = `<div class="auth__card">
    <div class="auth__logo" aria-hidden="true"><span>LD</span>
      <div><i style="height:38%"></i><i style="height:68%"></i><i style="height:100%"></i></div></div>
    <h1>Line Design</h1><p>Загружаем данные…</p></div>`;
  const user = await store.init();
  if (!user) {
    renderAuth();
    return;
  }
  startApp();
}

setRefresh(renderView);
boot();
