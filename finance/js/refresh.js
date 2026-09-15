// Перерисовка текущего экрана без циклических зависимостей между модулями.

let handler = () => {};

export function setRefresh(fn) {
  handler = fn;
}

export function refresh() {
  handler();
}
