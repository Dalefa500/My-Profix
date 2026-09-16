// Открытие отчёта в PDF.
//
// Файл собирает сервер и отдаёт как обычный документ. На телефоне он
// открывается во встроенном просмотрщике, откуда его можно переслать
// клиенту или сотруднику через «Поделиться».

import { toast } from './ui.js';

export function reportUrl(params) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
  return `/api/report?${query}`;
}

export function openReport(params) {
  const url = reportUrl(params);
  // Отдельная вкладка: из неё работает системная кнопка «Поделиться»,
  // а приложение остаётся открытым на прежнем месте.
  const opened = window.open(url, '_blank');
  if (!opened) {
    // Если открытие вкладок запрещено, показываем документ на месте.
    toast('Открываем отчёт…');
    window.location.href = url;
  }
}
