// Вход в приложение: два учредителя, у обоих полный доступ ко всем данным.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readJSON, writeJSON, withAuthLock } from './storage.js';

const scryptAsync = promisify(scrypt);

const USERS_FILE = 'users.json';
const SESSIONS_FILE = 'sessions.json';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const failures = new Map(); // ip -> { count, until }

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const derived = await scryptAsync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, 'hex');
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

export async function loadUsers() {
  return (await readJSON(USERS_FILE, [])) || [];
}

export async function saveUsers(users) {
  await writeJSON(USERS_FILE, users);
}

// Роли: admin — вносит, правит и удаляет; viewer — только смотрит.
export const ROLES = ['admin', 'viewer'];

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    role: user.role === 'viewer' ? 'viewer' : 'admin',
  };
}

export function canEdit(user) {
  return Boolean(user) && user.role !== 'viewer';
}

async function createUserUnlocked({ login, name, password, role = 'admin' }) {
  const users = await loadUsers();
  const normalized = String(login).trim().toLowerCase();
  if (users.some((user) => user.login === normalized)) {
    throw new Error(`Пользователь «${normalized}» уже существует`);
  }
  const { salt, hash } = await hashPassword(password);
  const user = {
    id: `usr_${randomBytes(6).toString('hex')}`,
    login: normalized,
    name: name || normalized,
    role: ROLES.includes(role) ? role : 'admin',
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await saveUsers(users);
  return publicUser(user);
}

async function setPasswordUnlocked(login, password, keepToken = null) {
  const users = await loadUsers();
  const user = users.find((item) => item.login === String(login).trim().toLowerCase());
  if (!user) throw new Error('Пользователь не найден');
  // Код входа должен быть у каждого свой — иначе непонятно, кто вошёл.
  for (const other of users) {
    if (other.id === user.id) continue;
    // Чей это код — не сообщаем: иначе смена своего кода превращается
    // в способ подобрать чужой.
    if (await verifyPassword(String(password), other)) {
      throw new Error('Этот код не подходит — придумайте другой.');
    }
  }
  const { salt, hash } = await hashPassword(password);
  user.salt = salt;
  user.hash = hash;
  await saveUsers(users);
  // Сменили код — все прежние входы этого человека закрываются
  // (кроме текущего, если код меняют из приложения).
  await dropUserSessions(user.id, keepToken);
  return publicUser(user);
}

async function setRoleUnlocked(login, role) {
  if (!ROLES.includes(role)) throw new Error('Роль может быть admin или viewer');
  const users = await loadUsers();
  const user = users.find((item) => item.login === String(login).trim().toLowerCase());
  if (!user) throw new Error('Пользователь не найден');
  user.role = role;
  await saveUsers(users);
  await dropUserSessions(user.id);
  return publicUser(user);
}

async function deleteUserUnlocked(login) {
  const users = await loadUsers();
  const normalized = String(login).trim().toLowerCase();
  const next = users.filter((item) => item.login !== normalized);
  if (next.length === users.length) throw new Error('Пользователь не найден');
  if (!next.some((item) => item.role !== 'viewer')) {
    throw new Error('Нельзя удалить последнего пользователя с полным доступом');
  }
  await saveUsers(next);
  const removed = users.find((item) => item.login === normalized);
  if (removed) await dropUserSessions(removed.id);
  return true;
}

async function setNameUnlocked(id, name) {
  const users = await loadUsers();
  const user = users.find((item) => item.id === id);
  if (!user) throw new Error('Пользователь не найден');
  user.name = String(name).trim() || user.name;
  await saveUsers(users);
  return publicUser(user);
}

// ------------------------------------------------------------------- сессии

async function loadSessions() {
  const sessions = (await readJSON(SESSIONS_FILE, {})) || {};
  const now = Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (!session?.expiresAt || session.expiresAt < now) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) await writeJSON(SESSIONS_FILE, sessions);
  return sessions;
}

async function dropUserSessions(userId, keepToken = null) {
  const sessions = await loadSessions();
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (session.userId === userId && token !== keepToken) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) await writeJSON(SESSIONS_FILE, sessions);
}

async function createSessionUnlocked(userId) {
  const sessions = await loadSessions();
  const token = randomBytes(32).toString('hex');
  sessions[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DAYS * 86400000,
  };
  await writeJSON(SESSIONS_FILE, sessions);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

async function destroySessionUnlocked(token) {
  if (!token) return;
  const sessions = await loadSessions();
  if (sessions[token]) {
    delete sessions[token];
    await writeJSON(SESSIONS_FILE, sessions);
  }
}

async function userForTokenUnlocked(token) {
  if (!token) return null;
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) return null;
  const users = await loadUsers();
  return users.find((user) => user.id === session.userId) || null;
}

// ------------------------------------------------------------------- вход

// Общий предел неудачных попыток со всех адресов: даже если кто-то
// перебирает коды с множества адресов, за час у него будет не больше
// GLOBAL_MAX_FAILURES попыток. Вход по Face ID при этом работает.
const GLOBAL_MAX_FAILURES = 100;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
let globalFailures = [];

function globalBlocked(limit = GLOBAL_MAX_FAILURES) {
  const since = Date.now() - GLOBAL_WINDOW_MS;
  globalFailures = globalFailures.filter((time) => time > since);
  return globalFailures.length >= limit;
}

// trusted — запрос с телефона, где уже был успешный вход (см. server.js).
// На него общий предел не действует: иначе посторонний мог бы, набрав сотню
// неверных попыток с разных адресов, закрыть вход владельцам на час.
// Но и у него есть потолок — втрое выше обычного: метка есть у каждого,
// кто хоть раз входил (в том числе у «только просмотра»), и перебирать
// чужой код с неё без ограничений нельзя.
export function loginBlocked(ip, { trusted = false } = {}) {
  if (globalBlocked(trusted ? GLOBAL_MAX_FAILURES * 3 : GLOBAL_MAX_FAILURES)) return true;
  const record = failures.get(ip);
  if (!record) return false;
  if (record.until < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return record.count >= MAX_FAILURES;
}

function registerFailure(ip) {
  globalFailures.push(Date.now());
  const record = failures.get(ip) || { count: 0, until: Date.now() + FAILURE_WINDOW_MS };
  record.count += 1;
  record.until = Date.now() + FAILURE_WINDOW_MS;
  failures.set(ip, record);
}

// Попытка входа учитывается ДО проверки кода (она медленная — scrypt):
// иначе сотня одновременных запросов успевала пройти проверку предела
// раньше, чем засчитывалась первая неудача. С одного адреса — не больше
// одной проверки за раз, со всех — не больше MAX_IN_FLIGHT.
const MAX_IN_FLIGHT = 8;
const inFlight = new Map();
let inFlightTotal = 0;

// Возвращает объект попытки, 'blocked' (предел исчерпан) или 'busy'
// (с этого адреса уже идёт проверка).
export function beginLogin(ip, { trusted = false } = {}) {
  if (loginBlocked(ip, { trusted })) return 'blocked';
  if ((inFlight.get(ip) || 0) >= 1 || inFlightTotal >= MAX_IN_FLIGHT) return 'busy';
  inFlight.set(ip, (inFlight.get(ip) || 0) + 1);
  inFlightTotal += 1;
  registerFailure(ip);
  let done = false;
  const release = () => {
    const left = (inFlight.get(ip) || 1) - 1;
    if (left > 0) inFlight.set(ip, left);
    else inFlight.delete(ip);
    inFlightTotal = Math.max(0, inFlightTotal - 1);
  };
  return {
    succeed() {
      if (done) return;
      done = true;
      release();
      failures.delete(ip);
      globalFailures.pop();
    },
    fail() {
      if (done) return;
      done = true;
      release();
    },
  };
}

// Проверки ниже предел не считают — это делает beginLogin.
export async function authenticate(login, password) {
  const users = await loadUsers();
  const user = users.find((item) => item.login === String(login || '').trim().toLowerCase());
  const ok = user ? await verifyPassword(String(password || ''), user) : false;
  return ok ? user : null;
}

// Вход по коду: логин вводить не нужно, код сам определяет, кто вошёл.
export async function authenticateByCode(code) {
  const value = String(code || '').trim();
  if (value.length < 4) return null;
  const users = await loadUsers();
  for (const user of users) {
    if (await verifyPassword(value, user)) return user;
  }
  return null;
}

// Смена кода — не чаще PASSWORD_MAX_ATTEMPTS раз за 15 минут на человека,
// считая и удачные попытки: перебирать коды через эту форму бесполезно.
const PASSWORD_MAX_ATTEMPTS = 5;
const passwordAttempts = new Map();

export async function changePassword(user, currentPassword, newPassword, keepToken = null) {
  const now = Date.now();
  const recent = (passwordAttempts.get(user.id) || []).filter((time) => time > now - FAILURE_WINDOW_MS);
  if (recent.length >= PASSWORD_MAX_ATTEMPTS) {
    throw new Error('Слишком много попыток сменить код. Попробуйте через 15 минут.');
  }
  recent.push(now);
  passwordAttempts.set(user.id, recent);
  const ok = await verifyPassword(String(currentPassword || ''), user);
  if (!ok) throw new Error('Текущий код неверный');
  const next = String(newPassword || '').trim();
  if (next.length < 4) throw new Error('Код должен быть не короче 4 символов');
  return setPassword(user.login, next, keepToken);
}

// Открытые функции работают с файлами входа строго по очереди.
export const createUser = (...args) => withAuthLock(() => createUserUnlocked(...args));
export const setPassword = (...args) => withAuthLock(() => setPasswordUnlocked(...args));
export const setRole = (...args) => withAuthLock(() => setRoleUnlocked(...args));
export const deleteUser = (...args) => withAuthLock(() => deleteUserUnlocked(...args));
export const setName = (...args) => withAuthLock(() => setNameUnlocked(...args));
export const createSession = (...args) => withAuthLock(() => createSessionUnlocked(...args));
export const destroySession = (...args) => withAuthLock(() => destroySessionUnlocked(...args));
export const userForToken = (...args) => withAuthLock(() => userForTokenUnlocked(...args));
