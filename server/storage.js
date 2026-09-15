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
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function appendLine(name, value) {
  await ensureDir();
  await fs.appendFile(filePath(name), `${JSON.stringify(value)}\n`, 'utf8');
}

// Последовательная очередь записи: изменения не перемешиваются,
// даже если оба учредителя сохраняют одновременно.
let chain = Promise.resolve();
export function withLock(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}
