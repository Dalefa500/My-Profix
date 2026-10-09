// Отчёты в PDF: по сотруднику, клиенту, проекту и за период.
//
// Считаются теми же формулами, что и экраны приложения (finance/js/calc.js),
// поэтому цифры в отчёте и на телефоне всегда совпадают.

import { config } from './config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Pdf, PAGE } from './pdf.js';
import { formatAmount, formatUsdRate, rateToHuman, usdRate } from '../finance/js/money.js';
import { formatDate, monthLabel, inRange, today as todayLocal } from '../finance/js/dates.js';
import {
  categoryLabel, labelOf, PROJECT_STATUSES, INCOME_TYPES, PAYMENT_METHODS, BARTER_KINDS,
  FOUNDER_MOVES,
} from '../finance/js/model.js';
import {
  employeeFinance, clientFinance, projectFinance,
  projectIncomes, periodTotals, employeePayrolls,
  payrollState, projectPlan, founderState, foundersSummary,
  clientBarters, barterTotals,
} from '../finance/js/calc.js';

const FONT_DIR = path.resolve(new URL('./fonts', import.meta.url).pathname);
const FONTS = {
  regular: readFileSync(path.join(FONT_DIR, 'LiberationSans-Regular.ttf')),
  bold: readFileSync(path.join(FONT_DIR, 'LiberationSans-Bold.ttf')),
};

const MARGIN = 40;
const CONTENT = PAGE.width - MARGIN * 2;
const BOTTOM = PAGE.height - 56;

const INK = [0.14, 0.16, 0.2];
const MUTED = [0.47, 0.51, 0.56];
// Фирменный цвет компании (у Line Design — бордовый).
const BURGUNDY = hexToRgb(config.color);

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => Math.round(v * 100) / 100);
}
const GOOD = [0.08, 0.47, 0.35];
const LINE = [0.85, 0.88, 0.9];

const money = (value) => formatAmount(value, 'USD', { decimals: 2 });

// Лист отчёта: шапка, подвал, курсор по вертикали и перенос на новую страницу.
class Sheet {
  constructor({ title, subtitle, settings }) {
    this.doc = new Pdf({ ...FONTS, title, author: settings.companyName || config.companyName });
    this.title = title;
    this.subtitle = subtitle;
    this.settings = settings;
    this.pageNumber = 0;
    this.startPage();
  }

  startPage() {
    this.pageNumber += 1;
    if (this.pageNumber > 1) this.doc.addPage();
    const doc = this.doc;

    doc.text(MARGIN, 52, doc.fit(this.settings.companyName || config.companyName, 17, CONTENT - 70, 'bold'), {
      size: 17, font: 'bold', color: BURGUNDY,
    });
    doc.text(MARGIN, 66, doc.fit(config.tagline.toUpperCase(), 6.5, CONTENT - 70), { size: 6.5, color: MUTED });
    doc.text(MARGIN, 52, `Лист ${this.pageNumber}`, {
      size: 8.5, color: MUTED, align: 'right', width: CONTENT,
    });

    doc.text(MARGIN, 92, doc.fit(this.title, 15, CONTENT, 'bold'), { size: 15, font: 'bold', color: INK });
    if (this.subtitle) doc.text(MARGIN, 110, doc.fit(this.subtitle, 10, CONTENT), { size: 10, color: MUTED });
    doc.line(MARGIN, 122, MARGIN + CONTENT, 122, { color: BURGUNDY, width: 1.2 });

    doc.text(MARGIN, BOTTOM + 24, `Сформировано ${formatDate(todayIso())} · курс ${formatUsdRate(usdRate(this.settings))}`, {
      size: 8, color: MUTED,
    });
    doc.text(MARGIN, BOTTOM + 24, 'Все суммы в долларах США', {
      size: 8, color: MUTED, align: 'right', width: CONTENT,
    });
    this.y = 146;
  }

  need(height) {
    if (this.y + height > BOTTOM) this.startPage();
  }

  gap(height = 12) {
    this.y += height;
  }

  heading(text) {
    // Место под заголовок, шапку таблицы и хотя бы одну строку — чтобы
    // заголовок не остался один внизу листа.
    this.need(84);
    this.gap(6);
    this.doc.text(MARGIN, this.y, this.doc.fit(text, 11, CONTENT, 'bold'), { size: 11, font: 'bold', color: INK });
    this.y += 6;
    this.doc.line(MARGIN, this.y, MARGIN + CONTENT, this.y, { color: LINE });
    this.y += 16;
  }

  // Крупные итоги в рамке: то, ради чего отчёт обычно и открывают.
  totals(items) {
    const height = 48;
    this.need(height + 10);
    const width = CONTENT / items.length;
    this.doc.rect(MARGIN, this.y - 12, CONTENT, height, { color: [0.96, 0.97, 0.98] });
    items.forEach((item, index) => {
      const x = MARGIN + width * index + 12;
      this.doc.text(x, this.y + 2, this.doc.fit(item.label, 8, width - 16), { size: 8, color: MUTED });
      // Сумму не обрезаем — уменьшаем шрифт, пока не поместится.
      const text = money(item.value);
      let size = 13;
      while (size > 7 && this.doc.widthOf(text, size, 'bold') > width - 16) size -= 0.5;
      this.doc.text(x, this.y + 20, text, {
        size, font: 'bold', color: item.color || INK,
      });
    });
    this.y += height + 8;
  }

  // Строка «подпись — значение».
  pair(label, value, options = {}) {
    this.need(18);
    this.doc.text(MARGIN, this.y, this.doc.fit(label, 9.5, CONTENT * 0.4), { size: 9.5, color: MUTED });
    this.doc.text(MARGIN, this.y, this.doc.fit(value ?? '—', 9.5, CONTENT * 0.58, options.font), {
      size: 9.5, color: options.color || INK, font: options.font || 'regular',
      align: 'right', width: CONTENT,
    });
    this.y += 16;
    this.doc.line(MARGIN, this.y - 5, MARGIN + CONTENT, this.y - 5, { color: [0.93, 0.95, 0.96] });
  }

  // Таблица: columns = [{ title, width, align }], rows = массив массивов.
  table(columns, rows, options = {}) {
    if (!rows.length) {
      this.need(22);
      this.doc.text(MARGIN, this.y, options.empty || 'Записей нет', { size: 9.5, color: MUTED });
      this.y += 20;
      return;
    }
    const total = columns.reduce((acc, column) => acc + column.width, 0);
    const scale = CONTENT / total;
    const widths = columns.map((column) => column.width * scale);

    const header = () => {
      this.doc.rect(MARGIN, this.y - 11, CONTENT, 20, { color: [0.95, 0.96, 0.97] });
      let x = MARGIN;
      columns.forEach((column, index) => {
        this.doc.text(x + 6, this.y + 2, column.title, {
          size: 8, font: 'bold', color: MUTED,
          align: column.align || 'left', width: widths[index] - 12,
        });
        x += widths[index];
      });
      this.y += 22;
    };

    this.need(50);
    header();
    for (const row of rows) {
      if (this.y + 18 > BOTTOM) {
        this.startPage();
        header();
      }
      let x = MARGIN;
      row.forEach((cell, index) => {
        const value = cell && typeof cell === 'object' ? cell : { text: cell };
        const room = widths[index] - 12;
        // Числа в колонках справа не обрезаем «…» — пропавшая цифра даёт
        // неверную сумму. Вместо этого уменьшаем шрифт.
        let size = 9;
        if (columns[index].align === 'right') {
          while (size > 6 && this.doc.widthOf(value.text, size, value.font) > room) size -= 0.5;
        }
        this.doc.text(x + 6, this.y, this.doc.fit(value.text, size, room, value.font), {
          size, color: value.color || INK, font: value.font || 'regular',
          align: columns[index].align || 'left', width: widths[index] - 12,
        });
        x += widths[index];
      });
      this.y += 17;
      this.doc.line(MARGIN, this.y - 5, MARGIN + CONTENT, this.y - 5, { color: [0.93, 0.95, 0.96] });
    }
    this.y += 6;
  }

  note(text) {
    const lines = this.doc.wrap(text, 8.5, CONTENT, { maxLines: 8 });
    this.need(14 + lines.length * 12);
    this.gap(4);
    for (const line of lines) {
      this.doc.text(MARGIN, this.y, line, { size: 8.5, color: MUTED });
      this.y += 12;
    }
    this.y += 2;
  }

  build() {
    return this.doc.build();
  }
}

// Площадь: «84,5 м²», без «undefined» и с запятой, как принято.
function area(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number)} м²`;
}

function todayIso() {
  return todayLocal();
}

function statusLabel(status) {
  return labelOf(PROJECT_STATUSES, status, 'Новый');
}

// Имя файла: понятное человеку, но без символов, которые ломают вложения.
function fileName(parts) {
  const base = parts.filter(Boolean).join(' - ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base}.pdf`;
}

// ------------------------------------------------------------- сотрудник

function employeeReport(state, employee) {
  const finance = employeeFinance(state, employee);
  const pay = employee.payType === 'fixed'
    ? `${formatAmount(employee.salary, employee.salaryCurrency)} в месяц`
    : employee.payType === 'percent'
      ? `${employee.percent ?? 50}% от суммы проекта`
      : `${formatAmount(employee.rate, employee.rateCurrency)} за м²`;

  const sheet = new Sheet({
    title: `Отчёт по сотруднику — ${employee.name || 'без имени'}`,
    subtitle: [employee.position, pay].filter(Boolean).join(' · '),
    settings: state.settings,
  });

  sheet.totals([
    { label: 'Начислено', value: finance.accruedBase },
    { label: 'Выплачено', value: finance.paidBase, color: GOOD },
    { label: 'К выплате сейчас', value: finance.dueNowBase, color: BURGUNDY },
    { label: 'Ждёт согласования', value: finance.lockedBase },
  ]);

  if (finance.type !== 'fixed' || finance.rows.length) {
    sheet.heading('Работа по проектам');
    sheet.table(
      [
        { title: 'Проект', width: 118 },
        { title: 'Площадь', width: 48, align: 'right' },
        { title: 'Ставка', width: 50, align: 'right' },
        { title: 'Начислено', width: 66, align: 'right' },
        { title: 'Выплачено', width: 66, align: 'right' },
        { title: 'Остаток', width: 66, align: 'right' },
        { title: 'Состояние', width: 100 },
      ],
      finance.rows.map((row) => [
        row.project?.name || 'Без проекта',
        row.state.mode === 'percent' ? '—' : area(row.assignment.area),
        row.state.mode === 'percent' ? `${row.state.percent}%` : formatAmount(row.assignment.rate, row.assignment.currency),
        money(row.state.accruedBase),
        { text: money(row.state.paidBase), color: GOOD },
        { text: money(row.state.owedBase), color: row.state.owedBase > 0 ? BURGUNDY : MUTED },
        row.state.label,
      ]),
      { empty: 'Сотрудник пока не назначен ни на один проект' },
    );
    sheet.note(finance.rows.some((row) => row.state.mode === 'percent')
      ? 'Доля от суммы проекта выплачивается по мере оплаты клиентом; остаток сдельной оплаты — после одобрения работы клиентом.'
      : 'Остаток сдельной оплаты выплачивается после того, как клиент одобрил работу по проекту.');
  }
  if (finance.type === 'fixed' || finance.payrolls.length) {
    sheet.heading('Начисления по месяцам');
    sheet.table(
      [
        { title: 'Месяц', width: 110 },
        { title: 'Начислено', width: 80, align: 'right' },
        { title: 'Выплачено', width: 80, align: 'right' },
        { title: 'Остаток', width: 80, align: 'right' },
        { title: 'Срок выплаты', width: 90, align: 'right' },
      ],
      employeePayrolls(state, employee.id).map((payroll) => {
        const info = payrollState(payroll);
        return [
          monthLabel(payroll.month),
          money(payroll.accruedBase),
          { text: money(info.paidBase), color: GOOD },
          { text: money(info.leftBase), color: info.leftBase > 0 ? BURGUNDY : MUTED },
          formatDate(payroll.dueDate, { short: true }),
        ];
      }),
      { empty: 'Начислений пока нет' },
    );
  }

  const payments = state.expenses
    .filter((item) => item.employeeId === employee.id
      || finance.rows?.some((row) => row.assignment.id === item.assignmentId))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  sheet.heading('Выплаты');
  sheet.table(
    [
      { title: 'Дата', width: 62 },
      { title: 'Назначение', width: 240 },
      { title: 'Сумма', width: 80, align: 'right' },
      { title: 'Введено', width: 80, align: 'right' },
    ],
    payments.map((item) => [
      formatDate(item.date, { short: true }),
      item.comment || categoryLabel(item.category, state.settings),
      { text: money(item.base), font: 'bold' },
      item.currency === 'USD' ? '—' : formatAmount(item.amount, item.currency),
    ]),
    { empty: 'Выплат пока не было' },
  );

  return { buffer: sheet.build(), name: fileName(['Отчёт', employee.name, todayIso()]) };
}

// ---------------------------------------------------------------- клиент

function clientReport(state, client) {
  const finance = clientFinance(state, client.id);
  const sheet = new Sheet({
    title: `Отчёт по клиенту — ${client.name || 'без имени'}`,
    subtitle: [client.phone, client.email].filter(Boolean).join(' · '),
    settings: state.settings,
  });

  sheet.totals([
    { label: 'Сумма договоров', value: finance.contractBase },
    { label: 'Получено', value: finance.receivedBase, color: GOOD },
    { label: 'Остаток к оплате', value: finance.toReceiveBase, color: BURGUNDY },
  ]);

  sheet.heading('Проекты');
  sheet.table(
    [
      { title: 'Проект', width: 140 },
      { title: 'Адрес', width: 96 },
      { title: 'Статус', width: 96 },
      { title: 'Стоимость', width: 78, align: 'right' },
      { title: 'Получено', width: 78, align: 'right' },
      { title: 'Остаток', width: 78, align: 'right' },
    ],
    finance.projects.map((project) => {
      const info = projectFinance(state, project);
      return [
        project.name,
        project.address || '—',
        statusLabel(project.status),
        money(info.contractBase),
        { text: money(info.receivedBase), color: GOOD },
        { text: money(info.toReceiveBase), color: info.toReceiveBase > 0 ? BURGUNDY : MUTED },
      ];
    }),
    { empty: 'У клиента пока нет проектов' },
  );

  const barters = clientBarters(state, client.id);
  if (barters.length) {
    sheet.heading('Взаиморасчёты');
    sheet.table(
      [
        { title: 'Что передано', width: 180 },
        { title: 'Вид', width: 90 },
        { title: 'Оценка', width: 80, align: 'right' },
        { title: 'Отработано', width: 80, align: 'right' },
        { title: 'Осталось', width: 80, align: 'right' },
      ],
      barters.map((row) => [
        row.barter.title,
        labelOf(BARTER_KINDS, row.barter.kind, 'Имущество'),
        money(row.totalBase),
        { text: money(row.usedBase), color: GOOD },
        { text: money(row.leftBase), color: row.done ? MUTED : BURGUNDY },
      ]),
    );
    sheet.note('Клиент рассчитывается имуществом: стоимость выполненных работ'
      + ' списывается с его оценки.');

    // Этапы по каждому имуществу: что списано и сколько после этого осталось.
    for (const row of barters.filter((item) => item.stages.length)) {
      sheet.heading(`Этапы — ${row.barter.title}`);
      sheet.table(
        [
          { title: 'Дата', width: 70 },
          { title: 'Работы', width: 250 },
          { title: 'Списано', width: 90, align: 'right' },
          { title: 'Осталось', width: 90, align: 'right' },
        ],
        row.stages.map((stage) => [
          formatDate(stage.income.date, { short: true }),
          stage.income.comment
            || state.projects.find((item) => item.id === stage.income.projectId)?.name
            || 'Выполненные работы',
          { text: money(stage.income.base), color: GOOD },
          { text: money(Math.max(0, stage.leftAfterBase)), font: 'bold' },
        ]),
      );
    }
  }

  const incomes = state.incomes
    .filter((item) => item.clientId === client.id
      || finance.projects.some((project) => project.id === item.projectId))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  sheet.heading('Поступления');
  sheet.table(
    [
      { title: 'Дата', width: 62 },
      { title: 'Назначение', width: 200 },
      { title: 'Тип', width: 90 },
      { title: 'Сумма', width: 80, align: 'right' },
    ],
    incomes.map((item) => [
      formatDate(item.date, { short: true }),
      item.comment || (state.projects.find((p) => p.id === item.projectId)?.name ?? 'Без проекта'),
      labelOf(INCOME_TYPES, item.type, 'Прочий доход'),
      { text: money(item.base), font: 'bold', color: GOOD },
    ]),
    { empty: 'Поступлений пока не было' },
  );

  return { buffer: sheet.build(), name: fileName(['Отчёт', client.name, todayIso()]) };
}

// ---------------------------------------------------------------- проект

function projectReport(state, project) {
  const finance = projectFinance(state, project);
  const client = state.clients.find((item) => item.id === project.clientId);
  const sheet = new Sheet({
    title: `Отчёт по проекту — ${project.name || 'без названия'}`,
    subtitle: [client?.name, project.address, project.area ? area(project.area) : '']
      .filter(Boolean).join(' · '),
    settings: state.settings,
  });

  sheet.totals([
    { label: 'Стоимость', value: finance.contractBase },
    { label: 'Получено', value: finance.receivedBase, color: GOOD },
    { label: 'Осталось получить', value: finance.toReceiveBase, color: BURGUNDY },
    { label: 'Прибыль (план)', value: finance.profitPlanBase },
  ]);

  sheet.heading('Условия');
  sheet.pair('Статус', statusLabel(project.status));
  sheet.pair('Начало работ', project.startDate ? formatDate(project.startDate) : '—');
  sheet.pair('Срок сдачи', project.dueDate ? formatDate(project.dueDate) : '—');
  if (project.currency && project.currency !== 'USD' && Number(project.fx) > 0) {
    sheet.pair('Стоимость в договоре', `${formatAmount(project.price, project.currency)}`
      + ` по курсу ${formatUsdRate(rateToHuman(project.fx))}`);
  }

  sheet.heading('План поступлений');
  sheet.table(
    [
      { title: 'Платёж', width: 160 },
      { title: 'Срок', width: 80 },
      { title: 'Сумма', width: 80, align: 'right' },
      { title: 'Закрыто', width: 80, align: 'right' },
      { title: 'Осталось', width: 80, align: 'right' },
    ],
    // Тот же план, что в карточке проекта (долг — в валюте договора,
    // у отменённого проекта ждать нечего).
    finance.plan.map((item) => [
      item.title || (item.type === 'advance' ? 'Аванс' : 'Остаток'),
      item.dueDate ? formatDate(item.dueDate, { short: true }) : '—',
      money(item.base),
      { text: money(item.coveredBase), color: GOOD },
      { text: money(item.leftBase), color: item.leftBase > 0 ? BURGUNDY : MUTED },
    ]),
    { empty: 'План поступлений не задан' },
  );

  sheet.heading('Сотрудники на проекте');
  sheet.table(
    [
      { title: 'Сотрудник', width: 140 },
      { title: 'Роль', width: 90 },
      { title: 'Площадь', width: 55, align: 'right' },
      { title: 'Ставка', width: 55, align: 'right' },
      { title: 'Начислено', width: 75, align: 'right' },
      { title: 'Выплачено', width: 75, align: 'right' },
    ],
    finance.assignments.map((assignment, index) => {
      const info = finance.assignmentStates[index];
      const employee = state.employees.find((item) => item.id === assignment.employeeId);
      return [
        employee?.name || 'Сотрудник',
        assignment.role || '—',
        info.mode === 'percent' ? '—' : area(assignment.area),
        info.mode === 'percent' ? `${info.percent}%` : formatAmount(assignment.rate, assignment.currency),
        money(info.accruedBase),
        { text: money(info.paidBase), color: GOOD },
      ];
    }),
    { empty: 'Сотрудники на проект не назначены' },
  );

  sheet.heading('Движение денег по проекту');
  // Здесь показываем всё, что прошло по проекту, включая выплаты сотрудникам:
  // в прибыль они входят через начисления, но в движении денег их нужно видеть.
  const moves = [
    ...projectIncomes(state, project.id).map((item) => ({ ...item, kind: 'income' })),
    ...state.expenses.filter((item) => item.projectId === project.id)
      .map((item) => ({ ...item, kind: 'expense' })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  sheet.table(
    [
      { title: 'Дата', width: 62 },
      { title: 'Операция', width: 240 },
      { title: 'Приход', width: 80, align: 'right' },
      { title: 'Расход', width: 80, align: 'right' },
    ],
    moves.map((item) => [
      formatDate(item.date, { short: true }),
      item.comment || (item.kind === 'income'
        ? labelOf(INCOME_TYPES, item.type, 'Поступление')
        : categoryLabel(item.category, state.settings)),
      item.kind === 'income' ? { text: money(item.base), color: GOOD } : '',
      item.kind === 'expense' ? { text: money(item.base), color: BURGUNDY } : '',
    ]),
    { empty: 'Операций по проекту пока нет' },
  );

  sheet.note('Прибыль проекта считается как стоимость за вычетом оплаты сотрудников и прямых расходов.'
    + ' Общие расходы студии в неё не входят.');

  return { buffer: sheet.build(), name: fileName(['Отчёт', project.name, todayIso()]) };
}

// --------------------------------------------------------------- коллега

function founderReport(state, founder, from, to) {
  const info = founderState(state, founder, from, to);
  const period = from && to;
  const sheet = new Sheet({
    title: `Отчёт по коллеге — ${founder.name || 'без имени'}`,
    subtitle: [founder.role, period ? `${formatDate(from)} — ${formatDate(to)}` : 'за всё время']
      .filter(Boolean).join(' · '),
    settings: state.settings,
  });

  // За всё время второй строкой показываем, только когда первая — за период.
  sheet.totals([
    ...(period ? [{ label: 'Взял за период', value: info.periodBase }] : []),
    { label: period ? 'Взял за всё время' : 'Взял всего', value: info.takenBase, color: BURGUNDY },
    { label: 'Вложил в студию', value: info.investedBase, color: GOOD },
    { label: 'Оплатил в долг', value: info.spentBase },
    { label: 'Студия должна', value: info.owedBase, color: info.owedBase > 0 ? BURGUNDY : MUTED },
  ]);

  sheet.heading('Операции');
  sheet.table(
    [
      { title: 'Дата', width: 62 },
      { title: 'Что произошло', width: 110 },
      { title: 'Назначение', width: 180 },
      { title: 'Чем', width: 70 },
      { title: 'Сумма', width: 75, align: 'right' },
    ],
    (period ? info.periodDraws : info.draws).map((item) => {
      const kind = item.kind || 'draw';
      return [
        formatDate(item.date, { short: true }),
        labelOf(FOUNDER_MOVES, kind, 'Взял для себя'),
        item.comment || (item.category ? categoryLabel(item.category, state.settings)
          : kind === 'invest' ? 'Деньгами в кассу' : '—'),
        labelOf(PAYMENT_METHODS, item.method, 'Наличные'),
        { text: money(item.base), font: 'bold', color: kind === 'spend' || kind === 'invest' ? GOOD : INK },
      ];
    }),
    { empty: 'Операций за этот период не было' },
  );

  sheet.note('Деньги, которые коллега берёт для себя, — это его доля прибыли,'
    + ' на прибыль студии они не влияют. Расходы, оплаченные его деньгами в долг,'
    + ' входят в расходы студии, и на их сумму студия остаётся ему должна.'
    + ' Вклад в студию не возвращается: если им оплачен расход, он входит в расходы студии.');

  return { buffer: sheet.build(), name: fileName(['Отчёт', founder.name, todayIso()]) };
}

// ----------------------------------------------------------------- период

function periodReport(state, from, to) {
  const totals = periodTotals(state, from, to);
  const sheet = new Sheet({
    title: 'Отчёт за период',
    subtitle: `${formatDate(from)} — ${formatDate(to)}`,
    settings: state.settings,
  });

  sheet.totals([
    { label: 'Доход', value: totals.incomeBase, color: GOOD },
    { label: 'Расход', value: totals.expenseBase, color: BURGUNDY },
    { label: 'Прибыль', value: totals.profitBase },
    // Изъятия коллег — не расход, но из общей суммы они уходят.
    ...(totals.drawBase > 0 ? [{ label: 'Коллеги взяли', value: totals.drawBase, color: BURGUNDY }] : []),
    ...(totals.investBase > 0 ? [{ label: 'Учредители вложили', value: totals.investBase, color: GOOD }] : []),
    ...(totals.drawBase > 0 || totals.investBase > 0 ? [{ label: 'Осталось в студии', value: totals.leftBase }] : []),
  ]);

  if (totals.incomeBarterBase > 0) {
    sheet.note(`Из дохода ${money(totals.incomeBarterBase)} получено взаимозачётом —`
      + ` деньгами пришло ${money(totals.incomeCashBase)}.`);
  }

  sheet.heading('Доходы по типам');
  sheet.table(
    [{ title: 'Тип поступления', width: 300 }, { title: 'Сумма', width: 100, align: 'right' }],
    [...totals.incomeByType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, value]) => [
        labelOf(INCOME_TYPES, type, 'Прочий доход'),
        { text: money(value), font: 'bold', color: GOOD },
      ]),
    { empty: 'Поступлений за период не было' },
  );

  sheet.heading('Расходы по категориям');
  sheet.table(
    [{ title: 'Категория', width: 300 }, { title: 'Сумма', width: 100, align: 'right' }],
    [...totals.expenseByCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, value]) => [
        categoryLabel(category, state.settings),
        { text: money(value), font: 'bold', color: BURGUNDY },
      ]),
    { empty: 'Расходов за период не было' },
  );

  const partners = foundersSummary(state, from, to);
  if (partners.rows.length && (partners.periodBase > 0 || partners.owedBase > 0)) {
    sheet.heading('Коллеги взяли из кассы');
    sheet.table(
      [
        { title: 'Коллега', width: 170 },
        { title: 'Взял за период', width: 90, align: 'right' },
        { title: 'Взял всего', width: 80, align: 'right' },
        { title: 'Студия должна', width: 90, align: 'right' },
      ],
      partners.rows.map((row) => [
        row.founder.name,
        { text: money(row.periodBase), font: 'bold' },
        { text: money(row.takenBase), color: MUTED },
        { text: money(row.owedBase), color: row.owedBase > 0 ? BURGUNDY : MUTED },
      ]),
    );
    sheet.note('Доля прибыли, а не расход студии: в расходы выше не входят, но из общей суммы вычтены — см. «Осталось в студии».');
  }

  const barters = barterTotals(state);
  if (barters.rows.length) {
    sheet.heading('Расчёты имуществом');
    sheet.table(
      [
        { title: 'Что передано', width: 200 },
        { title: 'Клиент', width: 120 },
        { title: 'Оценка', width: 80, align: 'right' },
        { title: 'Осталось', width: 80, align: 'right' },
      ],
      barters.rows.map((row) => [
        row.barter.title,
        state.clients.find((item) => item.id === row.barter.clientId)?.name || '—',
        money(row.totalBase),
        { text: money(row.leftBase), color: row.done ? MUTED : BURGUNDY },
      ]),
    );
  }

  sheet.heading('Все операции периода');
  const moves = [
    ...state.incomes.filter((item) => inRange(item.date, from, to)).map((item) => ({ ...item, kind: 'income' })),
    ...state.expenses.filter((item) => inRange(item.date, from, to)).map((item) => ({ ...item, kind: 'expense' })),
    // Коллега взял себе или студия вернула ему долг — деньги ушли из кассы.
    ...(state.draws || [])
      .filter((item) => (item.kind || 'draw') !== 'spend' && inRange(item.date, from, to))
      .map((item) => {
        const name = state.founders.find((f) => f.id === item.founderId)?.name || 'Коллега';
        return {
          ...item,
          // Деньги ушли из кассы, но это не расход студии: в столбец «Расход»
          // не ставим (его сумма должна совпадать с итогом расходов).
          kind: 'colleague',
          // Своя подпись коллеги («На отпуск») не теряется — дописывается.
          comment: `${(item.kind || 'draw') === 'repay' ? `Вернули долг: ${name}`
            : item.kind === 'invest' ? `${name} вложил в студию` : `${name} взял себе`}${item.comment ? ` · ${item.comment}` : ''} · ${money(item.base)}, ${item.kind === 'invest' ? 'не доход' : 'не расход'}`,
          projectId: null,
        };
      }),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  sheet.table(
    [
      { title: 'Дата', width: 62 },
      { title: 'Операция', width: 200 },
      { title: 'Проект', width: 110 },
      { title: 'Приход', width: 70, align: 'right' },
      { title: 'Расход', width: 70, align: 'right' },
    ],
    moves.map((item) => [
      formatDate(item.date, { short: true }),
      item.comment || (item.kind === 'income'
        ? labelOf(INCOME_TYPES, item.type, 'Поступление')
        : categoryLabel(item.category, state.settings)),
      state.projects.find((p) => p.id === item.projectId)?.name || '—',
      item.kind === 'income' ? { text: money(item.base), color: GOOD } : '',
      item.kind === 'expense' ? { text: money(item.base), color: BURGUNDY } : '',
    ]),
    { empty: 'Операций за период не было' },
  );

  return { buffer: sheet.build(), name: fileName(['Отчёт за период', `${from} — ${to}`]) };
}

// ------------------------------------------------------------------ точка входа

export function buildReport(state, { type, id, from, to }) {
  if (type === 'employee') {
    const employee = state.employees.find((item) => item.id === id);
    if (!employee) return null;
    return employeeReport(state, employee);
  }
  if (type === 'client') {
    const client = state.clients.find((item) => item.id === id);
    if (!client) return null;
    return clientReport(state, client);
  }
  if (type === 'project') {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return null;
    return projectReport(state, project);
  }
  if (type === 'founder') {
    const founder = state.founders.find((item) => item.id === id);
    if (!founder) return null;
    return founderReport(state, founder, from, to);
  }
  if (type === 'period') {
    if (!from || !to) return null;
    return periodReport(state, from, to);
  }
  return null;
}
