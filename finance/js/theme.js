// Оформление: тёмное (по умолчанию), светлое или по настройке телефона.
// Выбор хранится в самом устройстве — у каждого может быть свой.

const KEY = 'studio-finance/theme';
export const THEMES = [
  { id: 'dark', label: 'Тёмное' },
  { id: 'light', label: 'Светлое' },
  { id: 'auto', label: 'Как в телефоне' },
];

export function getTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    return THEMES.some((item) => item.id === saved) ? saved : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;

  // Цвет системной полосы статуса подстраивается под тему.
  const dark = theme === 'dark'
    || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.remove();
  }
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = dark ? '#1b1f26' : '#ecf4f7';
  document.head.appendChild(meta);
  return theme;
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* приватный режим — выбор не сохранится */
  }
  return applyTheme(theme);
}
