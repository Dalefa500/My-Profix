// Сервер приложения «Финансы дизайн-студии».
// Без внешних зависимостей: только Node.js. Хранит общие данные компании
// и отдаёт веб-приложение обоим учредителям.

import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { applyOps, normalizeData, emptyData } from '../finance/js/ops.js';
import {
  ensureDir, readJSON, writeJSON, appendLine, withLock, DATA_DIR,
} from './storage.js';
import {
  authenticate, createSession, destroySession, userForToken, publicUser,
  loadUsers, createUser, changePassword, setName, loginBlocked,
} from './auth.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_FILE = 'state.json';
const COOKIE = 'sf_session';
const MAX_BODY = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ------------------------------------------------------------ данные компании

let cache = null; // { rev, state }

async function loadState() {
  if (cache) return cache;
  const stored = await readJSON(STATE_FILE, null);
  cache = stored && typeof stored.rev === 'number'
    ? { rev: stored.rev, state: normalizeData(stored.state) }
    : { rev: 0, state: emptyData() };
  return cache;
}

async function saveState(next) {
  cache = next;
  await writeJSON(STATE_FILE, next);
}

// ------------------------------------------------------------------ утилиты

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isSecure(req) {
  if (process.env.FORCE_SECURE_COOKIE === '1') return true;
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAge) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function currentUser(req) {
  return userForToken(readCookie(req, COOKIE));
}

// --------------------------------------------------------------------- API

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api/, '') || '/';

  if (route === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return send(res, 429, { error: 'Слишком много попыток входа. Попробуйте позже.' });
    }
    const body = await readBody(req);
    const user = await authenticate(body.login, body.password, ip);
    if (!user) return send(res, 401, { error: 'Неверный логин или пароль' });
    const { token, maxAge } = await createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }

  if (route === '/logout' && req.method === 'POST') {
    await destroySession(readCookie(req, COOKIE));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
  }

  const user = await currentUser(req);
  if (!user) return send(res, 401, { error: 'Требуется вход' });

  if (route === '/session' && req.method === 'GET') {
    return send(res, 200, { user: publicUser(user) });
  }

  if (route === '/state' && req.method === 'GET') {
    const current = await loadState();
    return send(res, 200, current);
  }

  if (route === '/ops' && req.method === 'POST') {
    const body = await readBody(req);
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (!ops.length) {
      const current = await loadState();
      return send(res, 200, current);
    }
    try {
      const result = await withLock(async () => {
        const current = await loadState();
        // Операции адресуются по id записей, поэтому применяются к текущим
        // данным независимо от того, какую версию видел клиент.
        const state = applyOps(normalizeData(current.state), ops);
        const next = { rev: current.rev + 1, state, updatedAt: new Date().toISOString() };
        await saveState(next);
        await appendLine('log.jsonl', {
          at: next.updatedAt, rev: next.rev, user: user.login, ops,
        });
        return next;
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 422, { error: error.message || 'Операция отклонена' });
    }
  }

  if (route === '/users' && req.method === 'GET') {
    const users = await loadUsers();
    return send(res, 200, { users: users.map(publicUser) });
  }

  if (route === '/users' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.id !== user.id) {
      return send(res, 403, { error: 'Можно менять только своё имя' });
    }
    const updated = await setName(body.id, body.name);
    return send(res, 200, { user: updated });
  }

  if (route === '/password' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await changePassword(user, body.currentPassword, body.newPassword);
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  return send(res, 404, { error: 'Не найдено' });
}

// ------------------------------------------------------------ статические файлы

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = path.join(ROOT, pathname);
  if (!target.startsWith(ROOT) || target.startsWith(path.join(ROOT, 'server'))) {
    res.writeHead(403).end('Доступ запрещён');
    return;
  }
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      res.writeHead(302, { Location: `${pathname}/` }).end();
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Приложение обновляется часто — браузер каждый раз сверяется с сервером.
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css'
        ? 'no-cache'
        : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Страница не найдена');
  }
}

// ------------------------------------------------------------------- запуск

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/finance/' }).end();
      return;
    }
    if (url.pathname.startsWith('/api')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    if (!res.headersSent) send(res, status, { error: error.message || 'Ошибка сервера' });
    else res.end();
  }
});

// При первом запуске создаются две учётные записи, пароли показываются один раз.
async function bootstrapUsers() {
  const users = await loadUsers();
  if (users.length) return;
  const created = [];
  for (const [login, name] of [['osnovatel1', 'Учредитель 1'], ['osnovatel2', 'Учредитель 2']]) {
    const password = randomBytes(6).toString('base64url');
    await createUser({ login, name, password });
    created.push({ login, name, password });
  }
  const lines = created.map((item) => `${item.name}: логин ${item.login}, пароль ${item.password}`);
  await fs.writeFile(
    path.join(DATA_DIR, 'ПАРОЛИ-ПРИ-ПЕРВОМ-ЗАПУСКЕ.txt'),
    `${lines.join('\n')}\n\nСменить пароль можно в приложении: Ещё → Настройки.\n`,
    'utf8',
  );
  console.log('\nСозданы учётные записи учредителей:');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`  (пароли также сохранены в ${path.join(DATA_DIR, 'ПАРОЛИ-ПРИ-ПЕРВОМ-ЗАПУСКЕ.txt')})\n`);
}

await ensureDir();
await bootstrapUsers();
await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Line Design — финансы студии: http://localhost:${PORT}/finance/`);
  console.log(`Данные хранятся в ${DATA_DIR}`);
});
