# Размещение приложения на сервере TimeWeb

Инструкция написана для чистого сервера. Все команды можно копировать
подряд. Дальше `ВАШ_IP` — адрес сервера, `finance.example.com` — ваш домен.

---

## 1. Какой сервер покупать

В TimeWeb нужен **облачный сервер (VDS)**, а не «хостинг сайтов».
На обычном хостинге нельзя держать постоянно работающую программу Node.js,
а нашему приложению это нужно.

Минимальной конфигурации достаточно:

| Параметр | Значение |
|---|---|
| Процессор | 1 ядро |
| Память | 1 ГБ |
| Диск | 10–15 ГБ |
| Система | Ubuntu 24.04 LTS |

Приложение лёгкое: отдельная база данных не нужна, все данные — это
несколько файлов. Место на диске занимает в основном система.

Локацию выбирайте ближе к Душанбе — так приложение будет отзывчивее.

## 2. Домен

Для работы по HTTPS нужен домен или поддомен, например
`finance.linedesign.tj`. В панели управления доменом добавьте
**A-запись**, которая указывает на `ВАШ_IP`.

Без домена приложение тоже работает — по адресу `http://ВАШ_IP/`, — но
тогда соединение не будет зашифровано. Для финансовых данных так оставлять
не стоит.

---

## 2а. Установка одной командой

Если сервер только что куплен и на нём чистая Ubuntu, всё описанное ниже
делает один скрипт. Подключитесь по SSH и выполните:

```bash
apt update && apt install -y git
git clone -b claude/design-studio-finance-app-cuden1 \
  https://github.com/Dalefa500/powermix-site.git /opt/line-design-app
bash /opt/line-design-app/server/install.sh finance.example.com почта@пример.ru
```

Скрипт поставит Node.js и nginx, настроит автозапуск и HTTPS, закроет
лишние порты и покажет логины с паролями учредителей.

Посмотреть, что скрипт сделает, ничего не меняя:

```bash
DRY_RUN=1 bash /opt/line-design-app/server/install.sh finance.example.com
```

Дальше — те же шаги вручную, если хочется всё контролировать.

## 3. Подготовка сервера

Подключитесь по SSH (в TimeWeb есть и консоль прямо в браузере):

```bash
ssh root@ВАШ_IP
```

Обновите систему и поставьте всё нужное:

```bash
apt update && apt upgrade -y
apt install -y git nginx ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version          # должно показать v22.x
```

Закройте лишние порты:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

Порт самого приложения (3000) наружу не открываем — к нему будет
обращаться только nginx со стороны сервера.

## 4. Отдельный пользователь для приложения

Так безопаснее: приложение не работает от имени администратора.

```bash
adduser --system --group --home /opt/line-design line-design
```

## 5. Код приложения

```bash
cd /opt
git clone https://github.com/Dalefa500/powermix-site.git line-design-app
cd line-design-app
git checkout claude/design-studio-finance-app-cuden1
chown -R line-design:line-design /opt/line-design-app
```

(Когда ветка будет влита в `main`, шаг `git checkout` не понадобится.)

## 6. Папка с данными

Данные храним отдельно от кода — чтобы обновление приложения их не задело:

```bash
mkdir -p /var/lib/line-design-finance
chown line-design:line-design /var/lib/line-design-finance
chmod 750 /var/lib/line-design-finance
```

## 7. Автозапуск приложения

Создайте файл `/etc/systemd/system/line-design.service`:

```ini
[Unit]
Description=Line Design — финансы студии
After=network.target

[Service]
Type=simple
User=line-design
Group=line-design
WorkingDirectory=/opt/line-design-app
ExecStart=/usr/bin/node server/server.js
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/line-design-finance
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Запустите:

```bash
systemctl daemon-reload
systemctl enable --now line-design
systemctl status line-design        # должно быть «active (running)»
```

**Важно:** при первом запуске в журнале появятся логины и пароли двух
учредителей. Посмотрите их:

```bash
journalctl -u line-design | head -20
cat /var/lib/line-design-finance/ПАРОЛИ-ПРИ-ПЕРВОМ-ЗАПУСКЕ.txt
```

Запишите пароли и сразу смените их в приложении.

## 8. nginx и HTTPS

Создайте файл `/etc/nginx/sites-available/line-design`:

```nginx
server {
    listen 80;
    server_name finance.example.com;

    # размер запроса ограничиваем: приложение передаёт только текстовые данные
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Заголовок `X-Forwarded-Proto` обязателен: по нему приложение понимает,
что соединение защищённое, и помечает куку входа как `Secure`.

Включите сайт и выпустите сертификат:

```bash
ln -s /etc/nginx/sites-available/line-design /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d finance.example.com
```

Certbot сам добавит переадресацию с http на https и будет продлевать
сертификат автоматически.

Откройте `https://finance.example.com` — появится экран входа.

---

## 9. Резервные копии

Данные — это папка `/var/lib/line-design-finance`. Сделайте ежедневную
копию: создайте файл `/etc/cron.daily/line-design-backup`

```bash
#!/bin/sh
mkdir -p /var/backups/line-design
tar -czf "/var/backups/line-design/$(date +%F).tar.gz" -C /var/lib line-design-finance
# храним копии за последние 30 дней
find /var/backups/line-design -name '*.tar.gz' -mtime +30 -delete
```

и сделайте его исполняемым:

```bash
chmod +x /etc/cron.daily/line-design-backup
```

Дополнительно включите в панели TimeWeb автоматические снимки (snapshot)
сервера — это защитит от поломки самого сервера, а не только файлов.
Копии полезно иногда скачивать себе на компьютер:

```bash
scp root@ВАШ_IP:/var/backups/line-design/*.tar.gz ./
```

## 10. Обновление приложения

```bash
cd /opt/line-design-app
git pull
systemctl restart line-design
```

Данные при обновлении не затрагиваются — они лежат в отдельной папке.

## 11. Если что-то не работает

```bash
systemctl status line-design        # работает ли приложение
journalctl -u line-design -n 50     # последние сообщения приложения
nginx -t                            # проверка настроек nginx
journalctl -u nginx -n 50           # сообщения nginx
```

Частые причины:

* **502 в браузере** — приложение не запущено, смотрите `systemctl status`.
* **Вход не запоминается** — в настройках nginx нет строки
  `proxy_set_header X-Forwarded-Proto $scheme;`.
* **Сертификат не выпускается** — A-запись домена ещё не обновилась,
  подождите и повторите `certbot`.

## 12. Добавить или сменить пароль учредителя

```bash
cd /opt/line-design-app
sudo -u line-design DATA_DIR=/var/lib/line-design-finance \
  node server/manage-users.js список
sudo -u line-design DATA_DIR=/var/lib/line-design-finance \
  node server/manage-users.js пароль osnovatel1 новый-пароль
```

Обычно это не нужно: пароль меняется прямо в приложении —
**Ещё → Настройки → Пароль**.
