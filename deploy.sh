#!/bin/sh
# Обновление Profix на сервере: ./deploy.sh
# Пересборка образа (нужна только при смене зависимостей): ./deploy.sh build
set -e
cd "$(dirname "$0")"

echo "── Забираем свежий код ──"
before=$(git rev-parse HEAD)
git pull
after=$(git rev-parse HEAD)

# git pull может обновить и сам этот скрипт, а оболочка дочитывает файл
# по ходу выполнения — и дальше пойдут вперемешку старые и новые строки.
# Поэтому после обновления перезапускаем себя, уже свежего, один раз.
if [ "$before" != "$after" ] && [ -z "$DEPLOY_REEXEC" ]; then
    echo "── Скрипт обновился, перезапускаю его ──"
    DEPLOY_REEXEC=1 exec "$0" "$@"
fi

cd moysklad-bot

if [ "$1" = "build" ]; then
    # BuildKit и классический сборщик оба спрашивают Docker Hub про
    # базовый образ и упираются в ограничение по числу запросов (429).
    # Если так вышло — просто повторите позже, лимит снимается сам.
    echo "── Пересобираем образ ──"
    DOCKER_BUILDKIT=0 docker compose build
fi

echo "── Применяем настройки и перезапускаем ──"
# Код примонтирован с диска, поэтому образ пересобирать не нужно:
# контейнеру достаточно перечитать файлы.
docker compose up -d --no-build
docker compose restart web moysklad-bot

echo "── Что теперь в контейнере ──"
docker compose exec -T web grep -om1 'v=[0-9]*' /app/web/static/index.html
