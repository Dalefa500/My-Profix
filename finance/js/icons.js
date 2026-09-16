// Иконки интерфейса. Тонкие линии — в тон шрифту, анимация задаётся в CSS.

const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICONS = {
  // Приход: стрелка опускается в лоток
  income: svg(`
    <path class="icon-arrow" d="M12 3v9" />
    <path class="icon-arrow" d="m8.5 8.5 3.5 3.5 3.5-3.5" />
    <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />`),

  // Расход: стрелка выходит из лотка
  expense: svg(`
    <path class="icon-arrow" d="M12 12V3" />
    <path class="icon-arrow" d="m8.5 6.5 3.5-3.5 3.5 3.5" />
    <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />`),

  // Проект: папка с плюсом
  project: svg(`
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path class="icon-plus" d="M12 11v6M9 14h6" />`),

  // Сотрудник: человек с плюсом
  employee: svg(`
    <circle cx="10" cy="8" r="3.2" />
    <path d="M3.5 20c0-3.3 2.9-5.6 6.5-5.6 1.3 0 2.5.3 3.5.8" />
    <path class="icon-plus" d="M17.5 14v6M14.5 17h6" />`),

  // Нижнее меню
  home: svg('<path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5V15h-5v5.5H5A1.5 1.5 0 0 1 3.5 19z" />'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />'),
  people: svg(`
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.5 20c0-3.4 2.9-5.8 6.5-5.8s6.5 2.4 6.5 5.8" />
    <path d="M16.5 5.6a3 3 0 0 1 0 5.8M18 14.6c2 .7 3.5 2.4 3.5 4.6" />`),
  wallet: svg(`
    <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h12a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
    <path d="M16.5 12.5h1.5" />`),
  chart: svg('<path d="M5 20V12M12 20V5M19 20v-6" />'),
  // Клиент — один человек: так вкладка не путается с «Сотрудниками».
  client: svg(`
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20c0-3.9 3.4-6.6 7.5-6.6s7.5 2.7 7.5 6.6" />`),

  // Шапка приложения
  bell: svg(`
    <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3.2.8 4.8 1.5 5.7.4.5 0 1.3-.7 1.3H5.7c-.7 0-1.1-.8-.7-1.3.7-.9 1.5-2.5 1.5-5.7Z" />
    <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />`),
  more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />'),
  back: svg('<path d="M14.5 5.5 8 12l6.5 6.5" />'),
};

// Кнопка быстрого действия с анимированной иконкой.
export function quickAction({ act, icon, label, tone = '', index = 0 }) {
  return `
    <button class="quick__item" data-act="${act}" style="--i:${index}">
      <span class="quick__icon ${tone ? `quick__icon--${tone}` : ''}">${ICONS[icon]}</span>
      <span class="quick__label">${label}</span>
    </button>`;
}
