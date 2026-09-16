// Формы ввода. Собраны в одном месте, потому что одни и те же действия
// («добавить приход», «выплатить остаток») вызываются из разных разделов.

import { openForm, toast, html, raw, esc } from './ui.js';
import { getState, byId } from './store.js';
import * as actions from './actions.js';
import { today, monthLabel } from './dates.js';
import { formatAmount } from './money.js';
import {
  PROJECT_STATUSES, OBJECT_TYPES, PROJECT_ROLES, INCOME_TYPES, PAYMENT_METHODS,
  EMPLOYEE_PAY_TYPES, BARTER_KINDS, expenseGroups, SYSTEM_CATEGORIES, categoryLabel,
} from './model.js';
import { assignmentState, assignmentTotals, payrollState, barterState } from './calc.js';

const option = (value, label) => ({ value, label });

function clientOptions(state, { allowEmpty = true } = {}) {
  const options = state.clients.map((item) => option(item.id, item.name));
  return allowEmpty ? [option('', 'Без клиента'), ...options] : options;
}

function projectOptions(state, { allowEmpty = true } = {}) {
  const options = state.projects
    .filter((item) => item.status !== 'cancelled')
    .map((item) => option(item.id, item.name));
  return allowEmpty ? [option('', 'Без проекта'), ...options] : options;
}

// Взаимозачёты, по которым ещё осталось что списывать.
// Закрытые не прячем, если операция уже на них ссылается, — иначе
// при исправлении старой записи выбор потеряется.
function barterOptions(state, currentId = '') {
  const rows = state.barters
    .map((item) => barterState(state, item))
    .filter((row) => !row.done || row.barter.id === currentId)
    .map((row) => {
      const client = byId('clients', row.barter.clientId);
      const left = formatAmount(row.leftBase);
      return option(row.barter.id, `${row.barter.title}${client ? ` · ${client.name}` : ''} · осталось ${left}`);
    });
  return [option('', 'Не выбран'), ...rows];
}

function employeeOptions(state, filter = () => true) {
  return state.employees.filter(filter).map((item) => option(item.id, item.name));
}

function categoryOptions(state) {
  const groups = expenseGroups(state.settings);
  const options = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (SYSTEM_CATEGORIES.includes(item.id)) continue;
      options.push(option(item.id, `${group.label} · ${item.label}`));
    }
  }
  return options;
}

// ------------------------------------------------------------------ клиенты

export function openClientForm(clientId = null, onDone) {
  const client = clientId ? byId('clients', clientId) : null;
  openForm({
    title: client ? 'Клиент' : 'Новый клиент',
    fields: [
      { name: 'name', label: 'Имя или название', type: 'text', required: true, value: client?.name || '', wide: true },
      { name: 'phone', label: 'Телефон', type: 'text', value: client?.phone || '' },
      { name: 'email', label: 'Email', type: 'text', value: client?.email || '' },
    ],
    advanced: [
      { name: 'note', label: 'Дополнительно', type: 'textarea', value: client?.note || '', wide: true },
    ],
    onSubmit: (values) => {
      const saved = actions.saveClient(values, clientId);
      toast(client ? 'Клиент сохранён' : 'Клиент добавлен', 'good');
      onDone?.(saved);
    },
  });
}

// ------------------------------------------------------------------ проекты

export function openProjectForm(projectId = null, onDone) {
  const state = getState();
  const project = projectId ? byId('projects', projectId) : null;
  openForm({
    title: project ? 'Проект' : 'Новый проект',
    fields: [
      { name: 'name', label: 'Название проекта', type: 'text', required: true, value: project?.name || '', wide: true },
      { name: 'clientId', label: 'Клиент', type: 'select', options: clientOptions(state), value: project?.clientId || '' },
      {
        name: 'price', label: 'Стоимость проекта', type: 'money', required: true,
        value: project?.price || '', currency: project?.currency, fx: project?.fx,
      },
      { name: 'area', label: 'Площадь, м²', type: 'number', value: project?.area || '', step: '0.1' },
      { name: 'startDate', label: 'Дата начала', type: 'date', value: project?.startDate || today() },
    ],
    advanced: [
      { name: 'objectType', label: 'Тип объекта', type: 'select', options: [option('', 'Не указан'), ...OBJECT_TYPES.map((item) => option(item, item))], value: project?.objectType || '' },
      { name: 'address', label: 'Адрес / описание', type: 'text', value: project?.address || '', wide: true },
      { name: 'dueDate', label: 'Планируемое завершение', type: 'date', value: project?.dueDate || '' },
      { name: 'leadId', label: 'Ответственный дизайнер', type: 'select', options: [option('', 'Не назначен'), ...employeeOptions(state)], value: project?.leadId || '' },
      { name: 'status', label: 'Статус', type: 'select', options: PROJECT_STATUSES.map((item) => option(item.id, item.label)), value: project?.status || 'new' },
      { name: 'note', label: 'Заметка', type: 'textarea', value: project?.note || '', wide: true },
    ],
    intro: project ? '' : 'План платежей создастся автоматически: аванс и остаток пополам. Его можно изменить в карточке проекта.',
    onSubmit: (values) => {
      const saved = actions.saveProject({
        ...values,
        currency: values.priceCurrency,
        fx: values.priceFx,
      }, projectId);
      toast(project ? 'Проект сохранён' : 'Проект создан', 'good');
      onDone?.(saved);
    },
  });
}

export function openPlanItemForm(projectId, itemId = null, onDone) {
  const project = byId('projects', projectId);
  const item = (project?.payments || []).find((row) => row.id === itemId) || null;
  openForm({
    title: item ? 'Платёж клиента' : 'Добавить платёж клиента',
    fields: [
      {
        name: 'type', label: 'Тип платежа', type: 'select',
        options: [option('advance', 'Аванс'), option('final', 'Остаток'), option('extra', 'Дополнительная работа')],
        value: item?.type || 'final',
      },
      { name: 'amount', label: `Сумма, ${project?.currency || 'TJS'}`, type: 'number', required: true, value: item?.amount || '' },
      { name: 'dueDate', label: 'Ожидаемая дата', type: 'date', value: item?.dueDate || today() },
      { name: 'title', label: 'Название', type: 'text', value: item?.title || '' },
    ],
    onSubmit: (values) => {
      actions.savePlanItem(projectId, values, itemId);
      toast('План платежей обновлён', 'good');
      onDone?.();
    },
  });
}

// ---------------------------------------------------------------- сотрудники

export function openEmployeeForm(employeeId = null, onDone) {
  const state = getState();
  const employee = employeeId ? byId('employees', employeeId) : null;
  const payType = employee?.payType || 'fixed';

  openForm({
    title: employee ? 'Сотрудник' : 'Новый сотрудник',
    fields: [
      { name: 'name', label: 'Имя', type: 'text', required: true, value: employee?.name || '', wide: true },
      { name: 'position', label: 'Должность', type: 'text', value: employee?.position || '', placeholder: 'Дизайнер, чертёжник…' },
      {
        name: 'payType', label: 'Тип оплаты', type: 'segmented',
        options: EMPLOYEE_PAY_TYPES.map((item) => option(item.id, item.id === 'fixed' ? 'Зарплата' : 'Сдельно')),
        value: payType, wide: true,
      },
      {
        name: 'salary', label: 'Зарплата в месяц', type: 'money',
        value: employee?.salary || '', currency: employee?.salaryCurrency, fx: employee?.salaryFx,
      },
      {
        name: 'rate', label: 'Ставка за м²', type: 'money', suffix: '/ м²',
        value: employee?.rate || '', currency: employee?.rateCurrency || 'USD', fx: employee?.rateFx,
      },
    ],
    advanced: [
      { name: 'phone', label: 'Телефон', type: 'text', value: employee?.phone || '' },
      { name: 'startDate', label: 'Работает с', type: 'date', value: employee?.startDate || today() },
      { name: 'payday', label: 'День выплаты зарплаты', type: 'number', min: 1, max: 28, value: employee?.payday || state.settings.salaryDay },
      { name: 'active', label: 'Работает сейчас', type: 'checkbox', value: employee?.active !== false, hint: 'Начисления идут только работающим' },
      { name: 'note', label: 'Заметка', type: 'textarea', value: employee?.note || '', wide: true },
    ],
    onSubmit: (values) => {
      const saved = actions.saveEmployee({
        ...values,
        salaryCurrency: values.salaryCurrency,
        salaryFx: values.salaryFx,
        rateCurrency: values.rateCurrency,
        rateFx: values.rateFx,
      }, employeeId);
      toast(employee ? 'Сотрудник сохранён' : 'Сотрудник добавлен', 'good');
      onDone?.(saved);
    },
  });

  // Показываем только то поле оплаты, которое относится к выбранному типу.
  const panel = document.querySelector('.sheet__panel');
  if (!panel) return;
  const salaryField = panel.querySelector('[data-field-name="salary"]');
  const rateField = panel.querySelector('[data-field-name="rate"]');
  const paydayField = panel.querySelector('[data-field-name="payday"]');
  const typeInput = panel.querySelector('input[name="payType"]');
  const sync = () => {
    const isFixed = typeInput.value === 'fixed';
    salaryField.hidden = !isFixed;
    if (paydayField) paydayField.hidden = !isFixed;
    rateField.hidden = isFixed;
  };
  typeInput.addEventListener('change', sync);
  sync();
}

// -------------------------------------------- сдельное назначение на проект

export function openAssignmentForm(projectId, assignmentId = null, onDone) {
  const state = getState();
  const project = byId('projects', projectId);
  const assignment = assignmentId ? byId('assignments', assignmentId) : null;
  const pieceworkers = state.employees.filter((item) => item.payType === 'piecework' && item.active !== false);

  if (!pieceworkers.length && !assignment) {
    toast('Сначала добавьте сотрудника со сдельной оплатой', 'danger');
    return;
  }

  const first = pieceworkers[0];
  const employee = assignment ? byId('employees', assignment.employeeId) : first;

  openForm({
    title: assignment ? 'Работа сотрудника' : 'Добавить сотрудника в проект',
    fields: [
      {
        name: 'employeeId', label: 'Сотрудник', type: 'select', required: true,
        options: pieceworkers.map((item) => option(item.id, `${item.name}${item.position ? ` · ${item.position}` : ''}`)),
        value: assignment?.employeeId || first?.id || '',
      },
      {
        name: 'role', label: 'Роль в проекте', type: 'select',
        options: PROJECT_ROLES.map((item) => option(item, item)),
        value: assignment?.role || employee?.position || PROJECT_ROLES[0],
      },
      {
        name: 'area', label: 'Площадь этого сотрудника, м²', type: 'number', required: true, step: '0.1',
        value: assignment?.area ?? project?.area ?? '',
        hint: 'У каждого сотрудника может быть свой объём работы',
      },
      {
        name: 'rate', label: 'Ставка за м²', type: 'money', required: true, suffix: '/ м²',
        value: assignment?.rate ?? employee?.rate ?? '',
        currency: assignment?.currency || employee?.rateCurrency || 'USD',
        fx: assignment?.fx ?? employee?.rateFx,
      },
      {
        name: 'advancePercent', label: 'Аванс, %', type: 'number', min: 0, max: 100,
        value: assignment?.advancePercent ?? state.settings.defaultAdvancePercent,
        hint: 'Остальное — остаток после одобрения клиентом',
      },
    ],
    extraHtml: '<div class="form__error" data-preview hidden></div>',
    onSubmit: (values) => {
      const saved = actions.saveAssignment({
        ...values,
        projectId,
        currency: values.rateCurrency,
        fx: values.rateFx,
      }, assignmentId);
      toast('Расчёт по сотруднику сохранён', 'good');
      onDone?.(saved);
    },
  });

  // Живой предварительный расчёт: площадь × ставка, аванс и остаток.
  const panel = document.querySelector('.sheet__panel');
  const form = panel?.querySelector('form');
  const preview = panel?.querySelector('[data-preview]');
  if (!form || !preview) return;

  // При выборе другого сотрудника подставляем его ставку, валюту и должность.
  const employeeSelect = form.querySelector('[name="employeeId"]');
  employeeSelect?.addEventListener('change', () => {
    const chosen = byId('employees', employeeSelect.value);
    if (!chosen) return;
    const rateInput = form.querySelector('[name="rate"]');
    if (rateInput) rateInput.value = chosen.rate || '';
    const currencyInput = form.querySelector('[name="rate__currency"]');
    const target = chosen.rateCurrency || currencyInput?.value;
    if (currencyInput && target && currencyInput.value !== target) {
      form.querySelector(`[data-field="rate__currency"] .segmented__item[data-value="${target}"]`)?.click();
    }
    const roleSelect = form.querySelector('[name="role"]');
    if (roleSelect && chosen.position
      && [...roleSelect.options].some((item) => item.value === chosen.position)) {
      roleSelect.value = chosen.position;
    }
  });
  preview.hidden = false;
  preview.style.background = 'var(--accent-soft)';
  preview.style.color = 'var(--ink)';
  const update = () => {
    const data = new FormData(form);
    const totals = assignmentTotals({
      area: Number(data.get('area')) || 0,
      rate: Number(data.get('rate')) || 0,
      currency: data.get('rate__currency'),
      fx: Number(data.get('rate__fx')) || 1,
      advancePercent: Number(data.get('advancePercent')),
    });
    const currency = data.get('rate__currency');
    preview.innerHTML = html`
      <b>${raw(esc(formatAmount(totals.accrued, currency)))}</b> — начислено
      · аванс ${raw(esc(formatAmount(totals.advance, currency)))}
      · остаток ${raw(esc(formatAmount(totals.remainder, currency)))}
      ${currency === 'TJS'
        ? raw(html`<br><span class="muted">= ${formatAmount(totals.accruedBase)} по курсу ${Number(data.get('rate__rate')) || 0} TJS за доллар</span>`)
        : ''}`;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

// --------------------------------------------------------- приход и расход

export function openIncomeForm(prefill = {}, onDone) {
  const state = getState();
  const income = prefill.id ? byId('incomes', prefill.id) : null;
  const project = byId('projects', income?.projectId || prefill.projectId);

  openForm({
    title: income ? 'Приход' : 'Добавить приход',
    fields: [
      {
        name: 'amount', label: 'Сумма', type: 'money', required: true,
        value: income?.amount ?? prefill.amount ?? '',
        currency: income?.currency || prefill.currency || project?.currency,
        fx: income?.fx ?? prefill.fx ?? project?.fx,
      },
      { name: 'date', label: 'Дата', type: 'date', required: true, value: income?.date || today() },
      {
        name: 'projectId', label: 'Проект', type: 'select',
        options: projectOptions(state), value: income?.projectId || prefill.projectId || '',
      },
      {
        name: 'type', label: 'Тип платежа', type: 'select',
        options: INCOME_TYPES.map((item) => option(item.id, item.label)),
        value: income?.type || prefill.type || 'advance',
      },
    ],
    advanced: [
      {
        name: 'clientId', label: 'Клиент', type: 'select',
        options: clientOptions(state), value: income?.clientId || prefill.clientId || project?.clientId || '',
      },
      {
        name: 'method', label: 'Способ оплаты', type: 'select',
        options: PAYMENT_METHODS.map((item) => option(item.id, item.label)),
        value: income?.method || prefill.method || 'cash',
      },
      {
        name: 'barterId', label: 'В счёт какого имущества', type: 'select',
        options: barterOptions(state, income?.barterId || ''),
        value: income?.barterId || prefill.barterId || '',
        hint: 'Заполняется, когда способ оплаты — взаимозачёт.',
      },
      { name: 'comment', label: 'Комментарий', type: 'textarea', value: income?.comment || '', wide: true },
    ],
    onSubmit: (values) => {
      if (values.method === 'barter' && !values.barterId) {
        toast('Выберите, с какого имущества списать', 'danger');
        return false;
      }
      actions.saveIncome({
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      }, income?.id || null);
      toast('Приход записан', 'good');
      onDone?.();
    },
  });
}

export function openExpenseForm(prefill = {}, onDone) {
  const state = getState();
  const expense = prefill.id ? byId('expenses', prefill.id) : null;
  if (expense?.source) {
    toast('Эта операция создана выплатой — измените саму выплату', 'danger');
    return;
  }

  openForm({
    title: expense ? 'Расход' : 'Добавить расход',
    fields: [
      {
        name: 'category', label: 'Категория', type: 'select', required: true,
        options: categoryOptions(state), value: expense?.category || prefill.category || 'office/rent',
      },
      {
        name: 'amount', label: 'Сумма', type: 'money', required: true,
        value: expense?.amount ?? prefill.amount ?? '',
        currency: expense?.currency || prefill.currency,
        fx: expense?.fx ?? prefill.fx,
      },
      { name: 'date', label: 'Дата', type: 'date', required: true, value: expense?.date || today() },
    ],
    advanced: [
      {
        name: 'projectId', label: 'Проект', type: 'select',
        options: projectOptions(state), value: expense?.projectId || prefill.projectId || '',
        hint: 'Если указать проект, расход войдёт в его себестоимость',
      },
      {
        name: 'method', label: 'Способ оплаты', type: 'select',
        options: PAYMENT_METHODS.map((item) => option(item.id, item.label)),
        value: expense?.method || 'cash',
      },
      { name: 'comment', label: 'Комментарий', type: 'textarea', value: expense?.comment || '', wide: true },
    ],
    onSubmit: (values) => {
      actions.saveExpense({
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      }, expense?.id || null);
      toast('Расход записан', 'good');
      onDone?.();
    },
  });
}

// ------------------------------------------------------------- выплаты

export function openAssignmentPayment(assignmentId, part, onDone) {
  const assignment = byId('assignments', assignmentId);
  const project = byId('projects', assignment?.projectId);
  const employee = byId('employees', assignment?.employeeId);
  const info = assignmentState(assignment, project);

  if (part === 'final' && !info.remainderAvailable) {
    toast('Остаток станет доступен после одобрения проекта клиентом', 'danger');
    return;
  }

  const amount = part === 'advance' ? info.advance : info.remainder;
  openForm({
    title: part === 'advance' ? 'Выплатить аванс' : 'Выплатить остаток',
    intro: `${employee?.name || ''} · ${project?.name || ''} · ${info.area} м² × ${formatAmount(info.rate, info.currency)}`,
    fields: [
      {
        name: 'amount', label: 'Сумма выплаты', type: 'money', required: true,
        value: amount, currency: assignment.currency, fx: assignment.fx,
      },
      { name: 'date', label: 'Дата выплаты', type: 'date', required: true, value: today() },
    ],
    advanced: [
      {
        name: 'method', label: 'Способ оплаты', type: 'select',
        options: PAYMENT_METHODS.map((item) => option(item.id, item.label)), value: 'cash',
      },
      { name: 'comment', label: 'Комментарий', type: 'textarea', wide: true },
    ],
    submitLabel: 'Выплатить',
    onSubmit: (values) => {
      const result = actions.payAssignment(assignmentId, part, {
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      });
      if (!result.ok) {
        toast(result.error, 'danger');
        return false;
      }
      toast('Выплата записана в расходы компании', 'good');
      onDone?.();
      return true;
    },
  });
}

export function openPayrollPayment(payrollId, onDone) {
  const payroll = byId('payrolls', payrollId);
  const employee = byId('employees', payroll?.employeeId);
  const info = payrollState(payroll);
  const leftInCurrency = payroll.fx > 1 ? info.leftBase / payroll.fx : info.leftBase;

  openForm({
    title: 'Выплатить зарплату',
    intro: `${employee?.name || ''} · ${monthLabel(payroll.month)} · начислено ${formatAmount(info.accruedBase)}, осталось ${formatAmount(info.leftBase)}`,
    fields: [
      {
        name: 'amount', label: 'Сумма выплаты', type: 'money', required: true,
        value: Math.round(leftInCurrency * 100) / 100, currency: payroll.currency, fx: payroll.fx,
        hint: 'Можно выплатить частично — остаток сохранится',
      },
      { name: 'date', label: 'Дата выплаты', type: 'date', required: true, value: today() },
    ],
    advanced: [
      {
        name: 'method', label: 'Способ оплаты', type: 'select',
        options: PAYMENT_METHODS.map((item) => option(item.id, item.label)), value: 'cash',
      },
      { name: 'comment', label: 'Комментарий', type: 'textarea', wide: true },
    ],
    submitLabel: 'Выплатить',
    onSubmit: (values) => {
      const result = actions.payPayroll(payrollId, {
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      });
      if (!result.ok) {
        toast(result.error, 'danger');
        return false;
      }
      toast('Зарплата выплачена', 'good');
      onDone?.();
      return true;
    },
  });
}

// ----------------------------------------------------- планируемые расходы

export function openPlannedForm(plannedId = null, onDone) {
  const state = getState();
  const planned = plannedId ? byId('planned', plannedId) : null;
  openForm({
    title: planned ? 'Плановый платёж' : 'Новый плановый платёж',
    fields: [
      { name: 'title', label: 'Название', type: 'text', required: true, value: planned?.title || '', placeholder: 'Аренда офиса', wide: true },
      {
        name: 'category', label: 'Категория', type: 'select', required: true,
        options: categoryOptions(state), value: planned?.category || 'office/rent',
      },
      {
        name: 'amount', label: 'Сумма', type: 'money', required: true,
        value: planned?.amount || '', currency: planned?.currency, fx: planned?.fx,
      },
      { name: 'dueDate', label: 'Срок оплаты', type: 'date', required: true, value: planned?.dueDate || today() },
      {
        name: 'repeat', label: 'Повторять', type: 'segmented',
        options: [option('none', 'Разово'), option('monthly', 'Каждый месяц')],
        value: planned?.repeat || 'monthly', wide: true,
      },
    ],
    onSubmit: (values) => {
      actions.savePlanned({
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      }, plannedId);
      toast('Плановый платёж сохранён', 'good');
      onDone?.();
    },
  });
}

export function openPlannedPayment(plannedId, onDone) {
  const planned = byId('planned', plannedId);
  openForm({
    title: 'Оплатить',
    intro: `${planned.title} · ${categoryLabel(planned.category, getState().settings)}`,
    fields: [
      {
        name: 'amount', label: 'Сумма', type: 'money', required: true,
        value: planned.amount, currency: planned.currency, fx: planned.fx,
      },
      { name: 'date', label: 'Дата оплаты', type: 'date', required: true, value: today() },
    ],
    advanced: [
      {
        name: 'method', label: 'Способ оплаты', type: 'select',
        options: PAYMENT_METHODS.map((item) => option(item.id, item.label)), value: 'transfer',
      },
    ],
    submitLabel: 'Оплатить',
    onSubmit: (values) => {
      const result = actions.payPlanned(plannedId, {
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      });
      if (!result.ok) {
        toast(result.error, 'danger');
        return false;
      }
      toast('Платёж проведён', 'good');
      onDone?.();
      return true;
    },
  });
}

// --------------------------------------------------------- взаиморасчёты

// Клиент-застройщик рассчитывается не деньгами, а квартирой или машиной.
// Здесь записывается, что именно передано и во сколько это оценили;
// дальше выполненные работы списываются с этой оценки.
export function openBarterForm(id = null, prefill = {}, onDone) {
  const state = getState();
  const barter = id ? byId('barters', id) : null;

  openForm({
    title: barter ? 'Взаимозачёт' : 'Новый взаимозачёт',
    fields: [
      {
        name: 'title', label: 'Что передаётся', type: 'text', required: true, wide: true,
        value: barter?.title || '',
        placeholder: 'Квартира, 3 комнаты, ЖК «Сомон»',
      },
      {
        name: 'amount', label: 'Оценка', type: 'money', required: true,
        value: barter?.amount ?? '',
        currency: barter?.currency,
        fx: barter?.fx,
        hint: 'Сумма, на которую стороны договорились. С неё списываются работы.',
      },
      {
        name: 'clientId', label: 'Клиент', type: 'select', required: true,
        options: clientOptions(state), value: barter?.clientId || prefill.clientId || '',
      },
      {
        name: 'kind', label: 'Вид', type: 'select',
        options: BARTER_KINDS.map((item) => option(item.id, item.label)),
        value: barter?.kind || 'property',
      },
      { name: 'date', label: 'Дата договорённости', type: 'date', value: barter?.date || today() },
    ],
    advanced: [
      { name: 'note', label: 'Заметка', type: 'textarea', value: barter?.note || '', wide: true },
    ],
    onSubmit: (values) => {
      if (!values.clientId) {
        toast('Выберите клиента', 'danger');
        return false;
      }
      actions.saveBarter({
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      }, id);
      toast(barter ? 'Взаимозачёт изменён' : 'Взаимозачёт добавлен', 'good');
      onDone?.();
      return true;
    },
  });
}

// -------------------------------------------------------------- партнёры

export function openFounderForm(id = null, onDone) {
  const founder = id ? byId('founders', id) : null;
  openForm({
    title: founder ? 'Партнёр' : 'Новый партнёр',
    fields: [
      { name: 'name', label: 'Имя', type: 'text', required: true, value: founder?.name || '', wide: true },
      { name: 'role', label: 'Роль в студии', type: 'text', value: founder?.role || '', wide: true },
    ],
    advanced: [
      { name: 'note', label: 'Заметка', type: 'textarea', value: founder?.note || '', wide: true },
    ],
    onSubmit: (values) => {
      actions.saveFounder(values, id);
      toast(founder ? 'Сохранено' : 'Партнёр добавлен', 'good');
      onDone?.();
      return true;
    },
  });
}

// Партнёр взял деньги из кассы — это его доля прибыли, а не расход студии.
export function openDrawForm(founderId = '', id = null, onDone) {
  const state = getState();
  const draw = id ? byId('draws', id) : null;

  openForm({
    title: draw ? 'Выдача партнёру' : 'Партнёр взял деньги',
    fields: [
      {
        name: 'amount', label: 'Сумма', type: 'money', required: true,
        value: draw?.amount ?? '', currency: draw?.currency, fx: draw?.fx,
      },
      { name: 'date', label: 'Дата', type: 'date', required: true, value: draw?.date || today() },
      {
        name: 'founderId', label: 'Кто взял', type: 'select', required: true,
        options: state.founders.map((item) => option(item.id, item.name)),
        value: draw?.founderId || founderId || state.founders[0]?.id || '',
      },
    ],
    advanced: [
      {
        name: 'method', label: 'Чем выдано', type: 'select',
        options: PAYMENT_METHODS.filter((item) => item.id !== 'barter')
          .map((item) => option(item.id, item.label)),
        value: draw?.method || 'cash',
      },
      { name: 'comment', label: 'Комментарий', type: 'textarea', value: draw?.comment || '', wide: true },
    ],
    onSubmit: (values) => {
      const result = actions.saveDraw({
        ...values,
        currency: values.amountCurrency,
        fx: values.amountFx,
      }, id);
      if (result?.ok === false) {
        toast(result.error, 'danger');
        return false;
      }
      toast('Записано', 'good');
      onDone?.();
      return true;
    },
  });
}
