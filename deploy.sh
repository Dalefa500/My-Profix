#!/bin/sh
# Обновление Profix на сервере одной командой: ./deploy.sh
set -e
cd "$(dirname "$0")"

echo "── Забираем свежий код ──"
git pull

cd moysklad-bot

# BuildKit на каждую сборку спрашивает Docker Hub про базовый образ и
# упирается в ограничение по числу запросов (429 Too Many Requests).
# Классический сборщик берёт уже скачанный образ с диска и в интернет
# за ним не ходит.
export DOCKER_BUILDKIT=0

echo "── Собираем и запускаем ──"
docker compose up -d --build

echo "── Что теперь в контейнере ──"
docker compose exec -T web grep -om1 'v=[0-9]*' /app/web/static/index.html
