// Навигация по адресной строке: #/projects, #/projects/prj_1 и так далее.

const routes = [];
let notFound = null;
let current = { path: '#/', params: [] };

export function route(pattern, handler) {
  routes.push({ pattern, handler });
}

export function setNotFound(handler) {
  notFound = handler;
}

export function currentRoute() {
  return current;
}

// Переходы делаются записью в историю, а не сменой адреса.
//
// Разница важная: если просто присвоить window.location.hash, браузер
// считает это переходом по якорю и на iPhone в полноэкранном режиме
// показывает кадр перехода — экран на мгновение чернеет. Запись в историю
// такого кадра не вызывает, а адрес и кнопка «назад» работают как прежде.
//
// replace: true — переход без новой записи в истории. Так переключаются
// разделы: иначе системный жест «назад» уводил бы приложение по истории.
// Сколько шагов сделано внутри приложения за этот запуск. По нему кнопка
// «Назад» понимает, есть ли куда возвращаться внутри приложения: history.length
// для этого не годится — в нём и страницы, открытые до приложения.
let depth = 0;

export function canGoBack() {
  return depth > 0;
}

export function go(path, { replace = false } = {}) {
  const url = `${window.location.pathname}${window.location.search}${path}`;
  if (replace) {
    window.history.replaceState({ depth }, '', url);
  } else if (window.location.hash !== path) {
    depth += 1;
    window.history.pushState({ depth }, '', url);
  }
  resolve();
}

export function resolve() {
  const hash = window.location.hash || '#/';
  const path = hash.replace(/^#/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  for (const item of routes) {
    const parts = item.pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    const matched = parts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(segments[index]);
        return true;
      }
      return part === segments[index];
    });
    if (matched) {
      current = { path: hash, pattern: item.pattern, params };
      item.handler(params);
      return;
    }
  }
  current = { path: hash, pattern: null, params: {} };
  notFound?.();
}

// «Назад» и «вперёд» браузер сообщает двумя событиями сразу,
// поэтому перерисовку схлопываем в одну.
let pending = false;
function scheduleResolve() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; resolve(); });
}

export function start() {
  window.addEventListener('popstate', (event) => {
    depth = Number(event.state?.depth) || 0;
    scheduleResolve();
  });
  window.addEventListener('hashchange', scheduleResolve);

  // Ссылки внутри приложения ведут по нему сами. Отдавать переход
  // браузеру нельзя — именно от этого моргал экран при нажатии на строку.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button > 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.('a[href^="#/"]');
    if (!link) return;
    event.preventDefault();
    // Переключатели вкладок внутри экрана (data-replace) не копят историю:
    // иначе «Назад» сначала перебирал бы их, а потом уже уходил с экрана.
    go(link.getAttribute('href'), { replace: link.hasAttribute('data-replace') });
  });

  resolve();
}
