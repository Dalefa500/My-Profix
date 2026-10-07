// Клиентское хранилище с синхронизацией через сервер.
//
// Данные компании лежат на сервере — оба учредителя работают с одной базой.
// В браузере держится копия: интерфейс отвечает мгновенно, а изменения
// уходят на сервер очередью. Если связь пропала, работа продолжается,
// а операции отправятся, как только сеть вернётся.

import { emptyData, normalizeData, applyOps, op } from './ops.js';
import { BRAND } from './brand.js';

// Ключи свои у каждой компании: если две студии когда-нибудь окажутся
// на одном адресе, их данные и очередь операций не перепутаются.
const CACHE_KEY = `${BRAND.storagePrefix}/cache/v2`;
const NAME_KEY = `${BRAND.storagePrefix}/name`;
const POLL_INTERVAL = 8000;

let data = emptyData();
let rev = 0;
let user = null;
// Чьи изменения лежат в очереди: если вход истёк и тот же человек вошёл
// снова, неотправленное не выбрасываем.
let queueOwner = null;
// Когда вход отключён, приложение открывается сразу. Имя того, кто работает,
// хранится в браузере — только чтобы было видно, кто внёс операцию.
let authDisabled = false;
let queue = [];
let status = 'loading'; // loading | online | saving | offline
let pollTimer = null;
let flushTimer = null;
let retryDelay = 1000;

const listeners = new Set();

export function uid(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

export function getState() {
  return data;
}

export function getUser() {
  if (authDisabled) {
    // Без входа имени нет — тогда в операциях просто не указываем, кто внёс,
    // вместо безличной подписи.
    return { ...(user || {}), name: localName(), open: true };
  }
  return user;
}

export function isAuthDisabled() {
  return authDisabled;
}

// Может ли текущий пользователь менять данные.
// Настоящая проверка — на сервере; здесь мы просто не показываем лишнего.
export function canEdit() {
  return getUser()?.role !== 'viewer';
}

export function localName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setLocalName(name) {
  try {
    localStorage.setItem(NAME_KEY, String(name || '').trim());
  } catch {
    /* приватный режим — имя просто не сохранится */
  }
  emit('change');
  return getUser();
}

export function getStatus() {
  return { status, pending: queue.length, rev };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason = 'change') {
  for (const listener of listeners) listener(data, reason);
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  emit('status');
}

// ------------------------------------------------------------ локальный кэш

function cache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rev, data, queue, user, owner: queueOwner }));
  } catch {
    /* переполнение или приватный режим — работаем без кэша */
  }
}

function restoreCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    data = normalizeData(saved.data);
    rev = Number(saved.rev) || 0;
    queue = Array.isArray(saved.queue) ? saved.queue : [];
    user = saved.user || null;
    queueOwner = saved.owner || saved.user?.id || null;
    return Boolean(user);
  } catch {
    return false;
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch { /* не критично */ }
}

// ------------------------------------------------------------------- запросы

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    // При попытке входа сервер объясняет причину («Неверный код») —
    // её и показываем. Для остальных запросов 401 — это истёкший вход.
    const isLogin = path === '/login' || path.startsWith('/passkey/login');
    if (!isLogin) {
      if (user) queueOwner = user.id;
      user = null;
      cache();
      emit('auth');
    }
    const error = new Error(payload.error || 'Требуется вход');
    error.code = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка сервера');
    error.code = response.status;
    throw error;
  }
  return payload;
}

function adopt(payload) {
  if (!payload || typeof payload.rev !== 'number') return;
  rev = payload.rev;
  data = normalizeData(payload.state);
  // Локальные, ещё не подтверждённые изменения остаются видимыми.
  if (queue.length) applyOps(data, queue);
  cache();
  emit('sync');
}

// ---------------------------------------------------------------------- вход

export async function checkSession() {
  try {
    const payload = await api('/session');
    user = payload.user || null;
    authDisabled = Boolean(payload.authDisabled);
    // Доступ сменили на «только просмотр» — неотправленное уже не примут.
    if (user && !canEdit() && queue.length) {
      queue = [];
      cache();
    }
    return user;
  } catch (error) {
    if (error.code === 401) return null;
    setStatus('offline');
    return null;
  }
}

// Вход по коду. Логин и пароль тоже поддерживаются — для восстановления
// доступа из командной строки.
export async function signIn(code, password) {
  const body = password === undefined ? { code } : { login: code, password };
  const payload = await api('/login', { method: 'POST', body });
  authDisabled = Boolean(payload.authDisabled);
  return startSession(payload.user);
}

// Вход по Face ID выполняется отдельным модулем; сюда приходит уже
// подтверждённый сервером пользователь.
export async function completeLogin(nextUser) {
  return startSession(nextUser);
}

// Тот же человек вошёл снова (истёк вход, телефон был без связи) — его
// неотправленные изменения сохраняем и отправляем. Другой человек —
// начинаем с чистого листа: чужие черновики ему не принадлежат.
async function startSession(nextUser) {
  // Сохраняем очередь только тому же человеку и только если он по-прежнему
  // может вносить данные (его могли перевести в «только просмотр»).
  const keep = queue.length > 0 && queueOwner && nextUser?.id === queueOwner && nextUser?.role !== 'viewer';
  if (!keep) {
    clearCache();
    data = emptyData();
    rev = 0;
    queue = [];
  }
  user = nextUser;
  queueOwner = user?.id || null;
  await pull();
  if (queue.length) scheduleFlush(0);
  return user;
}

// Сколько изменений ещё не дошло до сервера.
export function pendingCount() {
  return queue.length;
}

// Попробовать отправить всё сейчас (перед выходом). Ждём не дольше 5 секунд.
export async function flushNow() {
  const started = Date.now();
  while (queue.length && user && Date.now() - started < 5000) {
    if (!flushing) await flush();
    else await new Promise((resolve) => setTimeout(resolve, 200));
    if (status === 'offline') break;
  }
  return queue.length;
}

export async function signOut() {
  try {
    await api('/logout', { method: 'POST' });
  } catch { /* даже при ошибке выходим локально */ }
  user = null;
  queueOwner = null;
  queue = [];
  data = emptyData();
  rev = 0;
  clearCache();
  stopSync();
  emit('auth');
}

export async function changePassword(currentPassword, newPassword) {
  return api('/password', { method: 'POST', body: { currentPassword, newPassword } });
}

export async function listUsers() {
  const payload = await api('/users');
  return payload.users || [];
}

export async function saveUserName(id, name) {
  return api('/users', { method: 'POST', body: { id, name } });
}

// --------------------------------------------------------------- синхронизация

// Номер ответа на /ops: чтение, начатое до него, могло увидеть данные
// без только что сохранённого изменения — такой ответ не применяем.
let opsEpoch = 0;

export async function pull() {
  const epoch = opsEpoch;
  try {
    const payload = await api('/state');
    if (epoch === opsEpoch) adopt(payload);
    setStatus(queue.length ? 'saving' : 'online');
    return true;
  } catch (error) {
    if (error.code !== 401) setStatus('offline');
    return false;
  }
}

// Просит сервер сходить на сайт НБТ за свежим курсом.
// Сервер сам сохраняет его в настройках, поэтому потом просто перечитываем.
export async function refreshUsdRate() {
  try {
    const payload = await api('/rate', { method: 'POST', body: {} });
    await pull();
    return payload;
  } catch (error) {
    return { ok: false, error: error.message || 'Не удалось связаться с сервером' };
  }
}

// Отправка очереди на сервер. Одновременно идёт только одна отправка:
// раньше несколько отправок могли пересечься, и тогда одни изменения
// уходили дважды, а другие терялись. Из очереди убираются именно те
// операции, что ушли, — а не «первые N», которые к ответу могли смениться.
let flushing = false;
let flushAgain = false;

function dropSent(sending) {
  const sent = new Set(sending);
  queue = queue.filter((item) => !sent.has(item));
}

async function flush() {
  if (!queue.length || !user) return;
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  flushAgain = false;
  // Частями: очередь, накопленная за долгое время без связи, не должна
  // упираться в предел размера запроса.
  // Одна операция пользователя (например, удаление сотрудника со всеми
  // его начислениями) не делится между запросами — режем только по границе.
  let size = Math.min(queue.length, 50);
  while (size < queue.length && queue[size].g && queue[size].g === queue[size - 1].g) size += 1;
  const sending = queue.slice(0, size);
  setStatus('saving');
  try {
    const payload = await api('/ops', { method: 'POST', body: { rev, ops: sending } });
    opsEpoch += 1;
    dropSent(sending);
    adopt(payload);
    retryDelay = 1000;
    setStatus(queue.length ? 'saving' : 'online');
  } catch (error) {
    if (error.code === 400 || error.code === 403 || error.code === 422) {
      // Сервер отверг операцию — повторять бессмысленно.
      // Локально изменение уже показано — забираем с сервера настоящие
      // данные, чтобы на экране не осталось того, чего на сервере нет.
      dropSent(sending);
      cache();
      emit(error.code === 403 ? 'denied' : 'rejected');
      void pull();
    } else {
      setStatus('offline');
      retryDelay = Math.min(retryDelay * 2, 30000);
      flushing = false;
      scheduleFlush(retryDelay);
      return;
    }
  } finally {
    flushing = false;
  }
  if (queue.length || flushAgain) scheduleFlush(0);
}

function scheduleFlush(delay = 120) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

// Главная точка изменения данных.
export function commit(ops) {
  const list = (Array.isArray(ops) ? ops : [ops]).filter(Boolean);
  if (!list.length) return data;
  if (!canEdit()) {
    emit('denied');
    return data;
  }
  // Сначала пробуем на копии: если операция не применяется (данные успели
  // измениться), не портим текущее состояние и не шлём её на сервер.
  try {
    applyOps(structuredClone(data), list);
  } catch (error) {
    console.error(error);
    emit('invalid');
    return null;
  }
  applyOps(data, list);
  // Метка группы: операции одного действия отправляются вместе.
  const group = list.length > 1 ? uid('g') : null;
  queue.push(...(group ? list.map((item) => ({ ...item, g: group })) : list));
  cache();
  emit('change');
  scheduleFlush();
  return data;
}

export function startSync() {
  stopSync();
  pollTimer = setInterval(() => {
    if (document.hidden || !user) return;
    if (queue.length) {
      scheduleFlush(0);
      return;
    }
    pull();
  }, POLL_INTERVAL);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
}

function onVisible() {
  if (document.hidden || !user) return;
  if (queue.length) scheduleFlush(0);
  else pull();
}

export function stopSync() {
  clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onVisible);
}

export async function init() {
  // Если в браузере есть прошлая сессия, приложение открывается сразу
  // с сохранёнными данными, а связь с сервером проверяется следом —
  // так запуск с экрана «Домой» не ждёт сеть.
  const restored = restoreCache();
  if (restored) {
    startSync();
    void (async () => {
      const session = await checkSession(); // при отказе сервера покажется экран кода
      if (!session) return;
      await pull();
      if (queue.length) scheduleFlush(0);
    })();
    return user;
  }

  const session = await checkSession();
  if (!session) return null;
  await pull();
  if (queue.length) scheduleFlush(0);
  startSync();
  return session;
}

// ------------------------------------------------- удобные обёртки над ops

export function list(collection) {
  return data[collection] || [];
}

export function byId(collection, id) {
  if (!id) return null;
  return list(collection).find((item) => item.id === id) || null;
}

export function insert(collection, record, prefix = collection.slice(0, 3)) {
  const item = { id: record.id || uid(prefix), createdAt: record.createdAt || new Date().toISOString().slice(0, 10), ...record };
  commit(op.insert(collection, item));
  return item;
}

export function patch(collection, id, changes, unset) {
  commit(op.patch(collection, id, changes, unset));
  return byId(collection, id);
}

export function remove(collection, id) {
  commit(op.remove(collection, id));
}

export function setSettings(changes) {
  commit(op.settings(changes));
  return data.settings;
}

export { op };
