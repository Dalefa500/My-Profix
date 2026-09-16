#!/usr/bin/env node
// Управление учётными записями учредителей из командной строки.
//
//   node server/manage-users.js список
//   node server/manage-users.js добавить <логин> "<имя>" <код> [admin|viewer]
//   node server/manage-users.js пароль <логин> <новый-код>
//   node server/manage-users.js роль <логин> admin|viewer
//   node server/manage-users.js удалить <логин>
//
// Роли: admin — вносит, правит и удаляет; viewer — только просмотр.
// Команды принимаются и на латинице: list / add / password / role / delete.

import { loadUsers, createUser, setPassword, setRole, deleteUser } from './auth.js';
import { ensureDir } from './storage.js';

const [command = '', ...args] = process.argv.slice(2);

const ALIASES = {
  'список': 'list', list: 'list',
  'добавить': 'add', add: 'add',
  'пароль': 'password', password: 'password',
  'роль': 'role', role: 'role',
  'удалить': 'delete', delete: 'delete',
};

const ROLE_LABEL = { admin: 'полный доступ', viewer: 'только просмотр' };

function usage() {
  console.log([
    'Команды:',
    '  node server/manage-users.js список',
    '  node server/manage-users.js добавить <логин> "<имя>" <код> [admin|viewer]',
    '  node server/manage-users.js пароль <логин> <новый-код>',
    '  node server/manage-users.js роль <логин> admin|viewer',
    '  node server/manage-users.js удалить <логин>',
  ].join('\n'));
}

await ensureDir();

switch (ALIASES[command.toLowerCase()]) {
  case 'list': {
    const users = await loadUsers();
    if (!users.length) {
      console.log('Пользователей пока нет. Они создаются при первом запуске сервера.');
      break;
    }
    for (const user of users) {
      const role = user.role === 'viewer' ? 'viewer' : 'admin';
      console.log(`${user.login} — ${user.name} · ${ROLE_LABEL[role]}`);
    }
    break;
  }
  case 'add': {
    const [login, name, password, role = 'admin'] = args;
    if (!login || !password) {
      console.error('Нужно указать логин и код входа');
      process.exit(1);
    }
    if (password.length < 4) {
      console.error('Код должен быть не короче 4 символов');
      process.exit(1);
    }
    const user = await createUser({ login, name: name || login, password, role });
    console.log(`Создан пользователь ${user.login} (${user.name}) · ${ROLE_LABEL[user.role]}`);
    break;
  }
  case 'role': {
    const [login, role] = args;
    if (!login || !role) {
      console.error('Нужно указать логин и роль: admin или viewer');
      process.exit(1);
    }
    try {
      const user = await setRole(login, role);
      console.log(`${user.login}: ${ROLE_LABEL[user.role]}`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  case 'delete': {
    const [login] = args;
    if (!login) {
      console.error('Нужно указать логин');
      process.exit(1);
    }
    try {
      await deleteUser(login);
      console.log(`Пользователь ${login} удалён`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  case 'password': {
    const [login, password] = args;
    if (!login || !password) {
      console.error('Нужно указать логин и новый код');
      process.exit(1);
    }
    if (password.length < 4) {
      console.error('Код должен быть не короче 4 символов');
      process.exit(1);
    }
    try {
      await setPassword(login, password);
      console.log(`Код для ${login} изменён`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  default:
    usage();
}
