#!/usr/bin/env bash
#
# Проверка живости приложения на сервере. Запускать от root:
#
#   bash /opt/line-design-app/server/diagnose.sh
#
# Ничего не меняет — только смотрит и печатает отчёт.

APP_DIR="${APP_DIR:-/opt/line-design-app}"
APP_DATA="${APP_DATA:-/var/lib/line-design-finance}"
APP_PORT="${APP_PORT:-3000}"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "Служба приложения"
systemctl is-active line-design 2>/dev/null || echo "служба не найдена"
systemctl is-enabled line-design 2>/dev/null
systemctl show line-design -p ExecMainStartTimestamp --value 2>/dev/null

say "Последние сообщения приложения"
journalctl -u line-design -n 25 --no-pager 2>/dev/null || echo "журнал недоступен"

say "Отвечает ли приложение изнутри сервера"
curl -s -o /dev/null -w "http://127.0.0.1:${APP_PORT}/finance/ -> %{http_code}\n" \
  --max-time 5 "http://127.0.0.1:${APP_PORT}/finance/" || echo "не отвечает совсем"

say "nginx"
systemctl is-active nginx 2>/dev/null || echo "nginx не запущен"
nginx -t 2>&1 | tail -2
echo "--- какие имена и куда проксирует:"
nginx -T 2>/dev/null | grep -E '^\s*(server_name|listen|proxy_pass|return)' | sed 's/^\s*/   /'

say "Отвечает ли снаружи"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
for addr in "http://127.0.0.1/finance/" "http://${IP}/finance/"; do
  curl -s -o /dev/null -w "${addr} -> %{http_code}  переход: %{redirect_url}\n" \
    --max-time 5 "$addr" 2>/dev/null || echo "${addr} -> нет ответа"
done

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
