// Клиентское хранилище с синхронизацией через сервер.
//
// Данные компании лежат на сервере — оба учредителя работают с одной базой.
// В браузере держится копия: интерфейс отвечает мгновенно, а изменения
// уходят на сервер очередью. Если связь пропала, работа продолжается,
// а операции отправятся, как только сеть вернётся.

import { emptyData, normalizeData, applyOps, op } from './ops.js';

const CACHE_KEY = 'studio-finance/cache/v2';
const NAME_KEY = 'studio-finance/name';
const POLL_INTERVAL = 8000;

let data = emptyData();
let rev = 0;
let user = null;
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
    return { ...(user || {}), name: localName() || 'Учредитель', open: true };
  }
  return user;
}

export function isAuthDisabled() {
  return authDisabled;
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
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rev, data, queue }));
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
    return true;
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
  if (response.status === 401) {
    user = null;
    emit('auth');
    const error = new Error('Требуется вход');
    error.code = 401;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
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
    return user;
  } catch (error) {
    if (error.code === 401) return null;
    setStatus('offline');
    return null;
  }
}

export async function signIn(login, password) {
  const payload = await api('/login', { method: 'POST', body: { login, password } });
  user = payload.user;
  authDisabled = Boolean(payload.authDisabled);
  clearCache();
  data = emptyData();
  rev = 0;
  queue = [];
  await pull();
  return user;
}

export async function signOut() {
  try {
    await api('/logout', { method: 'POST' });
  } catch { /* даже при ошибке выходим локально */ }
  user = null;
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

export async function pull() {
  try {
    const payload = await api('/state');
    adopt(payload);
    setStatus(queue.length ? 'saving' : 'online');
    return true;
  } catch (error) {
    if (error.code !== 401) setStatus('offline');
    return false;
  }
}

async function flush() {
  if (!queue.length || !user) return;
  const sending = queue.slice();
  setStatus('saving');
  try {
    const payload = await api('/ops', { method: 'POST', body: { rev, ops: sending } });
    queue = queue.slice(sending.length);
    adopt(payload);
    retryDelay = 1000;
    setStatus(queue.length ? 'saving' : 'online');
    if (queue.length) scheduleFlush(0);
  } catch (error) {
    if (error.code === 400 || error.code === 422) {
      // Сервер отверг операцию — повторять бессмысленно.
      queue = queue.slice(sending.length);
      cache();
      setStatus('online');
      return;
    }
    setStatus('offline');
    retryDelay = Math.min(retryDelay * 2, 30000);
    scheduleFlush(retryDelay);
  }
}

function scheduleFlush(delay = 120) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

// Главная точка изменения данных.
export function commit(ops) {
  const list = (Array.isArray(ops) ? ops : [ops]).filter(Boolean);
  if (!list.length) return data;
  applyOps(data, list);
  queue.push(...list);
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
  restoreCache();
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
