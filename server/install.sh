#!/usr/bin/env bash
#
# Установка приложения «Финансы студии» на сервер Ubuntu 22.04/24.04.
# Запускать от имени root.
#
# Первая (основная) копия — Line Design:
#
#   bash install.sh finance.example.com почта@пример.ru
#
# Ещё одна компания на том же сервере — со своим коротким именем (slug),
# своим доменом, своими данными и своей службой. Первую копию это не трогает:
#
#   APP_SLUG=nova COMPANY_NAME="Nova Interiors" BRAND_COLOR="#1f5f8b" \
#   BOOTSTRAP_USERS="ali:Али:admin,vali:Вали:viewer" \
#   bash install.sh finance.nova.tj почта@пример.ru
#
# Проверить, что скрипт сделает, ничего не меняя: добавьте DRY_RUN=1.
#
# Настройки (все необязательные):
#   APP_SLUG          короткое латинское имя копии (по умолчанию line-design)
#   APP_PORT          порт приложения (по умолчанию 3000 у line-design,
#                     для остальных — первый свободный начиная с 3001)
#   COMPANY_NAME      название компании — в шапке, на экране входа, в PDF
#   BRAND_WORDMARK    надпись знака (по умолчанию — название компании)
#   BRAND_SUBTITLE    подпись под знаком на экране входа (Studio)
#   BRAND_TAGLINE     строка под знаком и в шапке PDF
#   BRAND_INITIALS    буквы значка вкладки браузера
#   BRAND_COLOR       фирменный цвет, #rrggbb
#   BOOTSTRAP_USERS   учётные записи первого запуска: логин:Имя:роль,...
#                     роль admin (всё) или viewer (только просмотр)
#   AUTH_DISABLED=1   открыть приложение без входа (не рекомендуется)
#   NGINX_OVERWRITE=1 переписать уже существующий файл nginx этой копии
#                     (certbot дописывает в него HTTPS — без нужды не трогать)
#   FULL_UPGRADE=1    обновить все пакеты системы (по умолчанию — только
#                     на чистом сервере, где nginx ещё не стоит)

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
APT_OPTS="-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

DOMAIN="${1:-}"
EMAIL="${2:-}"
DRY_RUN="${DRY_RUN:-0}"

REPO="${REPO:-https://github.com/Dalefa500/powermix-site.git}"
BRANCH="${BRANCH:-claude/design-studio-finance-app-cuden1}"

APP_SLUG="$(printf '%s' "${APP_SLUG:-line-design}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')"
[ -n "$APP_SLUG" ] || APP_SLUG="line-design"
# Имя копии становится именем пользователя, службы и папок — оно не должно
# совпасть с системными (nginx, root, ssh…) и должно начинаться с буквы.
case "$APP_SLUG" in
  [a-z]*) ;;
  *) printf '\nAPP_SLUG должен начинаться с латинской буквы: %s\n' "$APP_SLUG" >&2; exit 1 ;;
esac
if [ "${#APP_SLUG}" -gt 30 ]; then
  printf '\nAPP_SLUG слишком длинный (больше 30 знаков): %s\n' "$APP_SLUG" >&2; exit 1
fi
case "$APP_SLUG" in
  root|nginx|www-data|ssh|sshd|systemd|systemd-*|cron|ufw|node|nodejs|certbot|letsencrypt|mysql|postgres|redis|docker|ubuntu|daemon|bin|sys|nobody|backup|mail|news|proxy|syslog|default|html)
    printf '\nAPP_SLUG «%s» совпадает с системным именем — выберите другое.\n' "$APP_SLUG" >&2; exit 1 ;;
esac
IS_MAIN=0
[ "$APP_SLUG" = "line-design" ] && IS_MAIN=1

APP_USER="${APP_USER:-$APP_SLUG}"
APP_DIR="${APP_DIR:-/opt/${APP_SLUG}-app}"
APP_DATA="${APP_DATA:-/var/lib/${APP_SLUG}-finance}"
UNIT="${APP_SLUG}"
NGINX_SITE="${APP_SLUG}"
ENV_DIR="/etc/${APP_SLUG}"
ENV_FILE="${ENV_DIR}/app.env"
BRAND_DIR="${ENV_DIR}/brand"
BACKUP_DIR="/var/backups/${APP_SLUG}"
CRON_FILE="/etc/cron.daily/${APP_SLUG}-backup"
NODE_MAJOR="22"
NODE_MIN="18"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

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
    printf '   + записать файл %s:\n' "$path"
    printf '%s\n' "$content" | sed 's/^/     | /'
  else
    printf '%s\n' "$content" > "$path"
  fi
}

port_in_use() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then
  fail "Запустите скрипт от имени root: sudo bash install.sh ..."
fi

# ---------------------------------------------------------------- проверки

if [ "$IS_MAIN" != "1" ] && [ -z "$DOMAIN" ]; then
  fail "Для второй компании нужен свой домен или поддомен: bash install.sh finance.domen.tj почта@..."
fi

# Порт: у основной копии 3000, у остальных — уже записанный в службе
# или первый свободный.
EXISTING_UNIT="/etc/systemd/system/${UNIT}.service"
# Не трогаем чужое: служба, пользователь и сайт nginx с таким же именем
# могут принадлежать другой программе (например, боту).
if [ -f "$EXISTING_UNIT" ] && ! grep -qx "WorkingDirectory=${APP_DIR}" "$EXISTING_UNIT"; then
  fail "Служба ${UNIT} уже есть и относится к другой программе. Выберите другое имя: APP_SLUG=..."
fi
if [ ! -f "$EXISTING_UNIT" ] && id "$APP_USER" >/dev/null 2>&1 \
  && [ "$(getent passwd "$APP_USER" | cut -d: -f6)" != "/opt/${APP_USER}" ]; then
  fail "Пользователь ${APP_USER} уже есть в системе. Выберите другое имя: APP_SLUG=..."
fi
if [ -z "${APP_PORT:-}" ] && [ -f "$EXISTING_UNIT" ]; then
  APP_PORT="$(sed -n 's/^Environment=PORT=//p' "$EXISTING_UNIT" | head -1)"
fi
if [ -z "${APP_PORT:-}" ]; then
  if [ "$IS_MAIN" = "1" ]; then
    APP_PORT=3000
  else
    # Свободный порт, который не занят сейчас и не записан ни в одной
    # другой службе (та может быть просто остановлена).
    # Учитываем и порты, на которые nginx уже отправляет запросы (бот может
    # как раз перезапускаться и не слушать порт в эту секунду).
    taken_ports="$( {
      sed -n 's/^Environment=PORT=//p' /etc/systemd/system/*.service 2>/dev/null || true
      { grep -Rhos 'PORT=[0-9]*' /etc/systemd/system/ /etc/*/app.env 2>/dev/null || true; } | cut -d= -f2
      { grep -Rhos '127\.0\.0\.1:[0-9]*\|localhost:[0-9]*' /etc/nginx/ 2>/dev/null || true; } | cut -d: -f2
    } | tr '\n' ' ' || true)"
    APP_PORT=3001
    while port_in_use "$APP_PORT" || printf ' %s ' "$taken_ports" | grep -q " ${APP_PORT} "; do
      APP_PORT=$((APP_PORT + 1))
    done
  fi
fi
if port_in_use "$APP_PORT" && ! systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  fail "Порт ${APP_PORT} уже занят другой программой. Укажите свободный: APP_PORT=3002 bash install.sh ..."
fi

# Режим входа сохраняется таким, какой уже стоит в службе, если его не передали.
if [ -z "${AUTH_DISABLED:-}" ]; then
  AUTH_DISABLED="$( [ -f "$EXISTING_UNIT" ] && sed -n 's/^Environment=AUTH_DISABLED=//p' "$EXISTING_UNIT" | head -1 || true)"
  AUTH_DISABLED="${AUTH_DISABLED:-0}"
fi

# Чужие данные не трогаем.
if [ -d "$APP_DATA" ] && id "$APP_USER" >/dev/null 2>&1; then
  owner="$(stat -c %U "$APP_DATA")"
  if [ "$owner" != "$APP_USER" ] && [ "$owner" != "root" ]; then
    fail "Папка ${APP_DATA} принадлежит пользователю ${owner}, а не ${APP_USER}. Похоже, это данные другой копии."
  fi
fi

note "Компания: ${COMPANY_NAME:-(как раньше)} · копия ${APP_SLUG}"
note "Код: ${APP_DIR} · данные: ${APP_DATA} · порт: ${APP_PORT} · служба: ${UNIT}"
if [ -n "$DOMAIN" ]; then
  note "Домен: $DOMAIN"
else
  note "Домен не указан — приложение будет доступно по адресу сервера, без HTTPS."
fi

# ---------------------------------------------------------------- установка

say "1/9 Программы"
if [ "${FULL_UPGRADE:-0}" = "1" ] || ! command -v nginx >/dev/null 2>&1; then
  run apt-get update -y
  # shellcheck disable=SC2086
  run apt-get upgrade -y $APT_OPTS
  run apt-get install -y git nginx ufw ca-certificates curl
else
  note "Сервер уже настроен — общее обновление пакетов пропускаем (FULL_UPGRADE=1, чтобы обновить)."
  command -v git >/dev/null 2>&1 || run apt-get install -y git
fi

say "2/9 Node.js"
node_major_installed() {
  command -v node >/dev/null || return 1
  node --version | sed 's/^v\([0-9]*\).*/\1/'
}
if [ "$DRY_RUN" = "1" ]; then
  note "+ проверка/установка Node.js ${NODE_MIN}+"
elif [ "$(node_major_installed || echo 0)" -ge "$NODE_MIN" ] 2>/dev/null; then
  note "Node.js уже установлен: $(node --version)"
else
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - && apt-get install -y nodejs; then
    note "Установлен Node.js $(node --version) (NodeSource)"
  else
    note "NodeSource недоступен — ставим Node.js из репозитория Ubuntu"
    apt-get install -y nodejs npm
  fi
  installed="$(node_major_installed || echo 0)"
  [ "$installed" -ge "$NODE_MIN" ] || fail "Нужен Node.js ${NODE_MIN} или новее, установлен ${installed}."
fi

say "3/9 Пользователь ${APP_USER}"
if [ "$DRY_RUN" = "1" ]; then
  note "+ adduser --system --group --home /opt/${APP_USER} ${APP_USER} (если его нет)"
elif id "$APP_USER" >/dev/null 2>&1; then
  note "Пользователь ${APP_USER} уже есть"
else
  adduser --system --group --home "/opt/${APP_USER}" "$APP_USER"
fi

say "4/9 Код приложения"
if [ "$DRY_RUN" = "1" ]; then
  note "+ git clone/pull ${REPO} → ${APP_DIR} (ветка ${BRANCH})"
elif [ -d "$APP_DIR/.git" ]; then
  note "Код уже загружен — обновляем"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
run chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
if [ "$DRY_RUN" != "1" ] && ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR"; then
  git config --global --add safe.directory "$APP_DIR"
fi

say "5/9 Данные и оформление компании"
run mkdir -p "$APP_DATA" "$BRAND_DIR"
run chown "${APP_USER}:${APP_USER}" "$APP_DATA"
run chmod 750 "$APP_DATA"
note "Данные: ${APP_DATA} — при обновлении кода не затрагиваются."

# Файл настроек компании. Переданные значения записываются, остальные
# сохраняются из прежнего файла — повторный запуск ничего не теряет.
env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] && sed -n "s/^${key}=//p" "$ENV_FILE" | head -1 | sed 's/^"//; s/"$//'
}
env_line() {
  local key="$1" value="${2:-}"
  [ -n "$value" ] || value="$(env_value "$key" || true)"
  [ -n "$value" ] && printf '%s="%s"\n' "$key" "${value//\"/}"
  return 0
}
{
  printf '# Настройки компании для копии %s. После правки: systemctl restart %s\n' "$APP_SLUG" "$UNIT"
  printf 'APP_SLUG="%s"\n' "$APP_SLUG"
  printf 'BRAND_DIR="%s"\n' "$BRAND_DIR"
  env_line COMPANY_NAME "${COMPANY_NAME:-}"
  env_line BRAND_WORDMARK "${BRAND_WORDMARK:-}"
  env_line BRAND_SUBTITLE "${BRAND_SUBTITLE:-}"
  env_line BRAND_TAGLINE "${BRAND_TAGLINE:-}"
  env_line BRAND_INITIALS "${BRAND_INITIALS:-}"
  env_line BRAND_COLOR "${BRAND_COLOR:-}"
  env_line BOOTSTRAP_USERS "${BOOTSTRAP_USERS:-}"
  # Строки, дописанные вручную, сохраняем как есть.
  if [ -f "$ENV_FILE" ]; then
    grep -Ev '^[[:space:]]*(#|$)|^(APP_SLUG|BRAND_DIR|COMPANY_NAME|BRAND_WORDMARK|BRAND_SUBTITLE|BRAND_TAGLINE|BRAND_INITIALS|BRAND_COLOR|BOOTSTRAP_USERS)=' "$ENV_FILE" || true
  fi
} | write "$ENV_FILE"
run chmod 640 "$ENV_FILE"
run chown "root:${APP_USER}" "$ENV_FILE"
note "Логотип: положите icon-180.png, icon-192.png, icon-512.png в ${BRAND_DIR}"

SERVICE_NAME="${COMPANY_NAME:-$(env_value COMPANY_NAME || true)}"
[ -n "$SERVICE_NAME" ] || { [ "$IS_MAIN" = "1" ] && SERVICE_NAME="Line Design" || SERVICE_NAME="$APP_SLUG"; }

say "6/9 Служба ${UNIT}"
write "$EXISTING_UNIT" <<UNITFILE
[Unit]
Description=${SERVICE_NAME} — финансы студии
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/server.js
EnvironmentFile=-${ENV_FILE}
Environment=HOST=127.0.0.1
Environment=PORT=${APP_PORT}
Environment=DATA_DIR=${APP_DATA}
Environment=AUTH_DISABLED=${AUTH_DISABLED}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${APP_DATA}

[Install]
WantedBy=multi-user.target
UNITFILE
run systemctl daemon-reload
run systemctl enable "$UNIT"
# restart, а не start: новые настройки и код должны вступить в силу сразу.
run systemctl restart "$UNIT"
if [ "$DRY_RUN" != "1" ]; then
  sleep 2
  systemctl is-active --quiet "$UNIT" \
    && note "Приложение запущено" \
    || fail "Приложение не запустилось. Посмотрите: journalctl -u ${UNIT} -n 50"
fi

say "7/9 nginx"
SITE_FILE="/etc/nginx/sites-available/${NGINX_SITE}"
SITE_EXISTED=0
[ -f "$SITE_FILE" ] && SITE_EXISTED=1
if [ "$SITE_EXISTED" = "1" ] && [ "${NGINX_OVERWRITE:-0}" != "1" ] \
  && ! grep -qs "127.0.0.1:${APP_PORT}" "$SITE_FILE"; then
  fail "Сайт nginx ${SITE_FILE} уже есть и ведёт на другую программу. Выберите другое имя: APP_SLUG=..."
fi
if [ "$SITE_EXISTED" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  cp -p "$SITE_FILE" "${SITE_FILE}.before-install"
fi
if [ "$SITE_EXISTED" = "1" ] && [ "${NGINX_OVERWRITE:-0}" != "1" ]; then
  note "Файл ${SITE_FILE} уже есть — не трогаем (в нём может быть HTTPS от certbot)."
  note "Переписать заново: NGINX_OVERWRITE=1 bash install.sh ..."
else
  # default_server — только если его ещё нет ни у одного сайта: запросы по
  # голому IP должны доставаться одной программе, и это не повод отбирать
  # их у уже работающей.
  # Вторая и следующие компании его не получают никогда (разве что явно
  # попросить NGINX_DEFAULT_SERVER=1): голый IP остаётся за основной.
  LISTEN="listen 80;"
  if [ "$IS_MAIN" = "1" ] || [ "${NGINX_DEFAULT_SERVER:-0}" = "1" ]; then
    # Стандартную заглушку nginx убираем заранее, только если это
    # действительно она, — иначе её default_server помешал бы проверке.
    if [ -L /etc/nginx/sites-enabled/default ] && grep -qs 'root /var/www/html' /etc/nginx/sites-available/default; then
      run rm -f /etc/nginx/sites-enabled/default
    fi
    # -R: в sites-enabled лежат ссылки, а grep -r по ссылкам не ходит.
    if ! grep -Rqs 'default_server' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null; then
      LISTEN="listen 80 default_server;"
    fi
  fi
  write "$SITE_FILE" <<NGINX
server {
    ${LISTEN}
    server_name ${DOMAIN:-_};

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
fi
LINK_EXISTED=0
[ -e "/etc/nginx/sites-enabled/${NGINX_SITE}" ] && LINK_EXISTED=1
run ln -sf "$SITE_FILE" "/etc/nginx/sites-enabled/${NGINX_SITE}"
# Стандартную заглушку nginx убираем, только если это действительно она.
if [ -L /etc/nginx/sites-enabled/default ] && grep -qs 'root /var/www/html' /etc/nginx/sites-available/default; then
  run rm -f /etc/nginx/sites-enabled/default
fi
# Настройка не прошла проверку — возвращаем всё как было, чтобы не
# сломать nginx соседним сайтам (бот и другие студии).
if [ "$DRY_RUN" = "1" ]; then
  note "+ nginx -t && systemctl reload nginx"
elif nginx -t; then
  systemctl reload nginx
  rm -f "${SITE_FILE}.before-install"
else
  if [ "$SITE_EXISTED" = "1" ]; then
    mv -f "${SITE_FILE}.before-install" "$SITE_FILE"
  else
    rm -f "$SITE_FILE"
  fi
  [ "$LINK_EXISTED" = "1" ] || rm -f "/etc/nginx/sites-enabled/${NGINX_SITE}"
  fail "nginx не принял настройку — изменения отменены, соседние сайты работают как раньше. Подробности: nginx -t"
fi

# Файрвол включаем только при первой установке основной копии: на сервере,
# где уже живут другие программы, включённый ufw мог бы закрыть их порты
# (или SSH на нестандартном порту).
if [ "$IS_MAIN" = "1" ] && [ "$LINK_EXISTED" = "0" ] \
  && command -v ufw >/dev/null 2>&1 && ! ufw status 2>/dev/null | grep -q 'Status: active'; then
  run ufw allow OpenSSH
  run ufw allow 'Nginx Full'
  run ufw --force enable
fi
note "Порт приложения наружу закрыт: снаружи отвечает только nginx."

say "8/9 HTTPS"
if [ -z "$DOMAIN" ]; then
  note "Домен не указан — сертификат не выпускаем."
elif [ "$DRY_RUN" = "1" ]; then
  note "+ certbot --nginx -d ${DOMAIN} --redirect"
elif grep -qs "managed by Certbot" "$SITE_FILE"; then
  note "Сертификат уже настроен."
else
  # Нужен и сам certbot, и его модуль для nginx — бывает, что стоит только первый.
  if ! command -v certbot >/dev/null 2>&1 || ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
    apt-get install -y certbot python3-certbot-nginx
  fi
  certbot_ok=1
  if [ -n "$EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || certbot_ok=0
  else
    certbot --nginx -d "$DOMAIN" --redirect || certbot_ok=0
  fi
  if [ "$certbot_ok" = "1" ]; then
    note "Сертификат выпущен и будет продлеваться автоматически."
  else
    note "Сертификат пока не выпущен — скорее всего, A-запись домена ещё не указывает на этот сервер."
    note "Когда заработает: certbot --nginx -d ${DOMAIN} --redirect"
  fi
fi

say "9/9 Резервные копии"
write "$CRON_FILE" <<BACKUP
#!/bin/sh
# Ежедневная копия данных ${APP_SLUG}. Хранится 30 дней.
set -e
# Копии содержат коды входа и сессии — читать их может только root.
umask 077
mkdir -p ${BACKUP_DIR}
chmod 700 ${BACKUP_DIR}
tar -czf "${BACKUP_DIR}/\$(date +%F).tar.gz" -C "$(dirname "$APP_DATA")" "$(basename "$APP_DATA")"
find ${BACKUP_DIR} -name '*.tar.gz' -mtime +30 -delete
BACKUP
run chmod +x "$CRON_FILE"
run mkdir -p "$BACKUP_DIR"
run chmod 700 "$BACKUP_DIR"
# Уже сделанные копии тоже закрываем от посторонних.
if [ "$DRY_RUN" != "1" ]; then
  find "$BACKUP_DIR" -name '*.tar.gz' -exec chmod 600 {} + 2>/dev/null || true
fi

say "Готово"
if [ -n "$DOMAIN" ]; then
  note "Приложение: https://${DOMAIN}/finance/"
else
  note "Приложение: http://$(hostname -I 2>/dev/null | awk '{print $1}')/finance/"
fi
if [ "$AUTH_DISABLED" = "1" ]; then
  note "Вход отключён: приложение откроется без логина и пароля."
fi
if [ "$AUTH_DISABLED" != "1" ] && [ "$DRY_RUN" != "1" ] && [ -f "${APP_DATA}/КОДЫ-ДЛЯ-ВХОДА.txt" ]; then
  say "Коды для входа (смените после первого входа)"
  cat "${APP_DATA}/КОДЫ-ДЛЯ-ВХОДА.txt"
fi
note "Настройки компании: ${ENV_FILE}"
note "Резервные копии: ${BACKUP_DIR}"
note "Обновление: git -C ${APP_DIR} pull && chown -R ${APP_USER}:${APP_USER} ${APP_DIR} && systemctl restart ${UNIT}"
note "Проверка: APP_SLUG=${APP_SLUG} bash ${APP_DIR}/server/diagnose.sh"
