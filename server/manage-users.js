#!/usr/bin/env node
// Управление учётными записями учредителей из командной строки.
//
//   node server/manage-users.js список
//   node server/manage-users.js добавить <логин> "<имя>" <пароль>
//   node server/manage-users.js пароль <логин> <новый-пароль>
//
// Команды принимаются и на латинице: list / add / password.

import { loadUsers, createUser, setPassword } from './auth.js';
import { ensureDir } from './storage.js';

const [command = '', ...args] = process.argv.slice(2);

const ALIASES = {
  'список': 'list', list: 'list',
  'добавить': 'add', add: 'add',
  'пароль': 'password', password: 'password',
};

function usage() {
  console.log([
    'Команды:',
    '  node server/manage-users.js список',
    '  node server/manage-users.js добавить <логин> "<имя>" <пароль>',
    '  node server/manage-users.js пароль <логин> <новый-пароль>',
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
    for (const user of users) console.log(`${user.login} — ${user.name}`);
    break;
  }
  case 'add': {
    const [login, name, password] = args;
    if (!login || !password) {
      console.error('Нужно указать логин и пароль');
      process.exit(1);
    }
    if (password.length < 8) {
      console.error('Пароль должен быть не короче 8 символов');
      process.exit(1);
    }
    const user = await createUser({ login, name: name || login, password });
    console.log(`Создан пользователь ${user.login} (${user.name})`);
    break;
  }
  case 'password': {
    const [login, password] = args;
    if (!login || !password) {
      console.error('Нужно указать логин и новый пароль');
      process.exit(1);
    }
    if (password.length < 8) {
      console.error('Пароль должен быть не короче 8 символов');
      process.exit(1);
    }
    await setPassword(login, password);
    console.log(`Пароль для ${login} изменён`);
    break;
  }
  default:
    usage();
}
