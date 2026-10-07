// Оформление: тёмное (по умолчанию), светлое или по настройке телефона.
// Выбор хранится в самом устройстве — у каждого может быть свой.

import { BRAND } from './brand.js';

const KEY = `${BRAND.storagePrefix}/theme`;
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
  meta.content = backgroundHex() || (dark ? '#1b1f26' : '#ecf4f7');
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

// Цвет фона страницы в виде #rrggbb — для полосы статуса телефона, чтобы
// она была в тонах своей компании (у Amber — тёплая, а не серо-синяя).
function backgroundHex() {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:0;height:0;background:var(--bg)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    const parts = rgb ? rgb.slice(1, 4).map(Number)
      : srgb ? srgb.slice(1, 4).map((part) => Math.round(Number(part) * 255)) : null;
    return parts ? `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('')}` : '';
  } catch {
    return '';
  }
}
