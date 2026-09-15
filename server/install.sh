#!/usr/bin/env bash
#
# Установка приложения «Line Design — финансы студии» на чистый сервер
# Ubuntu 22.04/24.04. Запускать от имени root на только что купленном сервере:
#
#   bash install.sh finance.example.com почта@пример.ru
#
# Домен и почта нужны для бесплатного сертификата HTTPS. Можно запустить
# и без них — тогда приложение будет работать по адресу http://IP-сервера,
# без шифрования (так оставлять надолго не стоит).
#
# Проверить, что скрипт сделает, ничего не меняя:
#
#   DRY_RUN=1 bash install.sh finance.example.com почта@пример.ru

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
DRY_RUN="${DRY_RUN:-0}"

REPO="${REPO:-https://github.com/Dalefa500/powermix-site.git}"
BRANCH="${BRANCH:-claude/design-studio-finance-app-cuden1}"
APP_USER="line-design"
APP_DIR="/opt/line-design-app"
APP_DATA="/var/lib/line-design-finance"
APP_PORT="3000"
NODE_MAJOR="22"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   + %s\n' "$*"
  else
    "$@"
  fi
}

# write <путь> — содержимое берётся со стандартного ввода
write() {
  local path="$1" content
  content="$(cat)"
  if [ "$DRY_RUN" = "1" ]; then
    printf '   + записать файл %s\n' "$path"
  else
    printf '%s\n' "$content" > "$path"
  fi
}

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then
  echo "Запустите скрипт от имени root: sudo bash install.sh ..." >&2
  exit 1
fi

if [ -n "$DOMAIN" ]; then
  note "Домен: $DOMAIN"
else
  note "Домен не указан — приложение будет доступно только по адресу сервера, без HTTPS."
fi

say "1/9 Обновляем систему и ставим нужные программы"
run apt-get update -y
run apt-get upgrade -y
run apt-get install -y git nginx ufw ca-certificates curl

say "2/9 Устанавливаем Node.js ${NODE_MAJOR}"
if [ "$DRY_RUN" = "1" ]; then
  note "+ установка Node.js из репозитория NodeSource"
elif command -v node >/dev/null && node --version | grep -q "^v${NODE_MAJOR}"; then
  note "Node.js уже установлен: $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  note "Установлен Node.js $(node --version)"
fi

say "3/9 Создаём отдельного пользователя для приложения"
if [ "$DRY_RUN" = "1" ]; then
  note "+ adduser --system --group --home /opt/${APP_USER} ${APP_USER}"
elif id "$APP_USER" >/dev/null 2>&1; then
  note "Пользователь ${APP_USER} уже есть"
else
  adduser --system --group --home "/opt/${APP_USER}" "$APP_USER"
fi

say "4/9 Загружаем код приложения"
if [ "$DRY_RUN" = "1" ]; then
  note "+ git clone ${REPO} ${APP_DIR} (ветка ${BRANCH})"
elif [ -d "$APP_DIR/.git" ]; then
  note "Код уже загружен — обновляем"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
run chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"

say "5/9 Готовим папку для данных"
run mkdir -p "$APP_DATA"
run chown "${APP_USER}:${APP_USER}" "$APP_DATA"
run chmod 750 "$APP_DATA"
note "Данные компании будут храниться в ${APP_DATA} — эта папка не затрагивается при обновлении."

say "6/9 Настраиваем автозапуск приложения"
write /etc/systemd/system/line-design.service <<UNIT
[Unit]
Description=Line Design — финансы студии
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/server.js
Environment=HOST=127.0.0.1
Environment=PORT=${APP_PORT}
Environment=DATA_DIR=${APP_DATA}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${APP_DATA}

[Install]
WantedBy=multi-user.target
UNIT
run systemctl daemon-reload
run systemctl enable --now line-design
if [ "$DRY_RUN" != "1" ]; then
  sleep 2
  systemctl is-active --quiet line-design \
    && note "Приложение запущено" \
    || { echo "Приложение не запустилось. Посмотрите: journalctl -u line-design -n 50" >&2; exit 1; }
fi

say "7/9 Настраиваем nginx"
write /etc/nginx/sites-available/line-design <<NGINX
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
run ln -sf /etc/nginx/sites-available/line-design /etc/nginx/sites-enabled/line-design
run rm -f /etc/nginx/sites-enabled/default
run nginx -t
run systemctl reload nginx

run ufw allow OpenSSH
run ufw allow 'Nginx Full'
run ufw --force enable
note "Порт приложения наружу закрыт: снаружи отвечает только nginx."

say "8/9 Сертификат HTTPS"
if [ -z "$DOMAIN" ]; then
  note "Домен не указан — сертификат не выпускаем."
elif [ "$DRY_RUN" = "1" ]; then
  note "+ certbot --nginx -d ${DOMAIN}"
else
  apt-get install -y certbot python3-certbot-nginx
  # Если A-запись домена ещё не указывает на этот сервер, сертификат не
  # выпустится. Это не повод прерывать установку: приложение уже работает,
  # сертификат можно выпустить позже одной командой.
  certbot_ok=1
  if [ -n "$EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || certbot_ok=0
  else
    certbot --nginx -d "$DOMAIN" --redirect || certbot_ok=0
  fi
  if [ "$certbot_ok" = "1" ]; then
    note "Сертификат выпущен и будет продлеваться автоматически."
  else
    note "Сертификат пока не выпущен — скорее всего, A-запись домена ещё не обновилась."
    note "Приложение уже работает по адресу http://${DOMAIN}/finance/"
    note "Когда домен заработает, выпустите сертификат: certbot --nginx -d ${DOMAIN} --redirect"
  fi
fi

say "9/9 Настраиваем ежедневные резервные копии"
write /etc/cron.daily/line-design-backup <<'BACKUP'
#!/bin/sh
# Ежедневная копия данных приложения. Хранится 30 дней.
set -e
mkdir -p /var/backups/line-design
tar -czf "/var/backups/line-design/$(date +%F).tar.gz" -C /var/lib line-design-finance
find /var/backups/line-design -name '*.tar.gz' -mtime +30 -delete
BACKUP
run chmod +x /etc/cron.daily/line-design-backup
run mkdir -p /var/backups/line-design
note "Копии складываются в /var/backups/line-design, хранятся 30 дней."

say "Готово"
if [ -n "$DOMAIN" ]; then
  note "Приложение: https://${DOMAIN}/finance/"
else
  note "Приложение: http://$(hostname -I 2>/dev/null | awk '{print $1}')/finance/"
fi

if [ "$DRY_RUN" != "1" ] && [ -f "${APP_DATA}/ПАРОЛИ-ПРИ-ПЕРВОМ-ЗАПУСКЕ.txt" ]; then
  say "Логины и пароли учредителей (смените их после первого входа)"
  cat "${APP_DATA}/ПАРОЛИ-ПРИ-ПЕРВОМ-ЗАПУСКЕ.txt"
fi

note "Данные компании: ${APP_DATA}"
note "Резервные копии: /var/backups/line-design (ежедневно, хранятся 30 дней)"
note "Обновление: git -C ${APP_DIR} pull && systemctl restart line-design"
