#!/usr/bin/env bash
#
# Проверка живости приложения на сервере. Запускать от root:
#
#   bash /opt/line-design-app/server/diagnose.sh
#
# Для другой компании на этом же сервере:
#
#   APP_SLUG=nova bash /opt/nova-app/server/diagnose.sh
#
# Ничего не меняет — только смотрит и печатает отчёт.

APP_SLUG="${APP_SLUG:-line-design}"
UNIT="${APP_SLUG}"
APP_DIR="${APP_DIR:-/opt/${APP_SLUG}-app}"
APP_DATA="${APP_DATA:-/var/lib/${APP_SLUG}-finance}"
# Порт и домен берём из настроек службы и nginx этой копии.
APP_PORT="${APP_PORT:-$(sed -n 's/^Environment=PORT=//p' "/etc/systemd/system/${UNIT}.service" 2>/dev/null | head -1)}"
APP_PORT="${APP_PORT:-3000}"
APP_DOMAIN="${APP_DOMAIN:-$(sed -n 's/^[[:space:]]*server_name[[:space:]]*\([^ ;]*\).*/\1/p' "/etc/nginx/sites-available/${APP_SLUG}" 2>/dev/null | grep -v '^_$' | head -1)}"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "Служба приложения"
systemctl is-active "$UNIT" 2>/dev/null || echo "служба не найдена"
systemctl is-enabled "$UNIT" 2>/dev/null
systemctl show "$UNIT" -p ExecMainStartTimestamp --value 2>/dev/null

say "Последние сообщения приложения"
journalctl -u "$UNIT" -n 25 --no-pager 2>/dev/null || echo "журнал недоступен"

say "Отвечает ли приложение изнутри сервера"
curl -s -o /dev/null -w "http://127.0.0.1:${APP_PORT}/finance/ -> %{http_code}\n" \
  --max-time 5 "http://127.0.0.1:${APP_PORT}/finance/" || echo "не отвечает совсем"

say "nginx"
systemctl is-active nginx 2>/dev/null || echo "nginx не запущен"
nginx -t 2>&1 | tail -2
echo "--- какие имена и куда проксирует:"
nginx -T 2>/dev/null | grep -E '^\s*(server_name|listen|proxy_pass|return)' | sed 's/^\s*/   /'

say "Отвечает ли снаружи (через nginx)"
if [ -n "$APP_DOMAIN" ]; then
  curl -s -o /dev/null -w "по имени ${APP_DOMAIN} -> %{http_code}  переход: %{redirect_url}\n" \
    --max-time 5 -H "Host: ${APP_DOMAIN}" "http://127.0.0.1/finance/" || echo "нет ответа"
else
  echo "домен копии не найден в nginx"
fi
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
curl -s -o /dev/null -w "по голому IP ${IP} -> %{http_code} (сюда отвечает сайт с default_server)\n" \
  --max-time 5 "http://${IP}/finance/" 2>/dev/null || echo "по IP -> нет ответа"

say "Версия кода"
git -C "$APP_DIR" log --oneline -1 2>/dev/null || echo "папка с кодом не найдена"
git -C "$APP_DIR" status --short 2>/dev/null | head -5

say "Место на диске"
df -h / | tail -1

say "Память"
free -m | head -2

say "Файлы с данными"
ls -la "$APP_DATA" 2>/dev/null | head -20 || echo "папка данных не найдена"

printf '\n'
