// Сервер приложения «Финансы дизайн-студии».
// Без внешних зависимостей: только Node.js. Хранит общие данные компании
// и отдаёт веб-приложение обоим учредителям.

import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { applyOps, normalizeData, emptyData, SCHEMA_VERSION } from '../finance/js/ops.js';
import {
  ensureDir, readJSON, writeJSON, appendLine, withLock, DATA_DIR,
} from './storage.js';
import {
  createChallenge, verifyRegistration, verifyAssertion, b64url,
} from './webauthn.js';
import {
  authenticate, authenticateByCode, createSession, destroySession, userForToken,
  publicUser, loadUsers, createUser, changePassword, setName, loginBlocked, canEdit,
} from './auth.js';
import { fetchUsdRate } from './nbt.js';

// Вход можно отключить: тогда приложение открывается сразу, без логина
// и пароля. Включается обратно снятием этой настройки — данные и учётные
// записи при этом сохраняются.
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const OPEN_USER = { id: 'usr_open', login: 'open', name: 'Студия', role: 'admin' };

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_FILE = 'state.json';
const PASSKEY_FILE = 'passkeys.json';
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
  if (!stored || typeof stored.rev !== 'number') {
    cache = { rev: 0, state: emptyData() };
    return cache;
  }

  // Переход на доллар пересчитывает все суммы. Перед этим один раз
  // откладываем копию исходных данных — на случай, если понадобится вернуться.
  const version = Number(stored.state?.settings?.schemaVersion) || 1;
  const needsMigration = version < SCHEMA_VERSION;
  if (needsMigration) {
    const backup = `state-before-v${SCHEMA_VERSION}.json`;
    if (!(await readJSON(backup, null))) {
      await writeJSON(backup, stored);
      console.log(`Копия данных до перехода на доллар: ${path.join(DATA_DIR, backup)}`);
    }
  }

  cache = { rev: stored.rev, state: normalizeData(stored.state) };

  if (needsMigration) {
    const next = { rev: cache.rev + 1, state: cache.state, updatedAt: new Date().toISOString() };
    await saveState(next);
    console.log('Суммы пересчитаны в доллары по курсу '
      + `${next.state.settings.usdRate} TJS за $1.`);
  }
  return cache;
}

async function saveState(next) {
  cache = next;
  await writeJSON(STATE_FILE, next);
}

// ------------------------------------------- курс Национального банка

// Последняя попытка обращения к НБТ — чтобы не дёргать сайт на каждый заход.
let rateCheck = { at: 0, error: '' };
const RATE_MIN_INTERVAL = 30 * 60 * 1000;

async function refreshUsdRate({ force = false } = {}) {
  const current = await loadState();
  const settings = current.state.settings || {};
  const today = new Date().toISOString().slice(0, 10);

  if (!force) {
    if (settings.usdRateSource === 'nbt' && settings.usdRateDate === today) {
      return { ok: true, rate: { value: settings.usdRate, date: settings.usdRateDate }, cached: true };
    }
    if (Date.now() - rateCheck.at < RATE_MIN_INTERVAL) {
      return { ok: false, error: rateCheck.error || 'Курс недавно уже проверяли' };
    }
  }

  rateCheck = { at: Date.now(), error: '' };
  const result = await fetchUsdRate();
  if (!result.ok) {
    rateCheck.error = result.error;
    return result;
  }

  const rate = result.rate;
  const same = settings.usdRate === rate.value && settings.usdRateDate === (rate.date || today);
  if (!same) {
    await withLock(async () => {
      const state = normalizeData((await loadState()).state);
      state.settings = {
        ...state.settings,
        usdRate: rate.value,
        usdRateDate: rate.date || today,
        usdRateSource: 'nbt',
        usdRateCheckedAt: new Date().toISOString(),
      };
      const rev = (await loadState()).rev + 1;
      await saveState({ rev, state, updatedAt: new Date().toISOString() });
    });
  }
  return { ok: true, rate };
}

// --------------------------------------------------------- вход по Face ID

// Одноразовые запросы живут пять минут — этого хватает, чтобы поднести лицо.
const challenges = new Map();

function rememberChallenge(challenge, payload = {}) {
  challenges.set(challenge, { ...payload, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [key, item] of challenges) {
    if (item.expiresAt < Date.now()) challenges.delete(key);
  }
}

function takeChallenge(challenge) {
  const item = challenges.get(challenge);
  challenges.delete(challenge);
  if (!item || item.expiresAt < Date.now()) return null;
  return item;
}

// Адрес, для которого создаются ключи. Ключ, созданный на одном домене,
// на другом не работает — это и защищает от поддельных страниц.
function rpFromRequest(req) {
  const host = String(req.headers.host || 'localhost');
  const hostname = host.split(':')[0];
  const secure = isSecure(req) || hostname === 'localhost' || hostname === '127.0.0.1';
  return {
    id: hostname,
    host,
    origins: [`https://${host}`, `https://${hostname}`, `http://${host}`],
    secure,
  };
}

async function loadPasskeys() {
  return (await readJSON(PASSKEY_FILE, [])) || [];
}

async function savePasskeys(list) {
  await writeJSON(PASSKEY_FILE, list);
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

  if (AUTH_DISABLED && (route === '/login' || route === '/logout') && req.method === 'POST') {
    return send(res, 200, { user: OPEN_USER, authDisabled: true });
  }

  if (route === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return send(res, 429, { error: 'Слишком много попыток. Попробуйте через 15 минут.' });
    }
    const body = await readBody(req);
    // Вход по коду (одно поле) или по логину с паролем — оба варианта работают.
    const user = body.code
      ? await authenticateByCode(body.code, ip)
      : await authenticate(body.login, body.password, ip);
    if (!user) {
      return send(res, 401, { error: body.code ? 'Неверный код' : 'Неверный логин или пароль' });
    }
    const { token, maxAge } = await createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }

  // Запрос на вход по Face ID — доступен без входа в приложение.
  if (route === '/passkey/login/options' && req.method === 'POST') {
    const rp = rpFromRequest(req);
    const passkeys = await loadPasskeys();
    const challenge = createChallenge();
    rememberChallenge(challenge, { kind: 'login' });
    return send(res, 200, {
      challenge,
      rpId: rp.id,
      available: passkeys.length > 0,
      allowCredentials: passkeys.map((item) => ({ id: item.id, type: 'public-key' })),
    });
  }

  if (route === '/passkey/login/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const rp = rpFromRequest(req);
    const passkeys = await loadPasskeys();
    const credential = passkeys.find((item) => item.id === body.id);
    if (!credential) return send(res, 401, { error: 'Этот телефон не привязан' });

    const clientData = JSON.parse(b64url.decode(body.response.clientDataJSON).toString('utf8'));
    if (!takeChallenge(clientData.challenge)) {
      return send(res, 401, { error: 'Запрос устарел, попробуйте ещё раз' });
    }
    try {
      const result = verifyAssertion({
        response: body.response,
        challenge: clientData.challenge,
        origins: rp.origins,
        rpId: rp.id,
        credential,
      });
      credential.signCount = result.signCount;
      credential.usedAt = new Date().toISOString();
      await savePasskeys(passkeys);
    } catch (error) {
      return send(res, 401, { error: error.message });
    }

    const users = await loadUsers();
    const owner = users.find((item) => item.id === credential.userId);
    if (!owner) return send(res, 401, { error: 'Учётная запись не найдена' });
    const { token, maxAge } = await createSession(owner.id);
    return send(res, 200, { user: publicUser(owner) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }

  if (route === '/logout' && req.method === 'POST') {
    await destroySession(readCookie(req, COOKIE));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
  }

  const user = AUTH_DISABLED ? OPEN_USER : await currentUser(req);
  if (!user) return send(res, 401, { error: 'Требуется вход' });

  if (route === '/session' && req.method === 'GET') {
    return send(res, 200, { user: publicUser(user), authDisabled: AUTH_DISABLED });
  }

  if (route === '/state' && req.method === 'GET') {
    const current = await loadState();
    return send(res, 200, current);
  }

  // Курс НБТ: обновить может любой вошедший, это не изменение учётных данных.
  if (route === '/rate' && req.method === 'POST') {
    const result = await refreshUsdRate({ force: true });
    const current = await loadState();
    return send(res, result.ok ? 200 : 502, {
      ok: result.ok,
      error: result.error || '',
      settings: current.state.settings,
      rev: current.rev,
    });
  }

  if (route === '/ops' && req.method === 'POST') {
    // Пользователь с доступом только на просмотр не может менять данные.
    // Проверка именно здесь, на сервере: интерфейс можно обойти, сервер — нет.
    if (!canEdit(user)) {
      return send(res, 403, { error: 'У вас доступ только для просмотра' });
    }
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

  // Привязка Face ID — только для того, кто уже вошёл по коду.
  if (route === '/passkey/register/options' && req.method === 'POST') {
    const rp = rpFromRequest(req);
    if (!rp.secure) {
      return send(res, 400, { error: 'Face ID работает только по защищённому адресу (https)' });
    }
    const passkeys = await loadPasskeys();
    const challenge = createChallenge();
    rememberChallenge(challenge, { kind: 'register', userId: user.id });
    return send(res, 200, {
      challenge,
      rp: { id: rp.id, name: 'Line Design' },
      user: {
        id: b64url.encode(Buffer.from(user.id)),
        name: user.login,
        displayName: user.name,
      },
      excludeCredentials: passkeys
        .filter((item) => item.userId === user.id)
        .map((item) => ({ id: item.id, type: 'public-key' })),
    });
  }

  if (route === '/passkey/register/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const rp = rpFromRequest(req);
    const clientData = JSON.parse(b64url.decode(body.response.clientDataJSON).toString('utf8'));
    const pending = takeChallenge(clientData.challenge);
    if (!pending || pending.userId !== user.id) {
      return send(res, 400, { error: 'Запрос устарел, попробуйте ещё раз' });
    }
    try {
      const credential = verifyRegistration({
        response: body.response,
        challenge: clientData.challenge,
        origins: rp.origins,
        rpId: rp.id,
      });
      const passkeys = await loadPasskeys();
      if (passkeys.some((item) => item.id === credential.credentialId)) {
        return send(res, 200, { ok: true, already: true });
      }
      passkeys.push({
        id: credential.credentialId,
        userId: user.id,
        publicKey: credential.publicKey,
        alg: credential.alg,
        signCount: credential.signCount,
        label: String(body.label || 'Телефон').slice(0, 40),
        createdAt: new Date().toISOString(),
      });
      await savePasskeys(passkeys);
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (route === '/passkey' && req.method === 'GET') {
    const rp = rpFromRequest(req);
    const passkeys = await loadPasskeys();
    return send(res, 200, {
      secure: rp.secure,
      passkeys: passkeys
        .filter((item) => item.userId === user.id)
        .map((item) => ({ id: item.id, label: item.label, createdAt: item.createdAt, usedAt: item.usedAt })),
    });
  }

  if (route === '/passkey/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const passkeys = await loadPasskeys();
    const next = passkeys.filter((item) => !(item.id === body.id && item.userId === user.id));
    await savePasskeys(next);
    return send(res, 200, { ok: true });
  }

  if (route === '/users' && req.method === 'GET') {
    const users = await loadUsers();
    return send(res, 200, { users: users.map(publicUser) });
  }

  if (route === '/users' && req.method === 'POST') {
    if (AUTH_DISABLED) {
      return send(res, 400, { error: 'Вход в приложение сейчас отключён' });
    }
    const body = await readBody(req);
    if (body.id !== user.id) {
      return send(res, 403, { error: 'Можно менять только своё имя' });
    }
    const updated = await setName(body.id, body.name);
    return send(res, 200, { user: updated });
  }

  if (route === '/password' && req.method === 'POST') {
    if (AUTH_DISABLED) {
      return send(res, 400, { error: 'Вход в приложение сейчас отключён — пароль не используется' });
    }
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
  const accounts = [
    { login: 'shohin', name: 'Шохин', role: 'admin' },
    { login: 'rizvon', name: 'Ризвон', role: 'viewer' },
  ];
  const codes = new Set();
  for (const account of accounts) {
    let password;
    do {
      password = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
    } while (codes.has(password));
    codes.add(password);
    await createUser({ ...account, password });
    created.push({ ...account, password });
  }
  const lines = created.map((item) => `${item.name}: код ${item.password}`
    + (item.role === 'viewer' ? ' (только просмотр)' : ' (полный доступ: внесение, правки, удаление)'));
  await fs.writeFile(
    path.join(DATA_DIR, 'КОДЫ-ДЛЯ-ВХОДА.txt'),
    `${lines.join('\n')}\n\nСменить код можно в приложении: Ещё → Настройки.\n`,
    'utf8',
  );
  console.log('\nКоды для входа в приложение:');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`  (коды также сохранены в ${path.join(DATA_DIR, 'КОДЫ-ДЛЯ-ВХОДА.txt')})\n`);
}

await ensureDir();
await bootstrapUsers();
await loadState();

// Курс подтягиваем при запуске и затем несколько раз в сутки: НБТ публикует
// его раз в день, но сервер может оказаться выключенным в момент публикации.
refreshUsdRate().then((result) => {
  if (result.ok && !result.cached) {
    console.log(`Курс НБТ: 1 $ = ${result.rate.value} TJS (${result.rate.date || 'без даты'})`);
  } else if (!result.ok) {
    console.log(`Курс НБТ не получен: ${result.error}. Работаем с последним сохранённым.`);
  }
});
setInterval(() => { refreshUsdRate().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();
server.listen(PORT, HOST, () => {
  console.log(`Line Design — финансы студии: http://localhost:${PORT}/finance/`);
  if (AUTH_DISABLED) {
    console.log('ВНИМАНИЕ: вход отключён — приложение открыто всем, кто знает адрес.');
  }
  console.log(`Данные хранятся в ${DATA_DIR}`);
});
