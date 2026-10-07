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

// Открытый лист (форма, карточка) занимает свою запись в истории: тогда
// жест «назад» на iPhone закрывает лист, а не уводит с экрана вместе
// с недописанной формой. Закрыли лист кнопкой — запись убираем сами
// (history.back), а переходы, запрошенные до того, как браузер это
// сделал, выполняем следом, чтобы они не попали на чужую запись.
let sheetEntry = null; // { onPop } пока лист открыт
let backQueue = null; // переходы, ждущие завершения history.back()
let backTimer = null;

function pushSheetState() {
  window.history.pushState({ depth, sheet: true }, '', window.location.href);
}

export function openSheetEntry(onPop) {
  if (sheetEntry) {
    sheetEntry.onPop = onPop;
    return;
  }
  sheetEntry = { onPop };
  // Прежний лист только что закрыли и браузер ещё не убрал его запись —
  // новую добавим сразу после этого.
  if (backQueue) backQueue.push(pushSheetState);
  else pushSheetState();
}

export function closeSheetEntry() {
  if (!sheetEntry) return;
  sheetEntry = null;
  if (backQueue) {
    // Лист закрыли раньше, чем появилась его запись: и добавлять не нужно.
    const at = backQueue.indexOf(pushSheetState);
    if (at >= 0) backQueue.splice(at, 1);
    return;
  }
  if (!window.history.state?.sheet) return;
  backQueue = [];
  window.history.back();
  // Подстраховка: если браузер так и не сообщил о возврате.
  clearTimeout(backTimer);
  backTimer = setTimeout(() => {
    // Сообщение о возврате, пришедшее позже, — эхо этого же шага.
    staleBack = true;
    flushBackQueue();
  }, 1500);
}

let staleBack = false;

function flushBackQueue() {
  clearTimeout(backTimer);
  const queue = backQueue || [];
  backQueue = null;
  queue.forEach((fn) => fn());
}

export function go(path, { replace = false } = {}) {
  if (backQueue) {
    backQueue.push(() => go(path, { replace }));
    return;
  }
  // Переход прямо из открытого листа (например, после создания проекта):
  // запись листа занимает новый экран, а не остаётся лишним шагом «назад».
  if (sheetEntry && window.history.state?.sheet) {
    sheetEntry = null;
    if (replace) {
      // Заменить нужно экран под листом: сначала убираем запись листа.
      backQueue = [() => go(path, { replace: true })];
      window.history.back();
      clearTimeout(backTimer);
      backTimer = setTimeout(() => { staleBack = true; flushBackQueue(); }, 1500);
      return;
    }
    depth += 1;
    window.history.replaceState({ depth }, '', `${window.location.pathname}${window.location.search}${path}`);
    resolve();
    return;
  }
  const url = `${window.location.pathname}${window.location.search}${path}`;
  if (replace) {
    window.history.replaceState({ depth }, '', url);
  } else if (window.location.hash !== path) {
    depth += 1;
    window.history.pushState({ depth }, '', url);
  }
  resolve();
}

// Уйти с экрана удалённой записи: шагом назад, если есть куда (обычно это
// список, откуда пришли), иначе — заменой на список. Так после удаления
// не остаётся лишней записи в истории и «назад» не тратится впустую.
export function leave(fallback) {
  if (backQueue) {
    backQueue.push(() => leave(fallback));
    return;
  }
  if (depth > 0) window.history.back();
  else go(fallback, { replace: true });
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
  // Перезагрузка, когда сверху была запись листа: листа уже нет — тихо
  // возвращаемся на запись экрана, иначе «назад» потребовал бы лишнего нажатия.
  depth = Number(window.history.state?.depth) || 0;
  if (window.history.state?.sheet) {
    backQueue = [];
    window.history.back();
    backTimer = setTimeout(() => { staleBack = true; flushBackQueue(); }, 1500);
  }
  window.addEventListener('popstate', (event) => {
    depth = Number(event.state?.depth) || 0;
    // Это мы сами убрали запись закрытого листа: экран тот же.
    if (backQueue) {
      flushBackQueue();
      return;
    }
    if (staleBack) {
      staleBack = false;
      if (window.location.hash === current.path) return;
    }
    // Жест «назад» при открытом листе закрывает только лист.
    if (sheetEntry) {
      const { onPop } = sheetEntry;
      sheetEntry = null;
      onPop?.();
      if (window.location.hash === current.path) return;
    }
    // Запись листа, оставшаяся после «вперёд», — экран не меняется.
    if (event.state?.sheet && window.location.hash === current.path) return;
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
