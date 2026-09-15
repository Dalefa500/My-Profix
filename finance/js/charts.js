// Графики отчётов. Рисуются обычным SVG — без сторонних библиотек,
// чтобы приложение открывалось быстро даже на телефоне.
//
// Цвета взяты из проверенной палитры: они различимы и при дальтонизме,
// а рядом с графиком всегда есть таблица с теми же числами.

import { formatCompact, formatAmount } from './money.js';
import { monthLabel } from './dates.js';
import { esc } from './ui.js';

export const SERIES_COLORS = {
  income: 'var(--series-1)',
  expense: 'var(--series-2)',
  profit: 'var(--series-3)',
};

const PAD = { top: 18, right: 10, bottom: 26, left: 10 };

// Сгруппированные столбцы: доход / расход / прибыль по месяцам.
export function monthlyChart(points, { height = 190 } = {}) {
  if (!points.length) return '';
  const series = [
    { key: 'incomeBase', label: 'Доход', color: SERIES_COLORS.income },
    { key: 'expenseBase', label: 'Расход', color: SERIES_COLORS.expense },
    { key: 'profitBase', label: 'Прибыль', color: SERIES_COLORS.profit },
  ];

  const values = points.flatMap((point) => series.map((item) => point[item.key] || 0));
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  // Система координат фиксирована, SVG масштабируется пропорционально —
  // подписи и скругления не искажаются на широких экранах.
  const width = 320;
  const plotHeight = height - PAD.top - PAD.bottom;
  const groupWidth = (width - PAD.left - PAD.right) / points.length;
  const barGap = 2; // зазор между соседними столбцами
  const barWidth = Math.min(22, Math.max(4, (groupWidth - 10 - barGap * 2) / 3));
  const zeroY = PAD.top + plotHeight * (max / span);

  const bars = points.map((point, index) => {
    const groupX = PAD.left + index * groupWidth + (groupWidth - (barWidth * 3 + barGap * 2)) / 2;
    return series.map((item, seriesIndex) => {
      const value = point[item.key] || 0;
      const x = groupX + seriesIndex * (barWidth + barGap);
      const scaled = Math.abs(value) / span * plotHeight;
      const barHeight = Math.max(value === 0 ? 0 : 1.5, scaled);
      const y = value >= 0 ? zeroY - barHeight : zeroY;
      const tip = `${monthLabel(point.key)} · ${item.label}: ${formatAmount(value)}`;
      return `<rect class="chart__bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}"
        width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="3"
        fill="${item.color}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
    }).join('');
  }).join('');

  const labels = points.map((point, index) => {
    const x = PAD.left + index * groupWidth + groupWidth / 2;
    return `<text class="chart__x" x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle">${
      esc(monthLabel(point.key, { short: true, noYear: true }))}</text>`;
  }).join('');

  const grid = [0.25, 0.5, 0.75].map((step) => {
    const y = PAD.top + plotHeight * step;
    return `<line class="chart__grid" x1="0" x2="${width}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" />`;
  }).join('');

  return `
    <div class="chart" data-chart>
      <svg viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Доход, расход и прибыль по месяцам">
        ${grid}
        <line class="chart__zero" x1="0" x2="${width}" y1="${zeroY.toFixed(2)}" y2="${zeroY.toFixed(2)}" />
        ${bars}
        ${labels}
      </svg>
      <div class="chart__tip" data-chart-tip hidden></div>
      ${legend(series)}
      <p class="chart__scale">Максимум по шкале — ${esc(formatCompact(max))}</p>
    </div>`;
}

function legend(series) {
  return `<div class="legend">${series.map((item) => `
    <span class="legend__item"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('')}</div>`;
}

// Горизонтальные полосы: структура расходов по категориям.
export function breakdownBars(items, { total, emptyText = 'Нет данных за период' } = {}) {
  if (!items.length) return `<p class="muted">${esc(emptyText)}</p>`;
  const max = Math.max(...items.map((item) => item.value), 1);
  const sum = total || items.reduce((acc, item) => acc + item.value, 0) || 1;
  return `<div class="breakdown">${items.map((item) => {
    const share = Math.round(item.value / sum * 100);
    return `<div class="breakdown__row">
      <div class="breakdown__head">
        <span class="breakdown__label">${esc(item.label)}</span>
        <span class="breakdown__value">${esc(formatAmount(item.value))}<i>${share}%</i></span>
      </div>
      <div class="breakdown__track">
        <span class="breakdown__fill" style="width:${(item.value / max * 100).toFixed(1)}%"></span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

// Подсказка при наведении и касании.
export function mountCharts(root) {
  root.querySelectorAll('[data-chart]').forEach((chart) => {
    const tip = chart.querySelector('[data-chart-tip]');
    if (!tip) return;
    const show = (event) => {
      const bar = event.target.closest('[data-tip]');
      if (!bar) return;
      tip.textContent = bar.dataset.tip;
      tip.hidden = false;
      const box = chart.getBoundingClientRect();
      const point = event.touches?.[0] || event;
      const x = Math.min(Math.max(point.clientX - box.left, 60), box.width - 60);
      tip.style.left = `${x}px`;
    };
    const hide = () => { tip.hidden = true; };
    chart.addEventListener('pointerover', show);
    chart.addEventListener('pointermove', show);
    chart.addEventListener('pointerleave', hide);
    chart.addEventListener('focusin', show);
    chart.addEventListener('focusout', hide);
  });
}
