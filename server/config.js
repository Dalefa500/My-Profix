// Настройки конкретной компании. Одна и та же программа может работать
// у нескольких студий на одном сервере — каждая копия получает свои
// значения через переменные окружения (файл /etc/<slug>/app.env, его
// подключает служба systemd).
//
// Если переменная не задана, берётся значение первой студии — Line Design,
// поэтому уже работающая установка ведёт себя ровно как раньше.

const env = process.env;

function clean(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

// Цвет в формате #rrggbb. Ошибочное значение не должно сломать оформление.
function color(value, fallback) {
  const text = clean(value, fallback);
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

// Короткое латинское имя копии: из него строятся ключи в браузере,
// имя куки и подпись службы. Только буквы, цифры и дефис.
function slug(value, fallback) {
  const text = clean(value, fallback).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

// Учётные записи, которые создаются при самом первом запуске:
// «логин:Имя:роль» через запятую. Роль — admin или viewer.
function users(value) {
  const text = clean(value, 'shohin:Шохин:admin,rizvon:Ризвон:viewer');
  const list = text.split(',').map((item) => {
    const [login, name, role] = item.split(':').map((part) => (part || '').trim());
    return {
      login: (login || '').toLowerCase(),
      name: name || login,
      role: role === 'viewer' ? 'viewer' : 'admin',
    };
  }).filter((item) => /^[a-z0-9._-]{2,32}$/.test(item.login));
  // Без хотя бы одного администратора приложением нельзя будет управлять.
  if (!list.some((item) => item.role === 'admin') && list.length) list[0].role = 'admin';
  return list.length ? list : [{ login: 'admin', name: 'Администратор', role: 'admin' }];
}

const APP_SLUG = slug(env.APP_SLUG, 'line-design');
const DEFAULT = APP_SLUG === 'line-design';
const COMPANY = clean(env.COMPANY_NAME, 'Line Design');

// Буквы для значка: первые буквы первых двух слов названия.
function initialsOf(name) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]);
  return (letters.join('') || 'F').toUpperCase();
}

export const config = Object.freeze({
  slug: APP_SLUG,
  companyName: COMPANY,
  // Надпись в шапке и на экране входа. Рукописный шрифт знака — латинский:
  // кириллица в нём будет показана обычным шрифтом.
  wordmark: clean(env.BRAND_WORDMARK, DEFAULT ? 'Line design' : COMPANY),
  // Подпись под знаком на экране входа. У Line Design — «Studio»;
  // у остальных по умолчанию пусто, чтобы не было английского слова под русским названием.
  subtitle: clean(env.BRAND_SUBTITLE, DEFAULT ? 'Studio' : ''),
  tagline: clean(env.BRAND_TAGLINE, 'Студия дизайна интерьеров'),
  initials: clean(env.BRAND_INITIALS, DEFAULT ? 'LD' : initialsOf(COMPANY)).slice(0, 3),
  color: color(env.BRAND_COLOR, '#910029'),
  // Своя кука у каждой копии — чтобы вход в одну студию никогда не
  // пересекался со входом в другую, даже если они откроются на одном адресе.
  cookie: DEFAULT ? 'sf_session' : `sf_${APP_SLUG.replace(/-/g, '_')}`,
  // Ключи хранилища в браузере. У Line Design остаются прежними,
  // чтобы на телефонах ничего не сбросилось.
  storagePrefix: DEFAULT ? 'studio-finance' : `studio-finance-${APP_SLUG}`,
  bootstrapUsers: users(env.BOOTSTRAP_USERS),
  // Папка с логотипом и иконками именно этой компании (icon-180.png,
  // icon-192.png, icon-512.png). Если её нет — берутся иконки из программы.
  brandDir: clean(env.BRAND_DIR, ''),
});

// То, что можно показать браузеру ещё до входа: экран входа, заголовок,
// иконка. Ничего секретного здесь нет.
export function publicConfig() {
  return {
    slug: config.slug,
    companyName: config.companyName,
    wordmark: config.wordmark,
    subtitle: config.subtitle,
    tagline: config.tagline,
    initials: config.initials,
    color: config.color,
    storagePrefix: config.storagePrefix,
  };
}
