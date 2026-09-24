/* Profix — учёт цеха в телефоне. Данные берутся из МойСклад через /api.
   Что видно, решает роль: сервер отдаёт только разрешённые разделы,
   а здесь лишь не показываем вкладки, которые всё равно откажут. */

const PERIODS = [
  { label: "1 день", days: 1 },
  { label: "10 дней", days: 10 },
  { label: "20 дней", days: 20 },
  { label: "30 дней", days: 30 },
  ...Array.from({ length: 11 }, (_, i) => ({ label: `${i + 2} мес.`, days: (i + 2) * 30 })),
];

const TABS = {
  balance: "Баланс",
  report: "Отчёт",
  shipments: "Отгрузки",
  stock: "Остатки",
  production: "Производство",
  team: "Команда",
  cash: "Касса",
};

const state = {
  me: null, // кто вошёл: имя, роль, доступные вкладки
  tab: "balance",
  reportDays: 30,
  shipmentDays: 30,
  teamDays: 30,
  productionDays: 30,
  detail: null, // {href, name} когда открыт человек из «Команды»
  stockQuery: "",
  from: 0, // направление последнего перехода между вкладками
  loadedAt: 0,
};

// После свайпа содержимое уже на экране — перерисовка не должна
// проигрывать появление заново.
let quietEntry = false;

// Без слушателя касаний Safari на iPhone не применяет :active,
// и нажатия визуально не отзываются.
document.addEventListener("touchstart", () => {}, { passive: true });

/* При запуске установленного на экран приложения iOS отдаёт странице
   высоту экрана без выреза: снизу остаётся незанятая полоса. Поворот
   экрана её убирает — значит система умеет посчитать правильно, просто
   при старте этого не делает. Просим явно: в мета-теге viewport Safari
   понимает высоту, ставим её равной высоте экрана. Трогаем только
   установленное приложение и только когда разрыв размером с вырез
   действительно есть, — в обычном браузере ничего не меняется. */
function fixViewportHeight() {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  const full = window.screen && window.screen.height;
  if (!standalone || !full) return;
  const gap = full - window.innerHeight;
  if (gap <= 0 || gap > 120) return; // не похоже на вырез — не вмешиваемся

  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute(
    "content",
    `width=device-width, initial-scale=1, viewport-fit=cover, height=${full}`,
  );
}
window.addEventListener("load", () => setTimeout(fixViewportHeight, 150));

const $ = (sel) => document.querySelector(sel);
const viewEl = (name) => document.querySelector(`.view[data-view="${name}"]`);

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const money = (n) => `${nf.format(Math.round(n || 0))} с.`;
// В плитках место узкое — единица валюты подразумевается, как в кассе.
const amount = (n) => nf.format(Math.round(n || 0));
// Знак суммы: минус красным, плюс зелёным, ноль обычным.
const sign = (n) => (n < 0 ? "neg" : n > 0 ? "pos" : "");
const qty = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(n || 0);
// Цена за единицу — с копейками: округление до целого здесь заметно
// врёт (48,50 превращается в 49).
const unitPrice = (n) =>
  `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n || 0)} с.`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ── Сеть ─────────────────────────────────────────────── */

class AuthError extends Error {}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (res.status === 401) throw new AuthError("Нужно войти заново");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Ошибка ${res.status}`);
  }
  return res.json();
}

/* ── Вход ─────────────────────────────────────────────── */

function showLogin() {
  state.me = null;
  $("#sheet").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#pin").value = "";
}

/* Показываем только вкладки своей роли и в том же порядке. Кассиру
   достаётся одна «Касса» — тогда и полоса вкладок не нужна. */
function applyRole(me) {
  state.me = me;
  state.detail = null;
  state.stockQuery = "";
  TAB_ORDER = ALL_TABS.filter((tab) => me.tabs.includes(tab));
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.hidden = !TAB_ORDER.includes(tab.dataset.tab);
  });
  const bar = $(".tabbar");
  bar.hidden = TAB_ORDER.length < 2;
  bar.style.setProperty("--tabs", TAB_ORDER.length);
  if (!TAB_ORDER.includes(state.tab)) state.tab = TAB_ORDER[0];
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== state.tab;
    // Чужие данные от прошлого входа на этом телефоне не оставляем
    v.replaceChildren();
  });
  markTab(state.tab);
}

function showApp(me) {
  applyRole(me);
  $("#login").hidden = true;
  $("#app").hidden = false;
  render();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const error = $("#login-error");
  button.disabled = true;
  error.hidden = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: $("#pin").value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || "Не удалось войти");
    showApp(body);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* ── Навигация ────────────────────────────────────────── */

const ALL_TABS = ["balance", "report", "shipments", "stock", "production", "team", "cash"];
let TAB_ORDER = [...ALL_TABS];

const LEAVING = ["is-leaving", "to-right"];

function endLeaving(view) {
  view.classList.remove(...LEAVING);
  view.hidden = true;
}

// Соседняя вкладка в заданную сторону; null на краях.
function neighbour(step) {
  return TAB_ORDER[TAB_ORDER.indexOf(state.tab) + step] || null;
}

function markTab(name) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
}

function selectTab(name, from = 0) {
  if (name === state.tab && !state.detail) return;
  const leaving = viewEl(state.tab);

  state.tab = name;
  state.detail = null;
  state.from = from; // -1 пришли слева, 1 справа, 0 без направления
  markTab(name);

  // Предыдущий переход мог не доиграть — снимаем его следы
  document.querySelectorAll(".view.is-leaving").forEach(endLeaving);

  document.querySelectorAll(".view").forEach((v) => {
    if (v !== leaving) v.hidden = v.dataset.view !== name;
  });

  if (from && leaving) {
    // Уходящий экран остаётся на виду и отъезжает — как в iOS
    leaving.classList.add("is-leaving");
    if (from === -1) leaving.classList.add("to-right");
    leaving.addEventListener("animationend", () => endLeaving(leaving), { once: true });
  } else if (leaving) {
    leaving.hidden = true;
  }

  views.scrollTop = 0;
  render();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

/* ── Свайп между вкладками ──────────────────────────────
   Вкладки лежат встык одним полотном и едут за пальцем один в один;
   крапчатая подложка при этом стоит на месте — движется только
   стекло карточек. Пока палец на экране, ничего не переключается:
   решение принимается при отрыве, по пройденному пути или по
   скорости броска, а доводка продолжает движение с той же
   скоростью, с какой шёл палец. */

const LOCK_MIN = 5; // px — столько нужно пройти, чтобы понять: жест горизонтальный
const LOCK_RATIO = 1.1; // во столько раз горизонталь должна обгонять вертикаль
const DONE_PART = 0.2; // доля ширины экрана, после которой переход состоится
const DONE_SPEED = 0.2; // px/мс — быстрый бросок переводит и на коротком пути
const FRESH_MS = 140; // если перед отрывом палец замер, скорость не учитываем

const views = $("#views");

/* Потяг вниз для обновления. Тянется с сопротивлением, дальше PULL_MAX
   не идёт; отпускание после PULL_TRIGGER запускает перечитывание. */
const PULL_MAX = 90;
const PULL_TRIGGER = 62;
let pullDistance = 0;

function setPull(distance) {
  pullDistance = distance;
  const spinner = $("#pull");
  views.style.transform = distance ? `translate3d(0, ${distance}px, 0)` : "";
  views.style.transition = distance ? "" : "transform .3s var(--glide)";
  spinner.style.opacity = String(Math.min(1, distance / PULL_TRIGGER));
  spinner.style.transform = `translate3d(-50%, ${Math.min(distance, PULL_MAX) - 34}px, 0) rotate(${distance * 4}deg)`;
  spinner.classList.toggle("is-ready", distance >= PULL_TRIGGER);
}

let gesture = null; // текущее касание
let drag = null; // начатое перетаскивание экранов

// Свайп уступает только тому, что само прокручивается вбок
// (лента периодов) и графику с подсказкой. Поле поиска не в счёт —
// из-за него свайп во «Команде» раньше через раз не срабатывал.
function busyUnder(target) {
  if (target.closest(".chart")) return true;
  for (let node = target; node && node !== views; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 2) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}

function startDrag(step) {
  const outgoing = viewEl(state.tab);
  const next = neighbour(step);
  const incoming = next ? viewEl(next) : null;
  const width = views.clientWidth || window.innerWidth;

  document.querySelectorAll(".view.is-leaving").forEach(endLeaving);
  outgoing.classList.add("is-dragging-out");

  if (incoming) {
    incoming.classList.remove("is-entering", "is-from-left", "is-from-right");
    if (!incoming.firstChild) skeleton(incoming, next === "balance");
    incoming.hidden = false;
    incoming.classList.add("is-dragging-in");
    incoming.style.transform = `translate3d(${step * width}px, 0, 0)`;
  }
  drag = { step, next, incoming, outgoing, width, dx: 0 };
}

/* Оба экрана едут за пальцем один в один: вкладки лежат встык, как
   одно полотно, и жест тянет это полотно целиком. Ничего не наезжает
   друг на друга и не притухает. */
function paintDrag(dx) {
  const { incoming, outgoing, step, width } = drag;
  if (!incoming) {
    // У края списка вкладок полотно только пружинит
    outgoing.style.transform = `translate3d(${dx / 3}px, 0, 0)`;
    return;
  }
  // Только пиксели: проценты внутри calc() браузер пересчитывает
  // от размеров элемента на каждом кадре.
  incoming.style.transform = `translate3d(${step * width + dx}px, 0, 0)`;
  outgoing.style.transform = `translate3d(${dx}px, 0, 0)`;
}

/* Палец шлёт события чаще, чем экран успевает обновляться. Рисуем
   строго раз в кадр — иначе часть работы уходит впустую и движение
   начинает спотыкаться. */
let paintPending = false;
let paintDx = 0;

function queuePaint(dx) {
  paintDx = dx;
  if (paintPending) return;
  paintPending = true;
  requestAnimationFrame(() => {
    paintPending = false;
    if (drag) paintDrag(paintDx);
  });
}

// Доводим экраны до конца или возвращаем на место. Время берём по
// остатку пути: короткий доводится быстро, длинный — привычной кривой.
function settleDrag(commit, speed = 0) {
  const { incoming, outgoing, step, next, width, dx } = drag;
  const left = commit ? width - Math.abs(dx) : Math.abs(dx);
  /* Доводим с той скоростью, с какой шёл палец: если просто задать
     фиксированное время, на отрыве видно рывок — экран то прыгает
     вперёд, то вязнет. Множитель учитывает, что кривая тормозит, а
     границы не дают ни дёрнуть, ни затянуть. */
  const v = Math.abs(speed);
  const secs = Math.min(0.4, Math.max(0.16, v > 0.05 ? (left / (v * 1000)) * 0.7 : 0.3));

  const finish = () => {
    if (!drag) return;
    drag = null;
    [outgoing, incoming].forEach((v) => {
      if (!v) return;
      v.classList.remove("is-dragging-in", "is-dragging-out", "is-settling");
      v.style.transform = "";
      v.style.opacity = "";
      v.style.transitionDuration = "";
    });
    if (commit && next) {
      outgoing.hidden = true;
      state.tab = next;
      state.from = 0;
      markTab(next);
      views.scrollTop = 0;
      quietEntry = true; // содержимое уже на экране — не проигрываем появление
      render();
    } else if (incoming) {
      incoming.hidden = true;
    }
  };

  const mover = incoming || outgoing;
  const timer = setTimeout(finish, secs * 1000 + 90);
  mover.addEventListener(
    "transitionend",
    (event) => {
      if (event.target !== mover || event.propertyName !== "transform") return;
      clearTimeout(timer);
      finish();
    },
    { once: true },
  );

  requestAnimationFrame(() => {
    [outgoing, incoming].forEach((v) => {
      if (!v) return;
      v.classList.add("is-settling");
      v.style.transitionDuration = `${secs}s`;
    });
    if (commit) {
      if (incoming) incoming.style.transform = "translate3d(0, 0, 0)";
      outgoing.style.transform = `translate3d(${-step * width}px, 0, 0)`;
    } else {
      if (incoming) incoming.style.transform = `translate3d(${step * width}px, 0, 0)`;
      outgoing.style.transform = "translate3d(0, 0, 0)";
    }
  });
}

views.addEventListener(
  "touchstart",
  (event) => {
    if (drag || event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture = {
      x: touch.clientX,
      y: touch.clientY,
      px: touch.clientX,
      pt: event.timeStamp,
      vx: 0,
      busy: busyUnder(event.target),
      locked: false,
      dead: false,
    };
  },
  { passive: true },
);

views.addEventListener(
  "touchmove",
  (event) => {
    const g = gesture;
    if (!g || g.dead || event.touches.length !== 1) return;
    const touch = event.touches[0];

    if (!g.locked) {
      const dx = touch.clientX - g.x;
      const dy = touch.clientY - g.y;
      // Сначала решаем, вдоль какой оси идёт палец, и больше не меняем
      if (Math.abs(dy) > LOCK_MIN && Math.abs(dy) >= Math.abs(dx)) {
        // Потяг вниз с самого верха — обновление. Ниже верха это обычная
        // прокрутка, её не трогаем.
        if (dy > 0 && views.scrollTop <= 0 && !g.busy) g.pulling = true;
        else g.dead = true;
      }
      if (g.pulling) {
        const pull = Math.min(PULL_MAX, dy * 0.5); // тянется с сопротивлением
        setPull(pull);
        if (pull > 0) event.preventDefault();
        return;
      }
      if (g.dead) return;
      if (Math.abs(dx) < LOCK_MIN || Math.abs(dx) < Math.abs(dy) * LOCK_RATIO) return;
      if (g.busy) {
        g.dead = true;
        return;
      }
      g.locked = true;
      g.x = touch.clientX; // считаем путь от точки захвата — экран не прыгает
      if (!state.detail) startDrag(dx < 0 ? 1 : -1);
    }

    const move = touch.clientX - g.x;
    if (event.timeStamp > g.pt) {
      g.vx = (touch.clientX - g.px) / (event.timeStamp - g.pt);
      g.px = touch.clientX;
      g.pt = event.timeStamp;
    }
    if (drag) {
      // Тянуть можно только в ту сторону, куда начали
      const forward = drag.step === 1 ? Math.min(0, move) : Math.max(0, move);
      drag.dx = forward;
      queuePaint(forward);
    }
    event.preventDefault(); // жест наш — страница вертикально не едет
  },
  { passive: false },
);

function endGesture(event) {
  const g = gesture;
  gesture = null;
  if (g && g.pulling) {
    const enough = pullDistance >= PULL_TRIGGER;
    setPull(0);
    if (enough) render();
    return;
  }
  if (!g || !g.locked) {
    if (drag) settleDrag(false);
    return;
  }
  const touch = event.changedTouches[0];
  const move = touch.clientX - g.x;
  const fresh = event.timeStamp - g.pt < FRESH_MS;
  const flick = fresh && Math.abs(g.vx) >= DONE_SPEED && Math.sign(g.vx) === Math.sign(move);

  // Внутри карточки человека свайп вправо возвращает к списку
  if (state.detail) {
    const enough = move > 0 && (move > views.clientWidth * DONE_PART || flick);
    if (enough) {
      state.detail = null;
      state.from = -1;
      render();
    }
    return;
  }
  if (!drag) return;
  const path = Math.abs(drag.dx);
  settleDrag(
    Boolean(drag.incoming) && (path > drag.width * DONE_PART || (flick && path > 18)),
    fresh ? g.vx : 0,
  );
}

views.addEventListener("touchend", endGesture, { passive: true });
views.addEventListener(
  "touchcancel",
  () => {
    gesture = null;
    if (drag) settleDrag(false);
  },
  { passive: true },
);

$("#back").addEventListener("click", () => {
  state.detail = null;
  render();
});

$("#refresh").addEventListener("click", () => render());

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#app").hidden && Date.now() - state.loadedAt > 120_000) render();
});

// Само обновляется раз в 20 минут, пока приложение открыто на экране.
const AUTO_REFRESH_MS = 20 * 60 * 1000;
setInterval(() => {
  // Не трогаем экран, пока открыта карточка или профиль
  if (document.hidden || $("#app").hidden || state.detail || !$("#sheet").hidden) return;
  if (Date.now() - state.loadedAt >= AUTO_REFRESH_MS) render();
}, 60_000);

/* ── Отрисовка ────────────────────────────────────────── */

function setChrome() {
  $("#title").textContent = state.detail ? state.detail.name : TABS[state.tab];
  $("#back").hidden = !state.detail;
}

function skeleton(container, tall) {
  container.replaceChildren();
  const wrap = el("div", "skeleton");
  wrap.append(el("div", "skeleton__bar" + (tall ? " skeleton__bar--tall" : "")));
  wrap.append(el("div", "skeleton__bar"));
  container.append(wrap);
}

function showError(container, message) {
  container.replaceChildren(el("div", "error", message));
}

async function render() {
  setChrome();
  const container = viewEl(state.tab);
  const button = $("#refresh");
  button.classList.add("is-busy");
  // Заглушку показываем только на пустой вкладке. Если там уже есть
  // цифры — оставляем их на экране и подменяем, когда придут свежие:
  // переход не мигает и ощущается мгновенным.
  if (!container.firstChild || container.querySelector(".skeleton")) {
    skeleton(container, state.tab === "balance");
  }
  // Свежая анимация появления на каждую перерисовку; при переходе по
  // кнопке содержимое въезжает с той стороны, откуда пришли.
  const ENTERING = ["is-entering", "is-from-left", "is-from-right"];
  container.classList.remove(...ENTERING);
  if (quietEntry) {
    quietEntry = false;
    state.from = 0;
  } else {
    void container.offsetWidth;
    container.classList.add("is-entering");
    if (state.from === 1) container.classList.add("is-from-right");
    else if (state.from === -1) container.classList.add("is-from-left");
    state.from = 0;
    // На время перехода вкладка непрозрачна и лежит слоем выше; после
    // снимаем — иначе она перекроет фактуру страницы.
    container.addEventListener(
      "animationend",
      () => container.classList.remove(...ENTERING),
      { once: true },
    );
  }
  try {
    if (state.tab === "balance") await renderBalance(container);
    else if (state.tab === "report") await renderReport(container);
    else if (state.tab === "shipments") {
      if (state.detail) await renderShipmentDetail(container);
      else await renderShipments(container);
    }
    else if (state.tab === "stock") await renderStock(container);
    else if (state.tab === "cash") await renderCash(container);
    else if (state.tab === "production") await renderProduction(container);
    else if (state.detail) await renderTeamDetail(container);
    else await renderTeam(container);
    state.loadedAt = Date.now();
  } catch (err) {
    if (err instanceof AuthError) {
      showLogin();
      return;
    }
    showError(container, err.message);
  } finally {
    button.classList.remove("is-busy");
  }
}

/* Полоса периодов не пересобирается при смене периода: она остаётся
   в DOM, у неё лишь переезжает отметка, а всё, что было под ней,
   заменяется. Раньше при каждом нажатии плашки создавались заново и
   вся лента вздрагивала, теряя прокрутку. */
function resetWithChips(container, current, onPick) {
  const strip = container.querySelector(".chips");
  if (!strip) {
    container.replaceChildren(chips(current, onPick));
    return;
  }
  while (strip.nextSibling) strip.nextSibling.remove();
  while (strip.previousSibling) strip.previousSibling.remove();
  strip.querySelectorAll(".chip").forEach((chip, i) => {
    chip.classList.toggle("is-active", PERIODS[i].days === current);
  });
}

function chips(current, onPick) {
  const wrap = el("div", "chips");
  PERIODS.forEach((period) => {
    const chip = el("button", "chip" + (period.days === current ? " is-active" : ""), period.label);
    chip.type = "button";
    // Без этого браузер ставит нажатую плашку в фокус и подтягивает её
    // к центру — лента дёргается прямо под пальцем.
    chip.addEventListener("mousedown", (event) => event.preventDefault());
    chip.addEventListener("click", () => onPick(period.days));
    wrap.append(chip);
  });
  // Выбранный период может быть далеко справа — открываем ту страницу
  // из четырёх, где он лежит, а не подкручиваем его к центру: иначе
  // лента встанет посередине и по краям окажутся обрезанные плашки.
  requestAnimationFrame(() => {
    const all = [...wrap.querySelectorAll(".chip")];
    const at = all.findIndex((chip) => chip.classList.contains("is-active"));
    if (at > 0) wrap.scrollLeft = all[Math.floor(at / 4) * 4].offsetLeft;
  });
  return wrap;
}

// Галочка «вправо» в конце строки, по которой можно провалиться внутрь
function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "chev");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M9 5l7 7-7 7");
  svg.append(path);
  return svg;
}

function tiles(items) {
  const wrap = el("div", "tiles" + (items.length === 2 ? " tiles--two" : ""));
  items.forEach(({ label, value, tone, note, noteTone }) => {
    const tile = el("div", "tile");
    tile.append(el("div", "tile__label", label));
    tile.append(el("div", `tile__value${tone ? ` tile__value--${tone}` : ""}`, value));
    if (note) tile.append(el("div", `tile__note${noteTone ? ` is-${noteTone}` : ""}`, note));
    wrap.append(tile);
  });
  return wrap;
}

/* ── Баланс ───────────────────────────────────────────── */

async function renderBalance(container) {
  const data = await api("/api/summary");
  container.replaceChildren();

  const hero = el("div", "card hero");
  // Сумма по всем кассам и банковским счетам — как в отчёте МойСклада
  hero.append(el("div", "hero__label", "Кассы и счета"));
  hero.append(
    el("div", `hero__value is-${sign(data.total_balance)}`, money(data.total_balance)),
  );
  if (data.balance_is_estimate) {
    hero.append(el("div", "hero__note", "Посчитано по всем кассовым ордерам"));
  }
  container.append(hero);

  container.append(
    tiles([
      { label: "Доход сегодня", value: amount(data.today.income), tone: "income" },
      { label: "Расход сегодня", value: amount(data.today.expense), tone: "expense" },
      { label: "Итог", value: amount(data.today.profit), tone: sign(data.today.profit) },
    ]),
  );

  if (data.accounts.length) {
    const card = el("div", "card");
    card.append(el("div", "card__title", "Счета и кассы"));
    const rows = el("div", "rows");
    data.accounts.forEach((account) => {
      const row = el("div", "row");
      row.append(el("div", "row__label", account.name));
      row.append(el("div", `row__value is-${sign(account.balance)}`, money(account.balance)));
      rows.append(row);
    });
    card.append(rows);
    container.append(card);
  }

  // Ключевое сырьё — последним блоком, под кассой
  if (data.materials.length) {
    const anyLow = data.materials.some((item) => item.low);
    const card = el("div", `card${anyLow ? " card--warn" : ""}`);
    card.append(el("div", "card__title", "Ключевое сырьё"));
    const rows = el("div", "rows");
    data.materials.forEach((item) => {
      const row = el("div", "row");
      if (item.low) row.append(el("span", "dot"));
      row.append(el("div", "row__label", item.name));
      const value = el(
        "div",
        `row__value${item.low ? " row__value--warn" : ""}`,
        qty(item.stock),
      );
      if (item.uom) value.append(el("span", "row__unit", ` ${item.uom}`));
      row.append(value);
      rows.append(row);
    });
    card.append(rows);
    container.append(card);
  }
}

/* ── Отчёт ────────────────────────────────────────────── */

async function renderReport(container) {
  const data = await api(`/api/report?days=${state.reportDays}`);
  resetWithChips(container, state.reportDays, (days) => {
    state.reportDays = days;
    quietEntry = true; // меняется только период — вкладке незачем появляться заново
    render();
  });

  container.append(
    tiles([
      { label: "Доход", value: amount(data.totals.income), tone: "income" },
      { label: "Расход", value: amount(data.totals.expense), tone: "expense" },
      { label: "Прибыль", value: amount(data.totals.profit), tone: sign(data.totals.profit) },
    ]),
  );

  const card = el("div", "card");
  card.append(
    el("div", "card__title", data.granularity === "day" ? "По дням" : "По месяцам"),
  );
  if (!data.rows.length) {
    card.append(el("div", "empty", "За этот период записей нет"));
  } else {
    card.append(
      legend([
        { label: "Доход", color: "var(--income)" },
        { label: "Расход", color: "var(--expense)" },
      ]),
    );
    card.append(
      lineChart(data.rows, [
        { key: "income", label: "Доход", color: "var(--income)" },
        { key: "expense", label: "Расход", color: "var(--expense)" },
      ]),
    );
    const rows = el("div", "rows");
    [...data.rows].reverse().forEach((row) => {
      const line = el("div", "row");
      line.append(el("div", "row__label", row.label));
      line.append(el("div", "row__value row__value--col row__value--income", money(row.income)));
      line.append(el("div", "row__value row__value--col row__value--expense", money(row.expense)));
      rows.append(line);
    });
    card.append(rows);
  }
  container.append(card);
}

/* ── Отгрузки ─────────────────────────────────────────── */

async function renderShipments(container) {
  const data = await api(`/api/shipments?days=${state.shipmentDays}`);

  resetWithChips(container, state.shipmentDays, (days) => {
    state.shipmentDays = days;
    quietEntry = true;
    render();
  });

  container.append(
    tiles([
      {
        label: "Отгружено",
        value: amount(data.total),
        tone: "income",
        // Насколько больше или меньше, чем за такой же прошлый отрезок
        note: data.change === null ? "" : `${data.change > 0 ? "+" : ""}${data.change}% к прошлому`,
        noteTone: data.change === null ? "" : data.change >= 0 ? "pos" : "neg",
      },
      { label: "Оплачено", value: amount(data.paid), tone: "pos" },
      { label: "Не оплачено", value: amount(data.debt), tone: data.debt > 0 ? "neg" : "" },
    ]),
  );

  // Кому отгружали — сразу видно, чья доля какая
  const who = el("div", "card");
  who.append(el("div", "card__title", "Кому отгружали"));
  if (!data.agents.length) {
    who.append(el("div", "empty", "За этот период отгрузок нет"));
  } else {
    const rows = el("div", "rows");
    data.agents.forEach((agent) => {
      const line = el("button", "row row--tap person");
      line.type = "button";
      line.append(el("div", "person__name", agent.name));
      line.append(el("div", "person__total", money(agent.total)));
      line.append(chevron());
      // Сразу видно, кто рассчитался, а кто должен
      const owes = agent.debt > 0.01;
      line.classList.add("row--stacked");
      line.append(
        el(
          "div",
          `row__note${owes ? " row__note--debt" : ""}`,
          owes ? `не оплачено ${money(agent.debt)}` : "оплачено полностью",
        ),
      );
      line.addEventListener("click", () => {
        state.detail = { href: agent.href, name: agent.name };
        views.scrollTop = 0;
        render();
      });
      rows.append(line);
    });
    who.append(rows);
  }
  container.append(who);

  const card = el("div", "card");
  card.append(
    el("div", "card__title", data.granularity === "day" ? "По дням" : "По месяцам"),
  );
  if (!data.rows.length) {
    card.append(el("div", "empty", "За этот период отгрузок нет"));
  } else {
    card.append(legend([{ label: "Отгружено", color: "var(--income)" }]));
    card.append(
      lineChart(data.rows, [{ key: "total", label: "Отгружено", color: "var(--income)" }]),
    );
    const rows = el("div", "rows");
    [...data.rows].reverse().forEach((row) => {
      const line = el("div", "row");
      line.append(el("div", "row__label", row.label));
      line.append(el("div", "row__value", money(row.total)));
      rows.append(line);
    });
    card.append(rows);
  }
  container.append(card);
}

async function renderShipmentDetail(container) {
  const data = await api(
    `/api/shipments/detail?days=${state.shipmentDays}` +
      `&href=${encodeURIComponent(state.detail.href)}` +
      `&name=${encodeURIComponent(state.detail.name)}`,
  );

  resetWithChips(container, state.shipmentDays, (days) => {
    state.shipmentDays = days;
    quietEntry = true;
    render();
  });

  container.append(
    tiles([
      { label: "Отгружено", value: amount(data.total), tone: "income" },
      { label: "Занёс денег", value: amount(data.paid), tone: "pos" },
      // Долг за период не нужен — основной долг виден целиком ниже.
      { label: "Бонусы всего", value: amount(data.bonus), tone: "" },
    ]),
  );

  /* Сколько должен всего — это цифра из «Взаиморасчётов», за всё время
     работы. Бонусы в неё не входят: в учёте они висят на отдельном
     контрагенте, а кому выданы — написано только в назначении. Поэтому
     считаем и показываем оба слагаемых и итог. */
  /* Долг за всё время считается по документам и показывается целиком,
     строка за строкой: отгружено минус занесено минус бонусы. Бонусы в
     учёте висят на отдельном контрагенте, поэтому в поступления они не
     попадают и вычитаются отдельно. */
  const debt = el("div", "card");
  debt.append(el("div", "card__title", "Долг за всё время"));
  if (data.balance === null) {
    debt.append(el("div", "empty", "Не удалось посчитать"));
  } else {
    const debtRows = el("div", "rows");

    const line = (label, value, cls) => {
      const row = el("div", "row");
      row.append(el("div", "row__label", label));
      row.append(el("div", `row__value${cls ? ` ${cls}` : ""}`, value));
      debtRows.append(row);
    };

    line("Отгружено всего", money(data.shippedAll));
    line("Занёс денег", `− ${money(data.paidAll)}`, "row__value--muted");

    /* Бонусы здесь не вычитаются: их проводят и расходом по «Бонус
       покупатель», и приходом от самого покупателя — то есть в «занёс
       денег» они уже сидят, и второй вычет ушёл бы в минус. Сумму
       показываем отдельной карточкой, для сверки. */
    const netRow = el("div", "row row--total");
    netRow.append(el("div", "row__label", "Итого должен"));
    netRow.append(
      el(
        "div",
        `row__value row__value--${data.balance > 0.01 ? "unpaid" : "paid"}`,
        money(data.balance),
      ),
    );
    debtRows.append(netRow);
    debt.append(debtRows);
  }
  container.append(debt);

  const goods = el("div", "card");
  goods.append(el("div", "card__title", "Что отгружено"));
  if (!data.goods.length) {
    goods.append(el("div", "empty", "За этот период отгрузок нет"));
  } else {
    const rows = el("div", "rows");
    data.goods.forEach((item) => {
      const line = el("div", "row row--stacked");
      if (item.href) line.append(productPhoto(item.href));
      line.append(el("div", "row__label", item.name));
      const sum = el("div", "row__value", money(item.sum));
      line.append(sum);
      // Вторая строка — сколько штук и почём, мелким
      const note = el(
        "div",
        "row__note",
        `${qty(item.qty)}${item.uom ? ` ${item.uom}` : ""} × ${unitPrice(item.price)}`,
      );
      line.append(note);
      rows.append(line);
    });
    goods.append(rows);
  }
  container.append(goods);

  const docs = el("div", "card");
  docs.append(el("div", "card__title", "Отгрузки"));
  if (!data.docs.length) {
    docs.append(el("div", "empty", "Отгрузок нет"));
  } else {
    const rows = el("div", "rows");
    data.docs.forEach((doc) => {
      const line = el("div", "row");
      line.append(
        el("div", "row__label", `${_docDate(doc.date)}${doc.number ? `  №${doc.number}` : ""}`),
      );
      line.append(el("div", "row__value", money(doc.sum)));
      rows.append(line);
    });
    docs.append(rows);
  }
  container.append(docs);

  /* Деньги отдельной карточкой: оплаты у нас не привязаны к отгрузкам,
     контрагент просто заносит суммы — поэтому показываем движение как
     есть, а сходится оно наверху, в плитках. */
  const cash = el("div", "card");
  cash.append(el("div", "card__title", "Приход и расход"));
  if (!data.payments.length) {
    cash.append(el("div", "empty", "Платежей за период нет"));
  } else {
    const rows = el("div", "rows");
    data.payments.forEach((payment) => {
      const income = payment.kind === "in";
      const line = el("div", "row");
      line.append(el("div", "row__label", _docDate(payment.date)));
      line.append(
        el(
          "div",
          `row__value row__value--${income ? "paid" : "unpaid"}`,
          `${income ? "+" : "−"}${money(payment.sum)}`,
        ),
      );
      if (payment.purpose) {
        line.classList.add("row--stacked");
        line.append(el("div", "row__note", payment.purpose));
      }
      rows.append(line);
    });
    cash.append(rows);
  }
  container.append(cash);

  if (data.balance !== null && data.bonusRows.length) {
    /* Бонусы — своей графой: в долг они не входят (их уже проводят
       приходом от покупателя), но видеть, сколько всего выдано за годы,
       нужно отдельно. */
    const bonuses = el("div", "card");
    bonuses.append(el("div", "card__title", "Бонусы покупателю"));
    const rows = el("div", "rows");

    const totalRow = el("div", "row row--total");
    totalRow.append(el("div", "row__label", "Выдано за всё время"));
    totalRow.append(el("div", "row__value", money(data.bonus)));
    rows.append(totalRow);

    data.bonusRows.forEach((row) => {
      const line = el("div", "row");
      line.append(el("div", "row__label", _docDate(row.date)));
      line.append(el("div", "row__value row__value--muted", `− ${money(row.sum)}`));
      if (row.purpose) {
        line.classList.add("row--stacked");
        line.append(el("div", "row__note", row.purpose));
      }
      rows.append(line);
    });
    bonuses.append(rows);
    container.append(bonuses);
  }
}

/* Фото товара из МойСклада. Грузится лениво и только когда строка
   на экране; если фото у товара нет — картинка молча убирается, чтобы
   не оставлять пустую рамку. */
function productPhoto(href) {
  const img = el("img", "row__photo");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.src = `/api/product-image?href=${encodeURIComponent(href)}`;
  img.addEventListener("error", () => img.remove());
  return img;
}

// 2026-09-13 -> 13.09
const _docDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");

/* ── Остатки ──────────────────────────────────────────── */

async function renderStock(container) {
  const data = await api("/api/stock");
  container.replaceChildren();

  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "Поиск по товарам и сырью";
  search.value = state.stockQuery;
  container.append(search);

  const results = el("div", "view");
  container.append(results);

  const draw = () => {
    const needle = state.stockQuery.trim().toLowerCase();
    results.replaceChildren();

    // Что заканчивается — впереди списка, пока не начали искать
    if (!needle && data.low.length) {
      const card = el("div", "card card--warn");
      card.append(
        el("div", "card__title", `На исходе · меньше ${qty(data.low_threshold)} кг`),
      );
      const rows = el("div", "rows");
      data.low.forEach((item) => {
        const row = el("div", "row");
        row.append(el("span", "dot"));
        row.append(el("div", "row__label", item.name));
        const value = el("div", "row__value row__value--warn", qty(item.stock));
        value.append(el("span", "row__unit", ` ${item.uom}`));
        row.append(value);
        rows.append(row);
      });
      card.append(rows);
      results.append(card);
    }

    let shown = 0;
    data.folders.forEach((folder) => {
      const items = needle
        ? folder.items.filter((item) => item.name.toLowerCase().includes(needle))
        : folder.items;
      if (!items.length) return;
      shown += items.length;
      const card = el("div", "card");
      const lowHere = items.filter((item) => item.low).length;
      const title = el("div", "card__title", `${folder.name} · ${items.length}`);
      if (lowHere) title.append(el("span", "card__warn", ` · ${lowHere} на исходе`));
      card.append(title);
      const rows = el("div", "rows");
      items.forEach((item) => {
        const row = el("div", "row");
        if (item.low) row.append(el("span", "dot"));
        if (item.href) row.append(productPhoto(item.href));
        row.append(el("div", "row__label", item.name));
        const value = el(
          "div",
          `row__value${item.low ? " row__value--warn" : ""}`,
          qty(item.stock),
        );
        if (item.uom) value.append(el("span", "row__unit", ` ${item.uom}`));
        row.append(value);
        rows.append(row);
      });
      card.append(rows);
      results.append(card);
    });
    if (!shown) results.append(el("div", "empty", "Ничего не найдено"));
  };

  search.addEventListener("input", () => {
    state.stockQuery = search.value;
    draw();
  });
  draw();
}

/* ── Команда ──────────────────────────────────────────── */

async function renderTeam(container) {
  const data = await api(`/api/team?days=${state.teamDays}`);
  resetWithChips(container, state.teamDays, (days) => {
    state.teamDays = days;
    quietEntry = true;
    render();
  });

  const card = el("div", "card");
  card.append(el("div", "card__title", "Расход за период"));
  if (!data.people.length) {
    card.append(el("div", "empty", "За этот период расходов нет"));
  } else {
    const rows = el("div", "rows");
    data.people.forEach((person) => {
      const row = el("button", "row row--tap person");
      row.type = "button";
      row.append(el("div", "person__name", person.name));
      row.append(el("div", "person__total", money(person.total)));
      row.append(chevron());
      row.addEventListener("click", () => {
        state.detail = { href: person.href, name: person.name };
        views.scrollTop = 0;
        render();
      });
      rows.append(row);
    });
    card.append(rows);
  }
  container.append(card);
}

async function renderTeamDetail(container) {
  const data = await api(
    `/api/team/detail?days=${state.teamDays}&href=${encodeURIComponent(state.detail.href)}`,
  );
  resetWithChips(container, state.teamDays, (days) => {
    state.teamDays = days;
    quietEntry = true;
    render();
  });

  container.append(
    tiles([
      { label: "Сегодня", value: amount(data.today), tone: "expense" },
      { label: "За период", value: amount(data.total), tone: "expense" },
    ]),
  );

  const card = el("div", "card");
  card.append(el("div", "card__title", data.granularity === "day" ? "По дням" : "По месяцам"));
  if (!data.rows.length) {
    card.append(el("div", "empty", "За этот период расходов нет"));
  } else {
    card.append(barChart(data.rows));
    const rows = el("div", "rows");
    [...data.rows].reverse().forEach((row) => {
      const line = el("div", "row");
      line.append(el("div", "row__label", row.label));
      line.append(el("div", "row__value row__value--expense", money(row.amount)));
      rows.append(line);
    });
    card.append(rows);
  }
  container.append(card);
}

/* ── Касса (кассир) ───────────────────────────────────── */

async function renderCash(container) {
  const data = await api("/api/cash");
  container.replaceChildren();

  const hero = el("div", "card hero");
  if (data.balance === null) {
    hero.append(el("div", "hero__label", "Итог по кассе сегодня"));
    const net = data.income - data.expense;
    hero.append(el("div", `hero__value is-${sign(net)}`, money(net)));
  } else {
    hero.append(el("div", "hero__label", "В кассе"));
    hero.append(el("div", `hero__value is-${sign(data.balance)}`, money(data.balance)));
  }
  container.append(hero);

  // Две главные кнопки кассира — крупно, сразу под цифрой
  const actions = el("div", "actions");
  const plus = el("button", "action action--in", "+ Приход");
  const minus = el("button", "action action--out", "− Расход");
  plus.type = minus.type = "button";
  plus.addEventListener("click", () => openPanel("Приход", () => drawCashForm("in")));
  minus.addEventListener("click", () => openPanel("Расход", () => drawCashForm("out")));
  actions.append(plus, minus);
  container.append(actions);

  container.append(
    tiles([
      { label: "Приход сегодня", value: amount(data.income), tone: "income" },
      { label: "Расход сегодня", value: amount(data.expense), tone: "expense" },
    ]),
  );

  const card = el("div", "card");
  card.append(el("div", "card__title", "Операции за сегодня"));
  if (!data.operations.length) {
    card.append(el("div", "empty", "Сегодня операций нет"));
  } else {
    const rows = el("div", "rows");
    data.operations.forEach((op) => {
      const income = op.kind === "in";
      const line = el("div", `row row--stacked${op.applicable ? "" : " is-cancelled"}`);
      line.append(el("div", "row__label", `${op.time}  ${op.item || op.agent || (income ? "Приход" : "Расход")}`));
      line.append(
        el(
          "div",
          `row__value row__value--${income ? "paid" : "unpaid"}`,
          `${income ? "+" : "−"}${money(op.sum)}`,
        ),
      );
      const who = op.item && op.agent ? op.agent : "";
      const note = [op.number ? `№${op.number}` : "", who, op.purpose].filter(Boolean).join(" · ");
      if (!op.applicable) line.append(el("div", "row__note row__note--debt", "отменена"));
      if (note) line.append(el("div", "row__note", note));
      if (op.cancellable) {
        const bar = el("div", "row__actions");
        const cancel = el("button", "mini mini--danger", "Отменить");
        cancel.type = "button";
        cancel.addEventListener("click", () => cancelCashOp(op));
        bar.append(cancel);
        line.append(bar);
      }
      rows.append(line);
    });
    card.append(rows);
  }
  container.append(card);

  // Закрытие смены — последним: это конец дня
  const shift = el("div", "card");
  shift.append(el("div", "card__title", "Смена"));
  if (data.shift) shift.append(shiftResult(data.shift));
  const close = el("button", "btn btn--ghost", data.shift ? "Закрыть смену ещё раз" : "Закрыть смену");
  close.type = "button";
  close.addEventListener("click", () => openPanel("Закрыть смену", drawCloseShift));
  shift.append(close);
  container.append(shift);
}

function shiftResult(s) {
  const rows = el("div", "rows shift");
  const line = (label, value, cls = "") => {
    const row = el("div", `row${cls}`);
    row.append(el("div", "row__label", label));
    row.append(el("div", "row__value", value));
    rows.append(row);
  };
  line(`Насчитано в ${s.t.slice(11, 16)}`, money(s.counted));
  if (s.expected === null) {
    line("По учёту", "нет данных");
  } else {
    line("По учёту", money(s.expected));
    const row = el("div", "row row--total");
    row.append(el("div", "row__label", "Расхождение"));
    row.append(
      el("div", `row__value row__value--${Math.abs(s.diff) < 0.01 ? "paid" : "unpaid"}`,
        Math.abs(s.diff) < 0.01 ? "нет" : `${s.diff > 0 ? "+" : "−"}${money(Math.abs(s.diff))}`),
    );
    rows.append(row);
  }
  return rows;
}

async function cancelCashOp(op) {
  const reason = prompt(`Отменить ${op.kind === "in" ? "приход" : "расход"} ${money(op.sum)}?\nНапишите причину:`);
  if (reason === null) return;
  try {
    await send(`/api/cash/operation/${op.kind}/${op.id}/cancel`, { reason });
    render();
  } catch (err) {
    alert(err.message);
  }
}

// Сумма вводится крупно, с цифровой клавиатурой; запятая тоже принимается
function amountInput() {
  const wrap = el("label", "amount");
  const input = el("input", "amount__input");
  input.inputMode = "decimal";
  input.placeholder = "0";
  input.autocomplete = "off";
  wrap.append(input, el("span", "amount__unit", "с."));
  const value = () => Number(input.value.replace(/\s/g, "").replace(",", "."));
  return { wrap, input, value };
}

async function drawCashForm(kind) {
  const body = $("#sheet-body");
  body.replaceChildren(el("div", "empty", "Загружаю…"));
  let refs;
  try {
    refs = await api("/api/cash/refs");
  } catch (err) {
    body.replaceChildren(el("div", "error", err.message));
    return;
  }
  body.replaceChildren();

  const form = el("form", "card add-form");
  const sum = amountInput();
  form.append(sum.wrap);

  // Статья — только у расхода, как в МойСкладе
  let item = null;
  if (kind === "out") {
    form.append(el("div", "field__label", "Статья расхода"));
    const pills = el("div", "pills");
    refs.items.forEach((it) => {
      const pill = el("button", "pill", it.name);
      pill.type = "button";
      pill.addEventListener("click", () => {
        item = it;
        pills.querySelectorAll(".pill").forEach((p) => p.classList.toggle("is-active", p === pill));
      });
      pills.append(pill);
    });
    if (!refs.items.length) pills.append(el("div", "empty", "В МойСкладе нет статей расходов"));
    form.append(pills);
  }

  // Контрагент: по умолчанию «Без контрагента», при желании — поиск
  form.append(el("div", "field__label", kind === "in" ? "От кого" : "Кому"));
  let agent = refs.defaultAgent;
  const chosen = el("div", "chosen", agent ? agent.name : "не выбран");
  const search = el("input", "search");
  search.placeholder = "Найти контрагента";
  search.autocomplete = "off";
  const found = el("div", "rows found");
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      found.replaceChildren();
      if (q.length < 2) return;
      try {
        const res = await api(`/api/cash/agents?q=${encodeURIComponent(q)}`);
        res.agents.forEach((a) => {
          const row = el("button", "row row--tap", a.name);
          row.type = "button";
          row.addEventListener("click", () => {
            agent = a;
            chosen.textContent = a.name;
            found.replaceChildren();
            search.value = "";
          });
          found.append(row);
        });
        if (!res.agents.length) found.append(el("div", "empty", "Не найдено"));
      } catch (err) {
        found.replaceChildren(el("div", "error", err.message));
      }
    }, 250);
  });
  form.append(chosen, search, found);

  const comment = el("input", "search");
  comment.placeholder = "Комментарий, например: солярка на погрузчик";
  comment.maxLength = 300;
  form.append(comment);

  const submit = el("button", "btn btn--primary", kind === "in" ? "Записать приход" : "Записать расход");
  submit.type = "submit";
  const error = el("p", "login__error");
  error.hidden = true;
  form.append(submit, error);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const value = sum.value();
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    if (!(value > 0)) return fail("Введите сумму");
    if (kind === "out" && !item) return fail("Выберите статью расхода");
    if (!agent) return fail(kind === "in" ? "Выберите, от кого" : "Выберите, кому");
    const what = kind === "in" ? "приход" : `расход «${item.name}»`;
    if (!confirm(`Записать ${what} на ${money(value)}?`)) return;
    submit.disabled = true;
    try {
      await send("/api/cash/operation", {
        kind,
        amount: value,
        agentHref: agent.href,
        itemHref: item ? item.href : "",
        comment: comment.value,
      });
      closeSheet();
      render();
    } catch (err) {
      fail(err.message);
    } finally {
      submit.disabled = false;
    }
  });
  body.append(form);
  sum.input.focus();
}

function drawCloseShift() {
  const body = $("#sheet-body");
  body.replaceChildren();
  const form = el("form", "card add-form");
  form.append(
    el("p", "code__note", "Пересчитайте наличные в кассе и введите сумму. Расхождение с учётом сразу увидит учредитель."),
  );
  const sum = amountInput();
  form.append(sum.wrap);
  const submit = el("button", "btn btn--primary", "Закрыть смену");
  submit.type = "submit";
  const error = el("p", "login__error");
  error.hidden = true;
  form.append(submit, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = sum.value();
    if (!(value >= 0) || sum.input.value.trim() === "") {
      error.textContent = "Введите сумму";
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const result = await send("/api/cash/close", { counted: value });
      body.replaceChildren();
      const card = el("div", "card");
      card.append(el("div", "card__title", "Смена закрыта"));
      card.append(shiftResult(result));
      const done = el("button", "btn btn--primary", "Готово");
      done.type = "button";
      done.addEventListener("click", () => {
        closeSheet();
        render();
      });
      card.append(done);
      body.append(card);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
  body.append(form);
  sum.input.focus();
}

/* ── Цех (замесы и техкарты) ──────────────────────────── */

const bagsText = (n) => `${nf.format(n)} меш.`;
// 12500 кг -> «12,5 т»
const tonnes = (kg) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(kg / 1000)} т`;

async function renderProduction(container) {
  const data = await api(`/api/production?days=${state.productionDays}`);
  resetWithChips(container, state.productionDays, (days) => {
    state.productionDays = days;
    quietEntry = true;
    render();
  });
  const t = data.totals;

  const hero = el("div", "card hero");
  hero.append(el("div", "hero__label", "Выпущено"));
  hero.append(el("div", "hero__value", bagsText(t.bags)));
  hero.append(el("div", "hero__note", `≈ ${tonnes(t.kg)}`));
  container.append(hero);

  if (data.canEdit) {
    const add = el("button", "btn btn--primary", "+ Отметить замес");
    add.type = "button";
    add.disabled = !data.cards.length;
    add.addEventListener("click", () => openPanel("Замес", () => drawBatchForm(data)));
    container.append(add);
    if (!data.cards.length) container.append(el("div", "hint", "Сначала заведите техкарту марки — внизу экрана."));
  }

  const share = t.batches ? Math.round((t.corrected / t.batches) * 100) : 0;
  container.append(
    tiles([
      { label: "Замесов", value: nf.format(t.batches) },
      {
        label: "Поправляли",
        value: nf.format(t.corrected),
        tone: t.corrected ? "neg" : "",
        note: t.batches ? `${share}% замесов` : "",
        noteTone: t.corrected ? "neg" : "",
      },
      {
        label: "Химия к рецепту",
        value: `${t.extraCost > 0 ? "+" : t.extraCost < 0 ? "−" : ""}${amount(Math.abs(t.extraCost))}`,
        tone: t.extraCost > 0 ? "expense" : t.extraCost < 0 ? "pos" : "",
        note: t.extraCost > 0 ? "сверх рецепта" : t.extraCost < 0 ? "меньше рецепта" : "",
      },
    ]),
  );

  const marks = el("div", "card");
  marks.append(el("div", "card__title", "По маркам"));
  if (!data.byCard.length) {
    marks.append(el("div", "empty", "За этот период замесов нет"));
  } else {
    const rows = el("div", "rows");
    data.byCard.forEach((r) => {
      const line = el("div", "row row--stacked");
      line.append(el("div", "row__label", r.name));
      line.append(el("div", "row__value", bagsText(r.bags)));
      line.append(
        el("div", `row__note${r.corrected ? " row__note--debt" : ""}`,
          `замесов ${nf.format(r.batches)}${r.corrected ? ` · поправляли ${r.corrected}` : ""}`),
      );
      rows.append(line);
    });
    marks.append(rows);
  }
  container.append(marks);

  const recent = el("div", "card");
  recent.append(el("div", "card__title", "Последние замесы"));
  if (!data.recent.length) {
    recent.append(el("div", "empty", "Пока ничего не отмечено"));
  } else {
    const rows = el("div", "rows");
    data.recent.forEach((b) => {
      const line = el("div", `row row--stacked${b.cancelled ? " is-cancelled" : ""}`);
      line.append(el("div", "row__label", `${stamp(b.t)}  ${b.cardName} × ${b.count}`));
      line.append(el("div", "row__value", bagsText(b.bags)));
      const foot = el("div", "row__foot");
      foot.append(
        el("span", `row__tag${b.ok ? " row__tag--paid" : ""}`, b.cancelled ? "отменён" : b.ok ? "в норме" : "поправлен"),
      );
      if (b.enterId && !b.cancelled) foot.append(el("span", "row__tag row__tag--ms", "в МойСкладе"));
      if (b.amendedAt && !b.cancelled) foot.append(el("span", "row__tag row__tag--ms", `изменён ${b.amendedAt.slice(11, 16)}`));
      line.append(foot);
      // Отклонения от техкарты со знаком: +0,5 кг добавили, −0,3 кг меньше
      const fixes = (b.deltas || []).map((d) => `${d.name} ${signed(d.qty)} ${d.uom}`.trim()).join(", ");
      const about = [fixes, b.note, b.name].filter(Boolean).join(" · ");
      if (about) line.append(el("div", "row__note", about));
      if (b.editable) {
        const bar = el("div", "row__actions");
        const edit = el("button", "mini", "Изменить химию");
        edit.type = "button";
        edit.addEventListener("click", () => openPanel("Исправить замес", () => drawBatchForm(data, b)));
        bar.append(edit);
        const cancel = el("button", "mini mini--danger", "Отменить");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          const reason = prompt(`Отменить замес «${b.cardName} × ${b.count}»? Напишите причину:`);
          if (reason === null) return;
          try {
            await send(`/api/batches/${b.id}/cancel`, { reason });
            render();
          } catch (err) {
            alert(err.message);
          }
        });
        bar.append(cancel);
        line.append(bar);
      }
      rows.append(line);
    });
    recent.append(rows);
  }
  container.append(recent);

  const cards = el("div", "card");
  cards.append(el("div", "card__title", "Техкарты"));
  const rows = el("div", "rows");
  if (!data.cards.length) rows.append(el("div", "empty", "Техкарт пока нет"));
  data.cards.forEach((c) => {
    const line = el("button", "row row--tap row--stacked person");
    line.type = "button";
    line.append(el("div", "person__name", c.name));
    line.append(el("div", "row__value", `${unitPrice(c.costPerBag)} / меш.`));
    line.append(chevron());
    line.append(
      el("div", `row__note${c.missingPrices ? " row__note--debt" : ""}`,
        c.missingPrices
          ? `нет цены у ${c.missingPrices} поз. — себестоимость занижена`
          : `${c.bags} меш. с замеса · замес ${money(c.costPerBatch)}`),
    );
    line.addEventListener("click", () => openPanel(c.name, () => drawCardView(c, data.canEdit)));
    rows.append(line);
  });
  cards.append(rows);
  if (data.canEdit) {
    const add = el("button", "btn btn--ghost", "+ Новая техкарта");
    add.type = "button";
    add.addEventListener("click", () => openPanel("Новая техкарта", () => drawCardForm(null)));
    cards.append(add);
  }
  container.append(cards);

  container.append(writeOffCard(data));
}

/* Списание в МойСкладе: включает только учредитель. Пока бухгалтер
   вносит оприходование и списание вручную, включать нельзя — сырьё
   спишется дважды. */
function writeOffCard(data) {
  const card = el("div", `card${data.writeOff ? "" : " card--muted"}`);
  card.append(el("div", "card__title", "Списание в МойСкладе"));
  const missing = data.cards.filter((c) => !c.productHref).length;
  card.append(
    el(
      "p",
      "code__note",
      data.writeOff
        ? "Включено: каждый замес сам списывает сырьё и оприходует мешки в МойСкладе. Вручную их больше не вносите."
        : "Выключено: замесы видны только здесь, в МойСкладе ничего не меняется.",
    ),
  );
  if (missing) {
    card.append(
      el("p", "code__note is-neg", `У ${missing} ${missing % 10 === 1 && missing % 100 !== 11 ? "техкарты" : "техкарт"} не выбран готовый мешок из МойСклада — такие замесы при включённом списании не запишутся.`),
    );
  }
  if (!data.canToggle) return card;
  const toggle = el("button", `btn ${data.writeOff ? "btn--ghost" : "btn--primary"}`, data.writeOff ? "Выключить" : "Включить списание");
  toggle.type = "button";
  toggle.addEventListener("click", async () => {
    const ask = data.writeOff
      ? "Выключить? Новые замесы перестанут попадать в МойСклад."
      : "Включить? С этого момента каждый замес сам создаёт в МойСкладе списание сырья и оприходование мешков.\n\nБухгалтер должен перестать вносить их вручную — иначе сырьё спишется дважды.";
    if (!confirm(ask)) return;
    try {
      await send("/api/production/settings", { writeOff: !data.writeOff });
      render();
    } catch (err) {
      alert(err.message);
    }
  });
  card.append(toggle);
  return card;
}

/* Выбор товара или сырья из МойСклада: поиск по названию, нажатие —
   выбор. Цена берётся из себестоимости. */
function catalogPicker(onPick, placeholder = "Найти сырьё по названию") {
  const wrap = el("div", "picker");
  const input = el("input", "search");
  input.placeholder = placeholder;
  input.autocomplete = "off";
  const list = el("div", "rows found");
  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      list.replaceChildren();
      if (q.length < 2) return;
      try {
        const res = await api(`/api/catalog?q=${encodeURIComponent(q)}`);
        res.items.forEach((item) => {
          const row = el("button", "row row--tap");
          row.type = "button";
          row.append(el("div", "row__label", item.name));
          row.append(el("div", "row__value row__value--muted", item.cost ? `${unitPrice(item.cost)}/${item.uom || "ед."}` : "без цены"));
          row.addEventListener("click", () => {
            input.value = "";
            list.replaceChildren();
            onPick(item);
          });
          list.append(row);
        });
        if (!res.items.length) list.append(el("div", "empty", "Не найдено"));
      } catch (err) {
        list.replaceChildren(el("div", "error", err.message));
      }
    }, 250);
  });
  wrap.append(input, list);
  return wrap;
}

function numberField(label, value, attrs = {}) {
  const wrap = el("label", "field");
  wrap.append(el("span", "field__label", label));
  const input = el("input", "search field__input");
  input.inputMode = "decimal";
  input.value = value ?? "";
  Object.assign(input, attrs);
  wrap.append(input);
  const read = () => Number(String(input.value).replace(/\s/g, "").replace(",", "."));
  return { wrap, input, read };
}

// Строки сырья с количеством; общий блок для техкарты и для доливок
function qtyRows(items, onChange) {
  const list = el("div", "rows qty-rows");
  const draw = () => {
    list.replaceChildren();
    if (!items.length) list.append(el("div", "empty", "Пока пусто"));
    items.forEach((m, i) => {
      const row = el("div", "row qty-row");
      row.append(el("div", "row__label", m.name));
      const input = el("input", "qty-row__input");
      input.inputMode = "decimal";
      input.value = m.qty ? String(m.qty).replace(".", ",") : "";
      input.placeholder = "0";
      input.addEventListener("input", () => {
        m.qty = Number(input.value.replace(",", "."));
        onChange && onChange();
      });
      row.append(input, el("span", "row__unit", m.uom || ""));
      const remove = el("button", "qty-row__remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Убрать ${m.name}`);
      remove.addEventListener("click", () => {
        items.splice(i, 1);
        draw();
        onChange && onChange();
      });
      row.append(remove);
      list.append(row);
    });
  };
  draw();
  return { list, draw };
}

function drawCardView(c, canEdit) {
  const body = $("#sheet-body");
  body.replaceChildren();
  const card = el("div", "card");
  card.append(el("div", "card__title", `На один замес · ${c.bags} меш. по ${qty(c.bagKg)} кг`));
  card.append(
    el("p", `code__note${c.productHref ? "" : " is-neg"}`,
      c.productHref ? `Готовый мешок в МойСкладе: ${c.productName}` : "Готовый мешок в МойСкладе не выбран"),
  );
  const rows = el("div", "rows");
  c.materials.forEach((m) => {
    const line = el("div", "row row--stacked");
    line.append(el("div", "row__label", m.name));
    line.append(el("div", "row__value", `${qty(m.qty)} ${m.uom}`.trim()));
    line.append(
      el("div", `row__note${m.cost ? "" : " row__note--debt"}`,
        m.cost ? `${unitPrice(m.cost)} за ${m.uom || "ед."} → ${money(m.line)}` : "нет цены в МойСкладе"),
    );
    rows.append(line);
  });
  const total = el("div", "row row--total");
  total.append(el("div", "row__label", "Замес"), el("div", "row__value", money(c.costPerBatch)));
  const bag = el("div", "row row--total");
  bag.append(el("div", "row__label", "Мешок"), el("div", "row__value", unitPrice(c.costPerBag)));
  rows.append(total, bag);
  card.append(rows);
  if (c.note) card.append(el("p", "code__note", c.note));
  body.append(card);
  if (!canEdit) return;

  const edit = el("button", "btn btn--primary", "Изменить");
  edit.type = "button";
  edit.addEventListener("click", () => openPanel(c.name, () => drawCardForm(c)));
  const archive = el("button", "btn btn--ghost", "Убрать в архив");
  archive.type = "button";
  archive.addEventListener("click", async () => {
    if (!confirm(`Убрать техкарту «${c.name}» в архив? Прошлые замесы останутся.`)) return;
    try {
      await send(`/api/techcards/${c.id}/archive`);
      closeSheet();
      render();
    } catch (err) {
      alert(err.message);
    }
  });
  body.append(edit, archive);
}

function drawCardForm(c) {
  const body = $("#sheet-body");
  body.replaceChildren();
  const form = el("form", "card add-form");

  const name = el("input", "search");
  name.placeholder = "Марка, например: клей 800";
  name.maxLength = 80;
  name.value = c ? c.name : "";
  form.append(name);

  // Какой товар МойСклада оприходовать — нужен, когда включено списание
  form.append(el("div", "field__label", "Готовый мешок в МойСкладе"));
  let product = c && c.productHref ? { href: c.productHref, name: c.productName } : null;
  const productName = el("div", "chosen", product ? product.name : "не выбран");
  form.append(
    productName,
    catalogPicker((item) => {
      product = item;
      productName.textContent = item.name;
    }, "Найти мешок по названию"),
  );

  const bags = numberField("Мешков с замеса", c ? c.bags : "", { inputMode: "numeric" });
  const bagKg = numberField("Вес мешка, кг", c ? c.bagKg : 25);
  const pair = el("div", "field-pair");
  pair.append(bags.wrap, bagKg.wrap);
  form.append(pair);

  form.append(el("div", "field__label", "Сырьё на один замес"));
  const items = c ? c.materials.map((m) => ({ href: m.href, name: m.name, uom: m.uom, qty: m.qty })) : [];
  const table = qtyRows(items);
  form.append(table.list);
  form.append(
    catalogPicker((item) => {
      if (items.some((m) => m.href === item.href)) return;
      items.push({ href: item.href, name: item.name, uom: item.uom, qty: 0 });
      table.draw();
    }, "+ Добавить сырьё"),
  );

  const note = el("input", "search");
  note.placeholder = "Заметка: порядок загрузки";
  note.maxLength = 300;
  note.value = c ? c.note || "" : "";
  form.append(note);

  const submit = el("button", "btn btn--primary", "Сохранить техкарту");
  submit.type = "submit";
  const error = el("p", "login__error");
  error.hidden = true;
  form.append(submit, error);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    error.hidden = true;
    if (name.value.trim().length < 2) return fail("Напишите название марки");
    if (!(bags.read() >= 1)) return fail("Сколько мешков выходит с замеса?");
    if (!(bagKg.read() > 0)) return fail("Укажите вес мешка");
    if (!items.length) return fail("Добавьте сырьё");
    if (items.some((m) => !(m.qty > 0))) return fail("У каждого сырья укажите количество");
    submit.disabled = true;
    try {
      await send("/api/techcards", {
        id: c ? c.id : "",
        name: name.value,
        productHref: product ? product.href : "",
        productName: product ? product.name : "",
        bags: Math.round(bags.read()),
        bagKg: bagKg.read(),
        materials: items,
        note: note.value,
      });
      closeSheet();
      render();
    } catch (err) {
      fail(err.message);
      submit.disabled = false;
    }
  });
  body.append(form);
}

// +0,5 / −0,3 / 0 — отклонение со знаком, минус настоящий, а не дефис
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + qty(Math.abs(n));
// Принимает и «-0,3», и «−0,3», и «+1»
const parseSigned = (text) => Number(String(text).replace(/\s/g, "").replace("−", "-").replace(",", "."));
// Шаг кнопок: химия — по 0,1, цемент и песок — крупнее
const stepFor = (planned) => (planned >= 100 ? 10 : planned >= 10 ? 1 : 0.1);
const round3 = (n) => Math.round(n * 1000) / 1000;

/* Химия и сырьё этого замеса: по каждой строке техкарты — сколько
   положено и на сколько отклонились, кнопками «−» и «+» (на цифровой
   клавиатуре iPhone минуса нет) или вводом. Сверх техкарты можно
   добавить любое сырьё. */
function deltaRows(recipe, getCount, rows) {
  const list = el("div", "rows qty-rows");
  const draw = () => {
    list.replaceChildren();
    rows.forEach((r, i) => {
      const planned = r.perBatch * getCount();
      const line = el("div", "row row--stacked delta-row");
      line.append(el("div", "row__label", r.name));
      const minus = el("button", "delta__btn", "−");
      const input = el("input", "qty-row__input delta__input");
      const plus = el("button", "delta__btn", "+");
      minus.type = plus.type = "button";
      minus.setAttribute("aria-label", `Меньше: ${r.name}`);
      plus.setAttribute("aria-label", `Больше: ${r.name}`);
      input.inputMode = "decimal";
      input.value = r.qty ? signed(r.qty) : "0";
      const total = el("div", "row__note");
      const paint = () => {
        const fact = planned + r.qty;
        total.textContent = r.perBatch
          ? `по техкарте ${qty(planned)} ${r.uom} → положили ${qty(Math.max(fact, 0))} ${r.uom}`
          : `сверх техкарты → положили ${qty(Math.max(r.qty, 0))} ${r.uom}`;
        line.classList.toggle("is-plus", r.qty > 0);
        line.classList.toggle("is-minus", r.qty < 0);
      };
      // Меньше нуля в итоге не бывает: убавить можно только положенное
      const clamp = (v) => round3(Math.max(v, -planned));
      const step = stepFor(r.perBatch ? planned : Math.max(r.qty, 1));
      minus.addEventListener("click", () => {
        r.qty = clamp(r.qty - step);
        input.value = r.qty ? signed(r.qty) : "0";
        paint();
      });
      plus.addEventListener("click", () => {
        r.qty = clamp(r.qty + step);
        input.value = r.qty ? signed(r.qty) : "0";
        paint();
      });
      input.addEventListener("change", () => {
        const v = parseSigned(input.value);
        r.qty = Number.isFinite(v) ? clamp(v) : 0;
        input.value = r.qty ? signed(r.qty) : "0";
        paint();
      });
      const controls = el("div", "delta");
      controls.append(minus, input, plus, el("span", "row__unit", r.uom || ""));
      line.append(controls, total);
      if (!r.perBatch) {
        const remove = el("button", "qty-row__remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Убрать ${r.name}`);
        remove.addEventListener("click", () => {
          rows.splice(i, 1);
          draw();
        });
        controls.append(remove);
      }
      paint();
      list.append(line);
    });
  };
  draw();
  return { list, draw };
}

/* Замес: новый или исправление своего сегодняшнего. При исправлении
   марка и число замесов те же — меняются химия, качество и заметка. */
function drawBatchForm(data, batch = null) {
  const body = $("#sheet-body");
  body.replaceChildren();
  const form = el("form", "card add-form");

  let card = null;
  let count = batch ? batch.count : 1;
  const bagsNote = el("div", "hint");

  if (batch) {
    card = { id: batch.cardId, name: batch.cardName, materials: batch.recipe, bags: batch.bagsPerBatch || batch.bags / batch.count };
    form.append(el("div", "field__label", "Замес"));
    form.append(el("div", "chosen", `${batch.cardName} × ${batch.count} · ${bagsText(batch.bags)} · ${stamp(batch.t)}`));
  } else {
    form.append(el("div", "field__label", "Марка"));
    card = data.cards.length === 1 ? data.cards[0] : null;
    const pills = el("div", "pills");
    data.cards.forEach((c) => {
      const pill = el("button", `pill${card === c ? " is-active" : ""}`, c.name);
      pill.type = "button";
      pill.addEventListener("click", () => {
        card = c;
        pills.querySelectorAll(".pill").forEach((p) => p.classList.toggle("is-active", p === pill));
        resetRows();
        updateBags();
      });
      pills.append(pill);
    });
    form.append(pills);

    // Сколько замесов подряд — кнопками, без клавиатуры
    const stepper = el("div", "stepper");
    const minus = el("button", "stepper__btn", "−");
    const value = el("div", "stepper__value", "1");
    const plus = el("button", "stepper__btn", "+");
    minus.type = plus.type = "button";
    minus.addEventListener("click", () => {
      count = Math.max(1, count - 1);
      value.textContent = String(count);
      updateBags();
    });
    plus.addEventListener("click", () => {
      count = Math.min(100, count + 1);
      value.textContent = String(count);
      updateBags();
    });
    stepper.append(minus, value, plus);
    form.append(el("div", "field__label", "Замесов"), stepper, bagsNote);
  }

  // Строки отклонений: вся техкарта плюс то, что добавили сверх неё
  let rows = [];
  const table = el("div");
  let deltas = null;
  function resetRows() {
    const known = new Map((batch ? batch.deltas || [] : []).map((d) => [d.href, d.qty]));
    rows = (card ? card.materials : []).map((m) => ({
      href: m.href, name: m.name, uom: m.uom, perBatch: m.qty, qty: known.get(m.href) || 0,
    }));
    (batch ? batch.deltas || [] : []).forEach((d) => {
      if (!rows.some((r) => r.href === d.href)) rows.push({ href: d.href, name: d.name, uom: d.uom, perBatch: 0, qty: d.qty });
    });
    deltas = deltaRows(card ? card.materials : [], () => count, rows);
    table.replaceChildren(card ? deltas.list : el("div", "empty", "Выберите марку"));
    drawSuggestions();
  }
  function updateBags() {
    if (!batch) bagsNote.textContent = card ? `= ${bagsText(card.bags * count)}` : "";
    if (deltas) deltas.draw();
  }

  form.append(
    el("div", "field__label", "Химия и сырьё в этом замесе"),
    el("div", "hint hint--left", "Положили больше или меньше техкарты — поправьте кнопками «−» и «+»."),
    table,
  );

  // Подсказки: что добавляли сверх техкарты в прошлые разы
  const suggest = el("div", "pills");
  const addExtra = (item) => {
    if (!card || rows.some((r) => r.href === item.href)) return;
    rows.push({ href: item.href, name: item.name, uom: item.uom, perBatch: 0, qty: 0 });
    deltas.draw();
  };
  function drawSuggestions() {
    suggest.replaceChildren();
    const seen = new Map();
    data.recent.forEach((b) =>
      (b.deltas || []).forEach((d) => {
        if (!rows.some((r) => r.href === d.href)) seen.set(d.href, d);
      }),
    );
    [...seen.values()].slice(0, 8).forEach((d) => {
      const pill = el("button", "pill", `+ ${d.name}`);
      pill.type = "button";
      pill.addEventListener("click", () => {
        addExtra(d);
        pill.remove();
      });
      suggest.append(pill);
    });
  }
  form.append(suggest, catalogPicker(addExtra, "+ Другое сырьё сверх техкарты"));

  form.append(el("div", "field__label", "Качество"));
  let ok = batch ? batch.ok : true;
  const quality = el("div", "roles");
  const good = el("button", `role${ok ? " is-active" : ""}`, "В норме");
  const fixed = el("button", `role${ok ? "" : " is-active"}`, "Поправил");
  good.type = fixed.type = "button";
  const setOk = (value) => {
    ok = value;
    good.classList.toggle("is-active", ok);
    fixed.classList.toggle("is-active", !ok);
  };
  good.addEventListener("click", () => setOk(true));
  fixed.addEventListener("click", () => setOk(false));
  quality.append(good, fixed);
  form.append(quality);

  const note = el("input", "search");
  note.placeholder = "Заметка: например, сырой песок";
  note.maxLength = 300;
  note.value = batch ? batch.note || "" : "";
  form.append(note);

  const submit = el("button", "btn btn--primary", batch ? "Сохранить исправление" : "Записать замес");
  submit.type = "submit";
  const error = el("p", "login__error");
  error.hidden = true;
  form.append(submit, error);
  resetRows();
  updateBags();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fail = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    error.hidden = true;
    if (!card) return fail("Выберите марку");
    const changed = rows
      .filter((r) => Math.abs(r.qty) > 1e-9)
      .map((r) => ({ href: r.href, name: r.name, uom: r.uom, qty: r.qty }));
    if (!ok && !changed.length && !note.value.trim()) return fail("Что поправили? Измените химию или напишите заметку");
    submit.disabled = true;
    try {
      if (batch) {
        await send(`/api/batches/${batch.id}/amend`, { ok, deltas: changed, note: note.value });
      } else {
        await send("/api/batches", { cardId: card.id, count, ok, deltas: changed, note: note.value });
      }
      closeSheet();
      render();
    } catch (err) {
      fail(err.message);
      submit.disabled = false;
    }
  });
  body.append(form);
}

/* ── Профиль и доступы ────────────────────────────────── */

const ACTIONS = {
  login: "Вход",
  login_failed: "Неверный код",
  logout: "Выход",
  person_added: "Выдан доступ",
  code_reset: "Новый код",
  person_disabled: "Доступ отключён",
  person_enabled: "Доступ включён",
  cash_in: "Приход",
  cash_out: "Расход",
  cash_cancel: "Отмена в кассе",
  shift_closed: "Смена закрыта",
  techcard_saved: "Техкарта сохранена",
  techcard_archived: "Техкарта в архиве",
  batch: "Замес",
  batch_cancel: "Замес отменён",
  batch_amend: "Замес исправлен",
  writeoff_on: "Списание в МойСкладе включено",
  writeoff_off: "Списание в МойСкладе выключено",
};

// 2026-09-23T18:54:10 -> 23.09 18:54
const stamp = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}` : "—");

async function send(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError("Нужно войти заново");
  if (!res.ok) throw new Error(data.detail || `Ошибка ${res.status}`);
  return data;
}

/* Нижняя панель одна на всё: профиль, формы кассы и цеха. */
function openPanel(title, draw) {
  $("#sheet-title").textContent = title;
  $("#sheet").hidden = false;
  $("#sheet-body").scrollTop = 0;
  draw();
}

function openSheet() {
  openPanel("Профиль", drawSheet);
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-body").replaceChildren();
}

$("#me").addEventListener("click", openSheet);
document.querySelectorAll("#sheet [data-close]").forEach((node) =>
  node.addEventListener("click", closeSheet),
);

async function drawSheet() {
  const body = $("#sheet-body");
  const me = state.me;
  body.replaceChildren();

  const who = el("div", "card");
  who.append(el("div", "card__title", "Вы вошли как"));
  const line = el("div", "who");
  line.append(el("div", "who__name", me.name));
  line.append(el("div", "badge", me.roleLabel));
  who.append(line);
  const out = el("button", "btn btn--ghost", "Выйти");
  out.type = "button";
  out.addEventListener("click", async () => {
    await send("/api/logout").catch(() => {});
    closeSheet();
    state.me = null;
    showLogin();
  });
  who.append(out);
  body.append(who);

  if (!me.canManage) return;

  const staff = el("div", "card");
  staff.append(el("div", "card__title", "Доступ сотрудников"));
  const list = el("div", "rows");
  list.append(el("div", "empty", "Загружаю…"));
  staff.append(list);
  body.append(staff);

  const add = el("div", "card");
  body.append(add);

  const journal = el("div", "card");
  journal.append(el("div", "card__title", "Журнал действий"));
  const entries = el("div", "rows");
  journal.append(entries);
  body.append(journal);

  try {
    const [people, log] = await Promise.all([api("/api/people"), api("/api/audit")]);
    drawPeople(list, people.people);
    drawAddForm(add, people.roles);
    drawJournal(entries, log.entries);
  } catch (err) {
    if (err instanceof AuthError) {
      closeSheet();
      showLogin();
      return;
    }
    list.replaceChildren(el("div", "error", err.message));
  }
}

function drawPeople(list, people) {
  list.replaceChildren();
  if (!people.length) {
    list.append(el("div", "empty", "Пока никого. Добавьте сотрудника ниже."));
    return;
  }
  people.forEach((person) => {
    const row = el("div", `row row--stacked person-row${person.active ? "" : " is-off"}`);
    row.append(el("div", "row__label", person.name));
    row.append(el("div", "badge", person.roleLabel));
    row.append(
      el(
        "div",
        "row__note",
        person.active
          ? `последний вход: ${person.lastLogin ? stamp(person.lastLogin) : "ещё не входил"}`
          : "доступ отключён",
      ),
    );
    const actions = el("div", "row__actions");

    const code = el("button", "mini", "Новый код");
    code.type = "button";
    code.addEventListener("click", async () => {
      if (!confirm(`Выдать ${person.name} новый код? Старый сразу перестанет работать.`)) return;
      try {
        const res = await send(`/api/people/${person.id}/code`);
        showCode(res.name, res.code);
      } catch (err) {
        alert(err.message);
      }
    });

    const toggle = el("button", `mini${person.active ? " mini--danger" : ""}`, person.active ? "Отключить" : "Включить");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      if (person.active && !confirm(`Отключить ${person.name}? Он сразу потеряет доступ.`)) return;
      try {
        await send(`/api/people/${person.id}/active`, { active: !person.active });
        drawSheet();
      } catch (err) {
        alert(err.message);
      }
    });

    actions.append(code, toggle);
    row.append(actions);
    list.append(row);
  });
}

function drawAddForm(card, roles) {
  card.replaceChildren(el("div", "card__title", "Добавить сотрудника"));
  const form = el("form", "add-form");
  const name = el("input", "search");
  name.placeholder = "Имя, например: Мадина, кассир";
  name.maxLength = 60;
  name.autocomplete = "off";
  form.append(name);

  // Роль — крупными кнопками, а не выпадающим списком: так проще попасть
  const pick = el("div", "roles");
  let role = roles[0].id;
  roles.forEach((r) => {
    const b = el("button", `role${r.id === role ? " is-active" : ""}`, r.label);
    b.type = "button";
    b.addEventListener("click", () => {
      role = r.id;
      pick.querySelectorAll(".role").forEach((x) => x.classList.toggle("is-active", x === b));
    });
    pick.append(b);
  });
  form.append(pick);

  const submit = el("button", "btn btn--primary", "Выдать код");
  submit.type = "submit";
  form.append(submit);
  const error = el("p", "login__error");
  error.hidden = true;
  form.append(error);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      const res = await send("/api/people", { name: name.value, role });
      showCode(res.name, res.code);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  card.append(form);
}

/* Код показывается один раз: на сервере хранится только его подпись,
   и посмотреть его снова нельзя — только выдать новый. */
function showCode(name, code) {
  const body = $("#sheet-body");
  body.replaceChildren();
  const card = el("div", "card code-card");
  card.append(el("div", "card__title", `Код для: ${name}`));
  card.append(el("div", "code", code.replace(/(\d{4})(?=\d)/g, "$1 ")));
  card.append(
    el(
      "p",
      "code__note",
      "Код показывается один раз. Передайте его лично и не пересылайте в общие чаты. " +
        "Если код потеряется — выдайте новый, старый перестанет работать.",
    ),
  );
  const copy = el("button", "btn btn--ghost", "Скопировать");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = "Скопировано";
    } catch {
      copy.textContent = "Не удалось — перепишите вручную";
    }
  });
  const back = el("button", "btn btn--primary", "Готово");
  back.type = "button";
  back.addEventListener("click", drawSheet);
  card.append(copy, back);
  body.append(card);
}

function drawJournal(list, entries) {
  list.replaceChildren();
  if (!entries.length) {
    list.append(el("div", "empty", "Записей пока нет"));
    return;
  }
  entries.slice(0, 100).forEach((entry) => {
    const row = el("div", "row row--stacked");
    const warn = ["login_failed", "person_disabled", "cash_cancel", "batch_cancel"].includes(entry.action);
    row.append(el("div", "row__label", entry.who || "неизвестный"));
    row.append(el("div", `row__value${warn ? " row__value--unpaid" : ""}`, ACTIONS[entry.action] || entry.action));
    const note = [stamp(entry.t), entry.detail, entry.ip].filter(Boolean).join(" · ");
    row.append(el("div", "row__note", note));
    list.append(row);
  });
}

/* ── Графики ──────────────────────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};

function legend(items) {
  const wrap = el("div", "legend");
  items.forEach(({ label, color }) => {
    const item = el("div", "legend__item");
    const dot = el("span", "legend__dot");
    dot.style.background = color;
    item.append(dot, el("span", null, label));
    wrap.append(item);
  });
  return wrap;
}

/** Округлённый «красивый» верх шкалы, чтобы подписи сетки читались. */
function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
}

function chartFrame(rows, maxValue) {
  const host = el("div", "chart");
  const width = 320;
  const height = 152;
  const padTop = 8;
  const padBottom = 22;
  const padLeft = 42; // колонка под подписи шкалы, чтобы не лезли на данные
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft;
  const max = niceMax(maxValue);
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    role: "img",
  });
  svg.style.height = `${height}px`;

  // Сетка — приглушённая, три линии: 0, середина, максимум.
  [0, 0.5, 1].forEach((fraction) => {
    const y = padTop + plotHeight * (1 - fraction);
    svg.append(
      svgEl("line", {
        x1: padLeft, y1: y, x2: width, y2: y,
        stroke: "var(--grid)", "stroke-width": 1,
        "vector-effect": "non-scaling-stroke",
      }),
    );
    const label = svgEl("text", {
      x: padLeft - 6, y: y + 3, fill: "var(--ink-3)", "font-size": 9,
      "text-anchor": "end", "font-family": "inherit",
    });
    label.textContent = nf.format(Math.round(max * fraction));
    svg.append(label);
  });

  const xAt = (index) =>
    rows.length === 1
      ? padLeft + plotWidth / 2
      : padLeft + (index / (rows.length - 1)) * plotWidth;
  const yAt = (value) => padTop + plotHeight * (1 - Math.min(value / max, 1));

  return { host, svg, width, height, padTop, padLeft, plotWidth, plotHeight, max, xAt, yAt };
}

function xAxisLabels(frame, rows) {
  const { svg, xAt, padLeft, width, height } = frame;
  const picks = rows.length <= 2 ? rows.map((_, i) => i) : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  [...new Set(picks)].forEach((index) => {
    const anchor = index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle";
    const label = svgEl("text", {
      x: Math.min(Math.max(xAt(index), padLeft), width - 1),
      y: height - 6,
      fill: "var(--ink-3)",
      "font-size": 9.5,
      "text-anchor": anchor,
      "font-family": "inherit",
    });
    label.textContent = rows[index].label;
    svg.append(label);
  });
}

function attachTooltip(frame, rows, describe) {
  const { host, svg, width, padLeft, plotWidth, padTop, plotHeight, xAt } = frame;
  const tooltip = $("#tooltip");
  const marker = svgEl("line", {
    y1: padTop, y2: padTop + plotHeight, x1: 0, x2: 0,
    stroke: "var(--ink-3)", "stroke-width": 1, "stroke-dasharray": "3 3",
    "vector-effect": "non-scaling-stroke", opacity: 0,
  });
  svg.append(marker);

  const hide = () => {
    tooltip.hidden = true;
    marker.setAttribute("opacity", 0);
  };

  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    const plotLeft = rect.left + (padLeft / width) * rect.width;
    const ratio = (event.clientX - plotLeft) / ((plotWidth / width) * rect.width);
    const index = Math.max(0, Math.min(rows.length - 1, Math.round(ratio * (rows.length - 1))));
    const x = xAt(index);
    marker.setAttribute("x1", x);
    marker.setAttribute("x2", x);
    marker.setAttribute("opacity", 1);
    tooltip.innerHTML = describe(rows[index]);
    tooltip.hidden = false;
    const left = rect.left + (x / width) * rect.width;
    tooltip.style.left = `${Math.min(Math.max(left, 70), window.innerWidth - 70)}px`;
    tooltip.style.top = `${rect.top - 8}px`;
  };

  host.addEventListener("pointerdown", move);
  host.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" || event.pressure > 0 || event.buttons) move(event);
  });
  host.addEventListener("pointerup", hide);
  host.addEventListener("pointerleave", hide);
  host.addEventListener("pointercancel", hide);
}

function lineChart(rows, series) {
  const maxValue = Math.max(...rows.flatMap((row) => series.map((s) => row[s.key])), 0);
  const frame = chartFrame(rows, maxValue);
  const { svg, xAt, yAt } = frame;

  series.forEach((s) => {
    const points = rows.map((row, index) => `${xAt(index)},${yAt(row[s.key])}`);
    if (rows.length === 1) {
      const [x, y] = points[0].split(",");
      svg.append(svgEl("circle", { cx: x, cy: y, r: 4, fill: s.color }));
      return;
    }
    svg.append(
      svgEl("polyline", {
        points: points.join(" "),
        fill: "none",
        stroke: s.color,
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "vector-effect": "non-scaling-stroke",
      }),
    );
  });

  xAxisLabels(frame, rows);
  frame.host.append(svg);
  // Подпись собирается из самих серий — так она верна для любого
  // графика, а не только для доходов с расходами.
  attachTooltip(
    frame,
    rows,
    (row) =>
      `<b>${row.label}</b>` +
      series.map((s) => `<br>${s.label}: ${money(row[s.key])}`).join(""),
  );
  return frame.host;
}

function barChart(rows) {
  const maxValue = Math.max(...rows.map((row) => row.amount), 0);
  const frame = chartFrame(rows, maxValue);
  const { svg, width, padLeft, plotWidth, xAt, yAt, padTop, plotHeight } = frame;

  const slot = plotWidth / rows.length;
  const barWidth = Math.max(1.5, Math.min(slot - 2, 20));
  const radius = barWidth >= 6 ? 2 : 0;

  rows.forEach((row, index) => {
    const y = yAt(row.amount);
    const x = xAt(index) - barWidth / 2;
    svg.append(
      svgEl("rect", {
        x: Math.min(Math.max(x, padLeft), width - barWidth),
        y,
        width: barWidth,
        height: Math.max(padTop + plotHeight - y, 1),
        rx: radius,
        fill: "var(--expense)",
      }),
    );
  });

  xAxisLabels(frame, rows);
  frame.host.append(svg);
  attachTooltip(frame, rows, (row) => `<b>${row.label}</b><br>${money(row.amount)}`);
  return frame.host;
}

/* ── Старт ────────────────────────────────────────────── */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}

api("/api/session")
  .then((data) => (data.authenticated ? showApp(data) : showLogin()))
  .catch(showLogin);
