// Навигация по адресной строке: #/projects, #/projects/prj_1 и так далее.

const routes = [];
let notFound = null;
let current = { path: '#/', params: [] };

export function route(pattern, handler) {
  routes.push({ pattern, handler });
}

export function setNotFound(handler) {
  notFound = handler;
}

export function currentRoute() {
  return current;
}

export function go(path) {
  if (window.location.hash === path) {
    resolve();
    return;
  }
  window.location.hash = path;
}

export function resolve() {
  const hash = window.location.hash || '#/';
  const path = hash.replace(/^#/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  for (const item of routes) {
    const parts = item.pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    const matched = parts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(segments[index]);
        return true;
      }
      return part === segments[index];
    });
    if (matched) {
      current = { path: hash, pattern: item.pattern, params };
      item.handler(params);
      return;
    }
  }
  current = { path: hash, pattern: null, params: {} };
  notFound?.();
}

export function start() {
  window.addEventListener('hashchange', resolve);
  resolve();
}
