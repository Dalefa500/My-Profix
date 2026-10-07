// Фирменные данные компании: название, надписи, цвет.
// Сервер вписывает их в страницу (window.__BRAND__) — так экран входа
// сразу показывает нужную студию, ещё до загрузки данных.
// Если страница открыта без сервера, остаётся оформление Line Design.

const FALLBACK = {
  slug: 'line-design',
  companyName: 'Line Design',
  wordmark: 'Line design',
  subtitle: 'Studio',
  tagline: 'Студия дизайна интерьеров',
  initials: 'LD',
  color: '#910029',
  storagePrefix: 'studio-finance',
};

const fromServer = (typeof window !== 'undefined' && window.__BRAND__) || {};

export const BRAND = Object.freeze({ ...FALLBACK, ...fromServer });

// Рукописный шрифт знака умеет только латиницу. Название кириллицей
// показываем обычным шрифтом, иначе буквы были бы разнобойными.
export const WORDMARK_IS_SCRIPT = /^[\x20-\x7E]+$/.test(BRAND.wordmark);
