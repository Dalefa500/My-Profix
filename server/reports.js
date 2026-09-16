// Отчёты в PDF: по сотруднику, клиенту, проекту и за период.
//
// Считаются теми же формулами, что и экраны приложения (finance/js/calc.js),
// поэтому цифры в отчёте и на телефоне всегда совпадают.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Pdf, PAGE } from './pdf.js';
import { formatAmount, formatUsdRate, rateToHuman } from '../finance/js/money.js';
import { formatDate, monthLabel, inRange } from '../finance/js/dates.js';
import { categoryLabel, labelOf, PROJECT_STATUSES, INCOME_TYPES } from '../finance/js/model.js';
import {
  employeeFinance, clientFinance, projectFinance,
  projectIncomes, periodTotals, employeePayrolls,
  payrollState, projectPlan,
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
const BURGUNDY = [0.57, 0.0, 0.16];
const GOOD = [0.08, 0.47, 0.35];
const LINE = [0.85, 0.88, 0.9];

const money = (value) => formatAmount(value, 'USD', { decimals: 2 });

// Лист отчёта: шапка, подвал, курсор по вертикали и перенос на новую страницу.
class Sheet {
  constructor({ title, subtitle, settings }) {
    this.doc = new Pdf({ ...FONTS, title, author: settings.companyName || 'Line Design' });
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

    doc.text(MARGIN, 52, this.settings.companyName || 'Line Design', {
      size: 17, font: 'bold', color: BURGUNDY,
    });
    doc.text(MARGIN, 66, 'СТУДИЯ ДИЗАЙНА ИНТЕРЬЕРОВ', { size: 6.5, color: MUTED });
    doc.text(MARGIN, 52, `Лист ${this.pageNumber}`, {
      size: 8.5, color: MUTED, align: 'right', width: CONTENT,
    });

    doc.text(MARGIN, 92, this.title, { size: 15, font: 'bold', color: INK });
    if (this.subtitle) doc.text(MARGIN, 110, this.subtitle, { size: 10, color: MUTED });
    doc.line(MARGIN, 122, MARGIN + CONTENT, 122, { color: BURGUNDY, width: 1.2 });

    doc.text(MARGIN, BOTTOM + 24, `Сформировано ${formatDate(todayIso())} · курс ${formatUsdRate(this.settings.usdRate)}`, {
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
    this.need(34);
    this.gap(6);
    this.doc.text(MARGIN, this.y, text, { size: 11, font: 'bold', color: INK });
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
      this.doc.text(x, this.y + 2, item.label, { size: 8, color: MUTED });
      this.doc.text(x, this.y + 20, money(item.value), {
        size: 13, font: 'bold', color: item.color || INK,
      });
    });
    this.y += height + 8;
  }

  // Строка «подпись — значение».
  pair(label, value, options = {}) {
    this.need(18);
    this.doc.text(MARGIN, this.y, label, { size: 9.5, color: MUTED });
    this.doc.text(MARGIN, this.y, String(value ?? '—'), {
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
        this.doc.text(x + 6, this.y, this.doc.fit(value.text, 9, widths[index] - 12, value.font), {
          size: 9, color: value.color || INK, font: value.font || 'regular',
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
    this.need(26);
    this.gap(4);
    this.doc.text(MARGIN, this.y, text, { size: 8.5, color: MUTED });
    this.y += 14;
  }

  build() {
    return this.doc.build();
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function statusLabel(status) {
  return labelOf(PROJECT_STATUSES, status, 'Новый');
}

// Имя файла: понятное человеку, но без символов, которые ломают вложения.
function fileName(parts) {
  const base = parts.filter(Boolean).join(' - ')
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
    : `${formatAmount(employee.rate, employee.rateCurrency)} за м²`;

  const sheet = new Sheet({
    title: `Отчёт по сотруднику — ${employee.name}`,
    subtitle: [employee.position, pay].filter(Boolean).join(' · '),
    settings: state.settings,
  });

  sheet.totals([
    { label: 'Начислено', value: finance.accruedBase },
    { label: 'Выплачено', value: finance.paidBase, color: GOOD },
    { label: 'К выплате сейчас', value: finance.dueNowBase, color: BURGUNDY },
    { label: 'Ждёт согласования', value: finance.lockedBase },
  ]);

  if (finance.type === 'piecework') {
    sheet.heading('Работа по проектам');
    sheet.table(
      [
        { title: 'Проект', width: 150 },
        { title: 'Площадь', width: 50, align: 'right' },
        { title: 'Ставка', width: 50, align: 'right' },
        { title: 'Начислено', width: 62, align: 'right' },
        { title: 'Выплачено', width: 62, align: 'right' },
        { title: 'Остаток', width: 62, align: 'right' },
        { title: 'Состояние', width: 72 },
      ],
      finance.rows.map((row) => [
        row.project?.name || 'Без проекта',
        `${row.assignment.area} м²`,
        formatAmount(row.assignment.rate, row.assignment.currency),
        money(row.state.accruedBase),
        { text: money(row.state.paidBase), color: GOOD },
        { text: money(row.state.owedBase), color: row.state.owedBase > 0 ? BURGUNDY : MUTED },
        row.state.remainderAvailable || row.state.owedBase === 0
          ? 'Готово к выплате'
          : 'Ждёт одобрения клиента',
      ]),
      { empty: 'Сотрудник пока не назначен ни на один проект' },
    );
    sheet.note('Остаток сдельной оплаты выплачивается после того, как клиент одобрил работу по проекту.');
  } else {
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
    title: `Отчёт по клиенту — ${client.name}`,
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
      { title: 'Проект', width: 150 },
      { title: 'Адрес', width: 120 },
      { title: 'Статус', width: 80 },
      { title: 'Стоимость', width: 75, align: 'right' },
      { title: 'Получено', width: 75, align: 'right' },
      { title: 'Остаток', width: 75, align: 'right' },
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
    title: `Отчёт по проекту — ${project.name}`,
    subtitle: [client?.name, project.address, project.area ? `${project.area} м²` : '']
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
  if (project.currency !== 'USD') {
    sheet.pair('Стоимость в договоре', `${formatAmount(project.price, project.currency)}`
      + ` по курсу ${formatUsdRate(rateToHuman(project.fx))}`);
  }

  sheet.heading('План поступлений');
  sheet.table(
    [
      { title: 'Платёж', width: 160 },
      { title: 'Срок', width: 80 },
      { title: 'Сумма', width: 80, align: 'right' },
      { title: 'Получено', width: 80, align: 'right' },
      { title: 'Осталось', width: 80, align: 'right' },
    ],
    projectPlan(project, finance.receivedBase).map((item) => [
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
        `${assignment.area} м²`,
        formatAmount(assignment.rate, assignment.currency),
        money(info.accruedBase),
        { text: money(info.paidBase), color: GOOD },
      ];
    }),
    { empty: 'Сдельные сотрудники не назначены' },
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
      item.comment || categoryLabel(item.category, state.settings),
      item.kind === 'income' ? { text: money(item.base), color: GOOD } : '',
      item.kind === 'expense' ? { text: money(item.base), color: BURGUNDY } : '',
    ]),
    { empty: 'Операций по проекту пока нет' },
  );

  sheet.note('Прибыль проекта считается как стоимость за вычетом оплаты сотрудников и прямых расходов.'
    + ' Общие расходы студии в неё не входят.');

  return { buffer: sheet.build(), name: fileName(['Отчёт', project.name, todayIso()]) };
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
  ]);

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

  sheet.heading('Все операции периода');
  const moves = [
    ...state.incomes.filter((item) => inRange(item.date, from, to)).map((item) => ({ ...item, kind: 'income' })),
    ...state.expenses.filter((item) => inRange(item.date, from, to)).map((item) => ({ ...item, kind: 'expense' })),
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
  if (type === 'period') {
    if (!from || !to) return null;
    return periodReport(state, from, to);
  }
  return null;
}
