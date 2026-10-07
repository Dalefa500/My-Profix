// Файловое хранилище сервера. Пишем атомарно (сначала во временный файл,
// потом переименовываем), чтобы данные не испортились при сбое питания.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(new URL('./data', import.meta.url).pathname);

export async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export function filePath(name) {
  return path.join(DATA_DIR, name);
}

export async function readJSON(name, fallback) {
  try {
    const raw = await fs.readFile(filePath(name), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJSON(name, value) {
  await ensureDir();
  const target = filePath(name);
  // Своё временное имя у каждой записи: две одновременные записи одного
  // файла не должны писать в один и тот же временный файл.
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

// Журнал не растёт бесконечно: дорос до LOG_LIMIT — прежний откладывается
// в «<имя>.old» (одна предыдущая часть), и журнал начинается заново.
const LOG_LIMIT = 20 * 1024 * 1024;

export async function appendLine(name, value) {
  await ensureDir();
  const target = filePath(name);
  try {
    const { size } = await fs.stat(target);
    if (size > LOG_LIMIT) await fs.rename(target, `${target}.old`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.appendFile(target, `${JSON.stringify(value)}\n`, 'utf8');
}

// Последовательная очередь записи: изменения не перемешиваются,
// даже если оба учредителя сохраняют одновременно.
let chain = Promise.resolve();
export function withLock(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// Отдельная очередь для файлов входа (пользователи, сессии, Face ID):
// «прочитать — изменить — записать» не должно перемешиваться между
// одновременными запросами, иначе изменения теряются.
let authChain = Promise.resolve();
export function withAuthLock(task) {
  const run = authChain.then(task, task);
  authChain = run.then(() => undefined, () => undefined);
  return run;
}
