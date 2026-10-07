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
  wordmarkStyle: 'script',
  logo: '',
};

const fromServer = (typeof window !== 'undefined' && window.__BRAND__) || {};

export const BRAND = Object.freeze({ ...FALLBACK, ...fromServer });

// Рукописный шрифт знака умеет только латиницу. Название кириллицей
// показываем обычным шрифтом, иначе буквы были бы разнобойными.
export const WORDMARK_IS_SCRIPT = BRAND.wordmarkStyle !== 'caps' && /^[\x20-\x7E]+$/.test(BRAND.wordmark);

// Класс надписи: рукописная, прописными с разрядкой или обычным шрифтом.
export const WORDMARK_CLASS = BRAND.wordmarkStyle === 'caps' ? 'is-caps' : (WORDMARK_IS_SCRIPT ? '' : 'is-plain');

// Логотип компании вставляем в страницу как SVG (а не картинкой), чтобы
// работала анимация и цвета подстраивались под светлую и тёмную тему.
// Последний загруженный логотип: при смене экрана (загрузка → ввод кода)
// вставляем его сразу, без повторной загрузки и мигания.
let cachedLogo = '';

export async function mountLogo(root) {
  const host = root?.querySelector('[data-logo]');
  if (!host || !BRAND.logo) return;
  if (cachedLogo) {
    host.innerHTML = cachedLogo;
    host.classList.add('is-kept', 'is-ready');
    return;
  }
  try {
    const response = await fetch(BRAND.logo, { credentials: 'same-origin' });
    if (!response.ok) return;
    const text = await response.text();
    if (!text.trim().startsWith('<svg')) return;
    host.innerHTML = text;
    // «Уменьшить движение» в настройках телефона — блик не бегает.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      host.querySelectorAll('.amber-anim, animate, animateTransform').forEach((node) => node.remove());
    }
    cachedLogo = host.innerHTML;
    host.classList.add('is-ready');
  } catch {
    /* без логотипа экран входа остаётся с названием */
  }
}
