// Точка входа приложения: вход в систему, общий каркас, навигация.

import * as store from './store.js';
import * as router from './router.js';
import { html, raw, openSheet, closeSheet, money, toast, fastTap } from './ui.js';
import { ensurePayrolls } from './actions.js';
import { notifications } from './calc.js';
import * as forms from './forms.js';
import { mountCharts } from './charts.js';
import { setRefresh } from './refresh.js';
import { applyTheme } from './theme.js';
import * as passkey from './passkey.js';
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
import barters from './views/barters.js';
import payments from './views/payments.js';
import settings from './views/settings.js';
import founders, { founderDetail } from './views/founders.js';

const root = document.getElementById('app');
let currentView = null;
let backTarget = '';

const TABS = [
  { href: '#/', label: 'Главная', icon: 'home', match: ['/'], view: () => dashboard },
  { href: '#/projects', label: 'Проекты', icon: 'folder', match: ['/projects', '/projects/:id'], view: () => projects },
  { href: '#/employees', label: 'Сотрудники', icon: 'people', match: ['/employees', '/employees/:id'], view: () => employees },
  { href: '#/clients', label: 'Клиенты', icon: 'client', match: ['/clients', '/clients/:id', '/barters'], view: () => clients },
  { href: '#/finance', label: 'Финансы', icon: 'wallet', match: ['/finance', '/finance/:tab'], view: () => finance },
  { href: '#/reports', label: 'Отчёты', icon: 'chart', match: ['/reports', '/reports/:period'], view: () => reports },
];

// ------------------------------------------------------------------ вход

// Вход по коду: логин вводить не нужно — код сам определяет, кто вошёл
// и что ему разрешено. Экран оформлен как обложка студии: фирменные цвета,
// чертёжная графика, спокойная типографика.
const FACE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
  <path d="M9 10v1.5M15 10v1.5M12 10v3l-1 1" />
  <path d="M9.5 15.5a3.5 3.5 0 0 0 5 0" />
</svg>`;

const PLAN_ART = `
  <svg class="auth__plan" viewBox="0 0 320 320" fill="none" stroke="currentColor"
    stroke-width="1" aria-hidden="true">
    <rect x="28" y="40" width="150" height="112" />
    <rect x="178" y="40" width="114" height="60" />
    <rect x="178" y="100" width="114" height="52" />
    <rect x="28" y="152" width="96" height="128" />
    <rect x="124" y="152" width="168" height="128" />
    <path d="M124 196h-24M124 236h-24" />
    <path d="M178 152v24M232 280v-24" />
    <path d="M60 152a28 28 0 0 0 28 28" stroke-dasharray="3 4" />
    <path d="M232 100a26 26 0 0 1-26 26" stroke-dasharray="3 4" />
    <path d="M28 300h264M28 294v12M292 294v12" />
    <circle cx="208" cy="216" r="26" stroke-dasharray="2 5" />
  </svg>`;

function renderAuth(error = '') {
  document.body.classList.remove('is-locked');
  root.className = 'auth';
  root.innerHTML = html`
    <div class="auth__scene" aria-hidden="true">${raw(PLAN_ART)}</div>

    <div class="auth__inner">
      <div class="auth__brand">
        <h1 class="auth__word">
          <span class="auth__script">Line design</span>
          <span class="auth__studio">Studio</span>
        </h1>
        <span class="auth__rule"></span>
        <p class="auth__tagline">Студия дизайна интерьеров</p>
      </div>

      <form class="auth__form">
        <button type="button" class="btn auth__faceid" data-faceid hidden>
          ${raw(FACE_ICON)} Войти по Face ID
        </button>
        <label class="auth__label" for="code">Код входа</label>
        <input id="code" name="code" class="auth__code" type="password" inputmode="numeric"
          autocomplete="one-time-code" maxlength="12" placeholder="••••••" required>
        ${error ? raw(html`<div class="form__error">${error}</div>`) : ''}
        <button class="btn btn--primary btn--block" type="submit">Войти</button>
      </form>
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
  const faceButton = root.querySelector('[data-faceid]');
  if (faceButton) {
    // Кнопка появляется, только если телефон умеет Face ID и на сервере
    // уже есть привязанное устройство.
    passkey.isPhoneReady().then(async (ready) => {
      if (!ready || !(await passkey.isAvailable())) return;
      faceButton.hidden = false;
      faceButton.addEventListener('click', async () => {
        faceButton.disabled = true;
        try {
          const signed = await passkey.signIn();
          await store.completeLogin(signed);
          store.startSync();
          startApp();
        } catch (error) {
          faceButton.disabled = false;
          const message = error?.name === 'NotAllowedError' ? 'Вход отменён' : error.message;
          toast(message || 'Не удалось войти по Face ID', 'danger');
        }
      });
    });
  }

  root.querySelector('#code')?.focus();
}

// ------------------------------------------------------------------ каркас

function shellHtml() {
  const state = store.getState();
  return html`
    <header class="topbar">
      <div class="topbar__side">
        <button class="topbar__back" data-back hidden aria-label="Назад">${raw(ICONS.back)}</button>
        <div class="topbar__title">
          <h1 data-title>Главная</h1>
          <span data-subtitle></span>
        </div>
      </div>

      <div class="topbar__actions">
        <button class="icon-btn" data-notifications aria-label="Уведомления">
          ${raw(ICONS.bell)}<span class="icon-btn__dot" data-bell hidden></span></button>
        <button class="icon-btn" data-more aria-label="Ещё">${raw(ICONS.more)}</button>
      </div>
    </header>
    <!-- Знак студии живёт отдельно от шапки: внутри неё стоит размытие фона,
         и тонкий рукописный шрифт из-за него терял чёткость. -->
    <div class="brand" aria-hidden="true"><span class="brand__name">Line design</span></div>
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
  root.className = 'app';
  applyRole();
  root.innerHTML = shellHtml();
  fastTap(root.querySelector('[data-quick]'), openQuickActions);
  fastTap(root.querySelector('[data-more]'), openMoreMenu);
  fastTap(root.querySelector('[data-notifications]'), openNotifications);
  fastTap(root.querySelector('[data-back]'), () => {
    // Если приложение открыли сразу на внутреннем экране, возвращаться
    // по истории некуда — уходим на заданный экран.
    if (window.history.length > 1) window.history.back();
    else if (backTarget) router.go(backTarget, { replace: true });
  });

  root.querySelectorAll('[data-tab]').forEach((tab) => {
    fastTap(tab, () => {
      if (tab.classList.contains('is-active')) return;
      // подсветка переключается сразу, экран рисуется следующим кадром —
      // палец чувствует отклик раньше, чем успевает подняться
      root.querySelectorAll('[data-tab]').forEach((item) => item.classList.remove('is-active'));
      tab.classList.add('is-active');
      requestAnimationFrame(() => router.go(tab.dataset.tab, { replace: true }));
    });
  });
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
    current.style.transitionDuration = '';
    ghost.style.transitionDuration = '';
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

    // чем ближе палец довёл страницу, тем короче доводка — жест ощущается сразу
    const remaining = passed
      ? Math.max(0, width - Math.abs(shift)) / width
      : Math.abs(shift) / width;
    const duration = Math.max(0.14, Math.min(0.32, 0.32 * remaining));
    current.style.transitionDuration = `${duration}s`;
    ghost.style.transitionDuration = `${duration}s`;
    const guard = duration * 1000 + 90;

    viewport.classList.add('is-animating');
    if (passed && target) {
      current.style.transform = `translate3d(${-delta * width}px, 0, 0)`;
      ghost.style.transform = 'translate3d(0, 0, 0)';
      const done = () => {
        current.removeEventListener('transitionend', done);
        // переносим уже отрисованные узлы соседа, а не разметку: так
        // ничего не перерисовывается заново и мигания не возникает,
        // а затем отдаём управление маршрутизатору — он вернёт обработчики
        current.replaceChildren(...ghost.childNodes);
        finish();
        router.go(target.href, { replace: true });
      };
      current.addEventListener('transitionend', done, { once: true });
      setTimeout(() => { if (viewport.classList.contains('is-animating')) done(); }, guard);
    } else {
      current.style.transform = 'translate3d(0, 0, 0)';
      if (delta !== 0) ghost.style.transform = `translate3d(${delta * width}px, 0, 0)`;
      const back = () => {
        current.removeEventListener('transitionend', back);
        finish();
      };
      current.addEventListener('transitionend', back, { once: true });
      setTimeout(() => { if (viewport.classList.contains('is-animating')) finish(); }, guard);
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
  '/barters': barters,
  '/payments': payments,
  '/payments/:tab': payments,
  '/founders': founders,
  '/founders/:id': founderDetail,
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

  // Экран собирается вне страницы и вставляется одним движением.
  // Если писать разметку прямо в host, браузер успевает показать пустой
  // контейнер — на телефоне это видно как короткая чёрная вспышка.
  // Заодно придерживаем прежнюю высоту, чтобы страница не проседала.
  const previousHeight = host.offsetHeight;
  if (previousHeight > 0) host.style.minHeight = `${previousHeight}px`;
  const draft = document.createElement('template');
  draft.innerHTML = result.body || '';
  host.replaceChildren(draft.content);

  document.querySelector('[data-title]').textContent = result.title || '';
  const subtitle = document.querySelector('[data-subtitle]');
  subtitle.textContent = result.subtitle || '';
  const back = document.querySelector('[data-back]');
  back.hidden = !result.back;
  // Куда возвращаться, помним здесь: обработчик кнопки навешен один раз
  // при запуске. Раньше поверх него ставился второй, и нажатие уводило
  // на шаг дальше, чем нужно.
  backTarget = result.back || '';

  for (const tab of document.querySelectorAll('[data-tab]')) {
    const config = TABS.find((item) => item.href === tab.dataset.tab);
    tab.classList.toggle('is-active', config.match.includes(router.currentRoute().pattern));
  }

  result.mount?.(host);
  mountCharts(host);
  updateBell();
  applyRole();

  // Высоту отпускаем следующим кадром — к этому моменту новый экран
  // уже разложен, и проседания не будет.
  if (previousHeight > 0) {
    requestAnimationFrame(() => { host.style.minHeight = ''; });
  }

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
    // Наверх поднимаемся до отрисовки: иначе новый экран сначала
    // показывается с прежней позицией прокрутки и дёргается.
    window.scrollTo({ top: 0 });
    currentView = { view, params };
    renderView();
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
      <a class="row" href="#/payments" data-close="1"><div class="row__main"><span class="row__title">Платежи</span><span class="row__subtitle">Что получить и что выплатить</span></div><span class="row__meta">›</span></a>
      <a class="row" href="#/barters" data-close="1"><div class="row__main"><span class="row__title">Взаиморасчёты</span><span class="row__subtitle">Квартиры и машины в счёт работ</span></div><span class="row__meta">›</span></a>
      <a class="row" href="#/founders" data-close="1"><div class="row__main"><span class="row__title">Коллеги</span><span class="row__subtitle">Сколько взяли из кассы</span></div><span class="row__meta">›</span></a>
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

// Права отмечаем на корне документа, а не только на самом приложении:
// всплывающие листы («Приход», «Расход», карточка операции) лежат отдельно
// от него, и иначе кнопки правки оставались бы видны тому, кто только смотрит.
function applyRole() {
  const viewer = !store.canEdit();
  root.classList.toggle('is-viewer', viewer);
  document.documentElement.classList.toggle('is-viewer', viewer);
}

// Разведение пальцев и двойное нажатие не должны менять масштаб экрана:
// приложение всегда показывается в одном размере.
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(name, (event) => event.preventDefault());
}

// Долгое нажатие на строку списка открывало системный предпросмотр ссылки
// с адресом сервера. Приложение — не веб-страница, такого меню быть не должно.
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('input, textarea')) return;
  event.preventDefault();
});

// Android и компьютеры умеют закреплять ориентацию по-настоящему.
function lockPortrait() {
  try {
    screen.orientation?.lock?.('portrait')?.catch?.(() => {});
  } catch { /* ориентация не закрепляется — это не ошибка */ }
}

// iPhone команду закрепления игнорирует. Там поступаем иначе: когда телефон
// поворачивают, разворачиваем сам интерфейс в обратную сторону, чтобы для
// глаза он остался на месте. Сторону поворота берём у системы — иначе при
// повороте в другую сторону приложение оказалось бы вверх ногами.
function applyRotation() {
  const root = document.documentElement;
  const landscape = window.innerWidth > window.innerHeight;
  if (!landscape) {
    root.removeAttribute('data-rotate');
    return;
  }
  // Система сообщает, на сколько она сама повернула картинку.
  // Мы поворачиваем интерфейс на столько же в обратную сторону.
  const angle = Number(screen.orientation?.angle ?? window.orientation ?? 0);
  root.setAttribute('data-rotate', angle === 90 ? 'left' : 'right');
}

window.addEventListener('resize', applyRotation);
window.addEventListener('orientationchange', applyRotation);
screen.orientation?.addEventListener?.('change', applyRotation);

async function boot() {
  applyTheme();
  lockPortrait();
  applyRotation();
  root.className = 'auth';
  root.innerHTML = `
    <div class="auth__scene" aria-hidden="true">${PLAN_ART}</div>
    <div class="auth__inner">
      <div class="auth__brand">
        <h1 class="auth__word">
          <span class="auth__script">Line design</span>
          <span class="auth__studio">Studio</span>
        </h1>
        <span class="auth__rule"></span>
        <p class="auth__tagline">Студия дизайна интерьеров</p>
      </div>
      <p class="auth__hint">Загружаем данные…</p>
    </div>`;
  const user = await store.init();
  if (!user) {
    renderAuth();
    return;
  }
  startApp();
}

setRefresh(renderView);
boot();
