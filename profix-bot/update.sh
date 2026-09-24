#!/bin/sh
# Обновление бота на сервере: sh update.sh
#
# Берёт последнюю версию ветки по номеру коммита, а не по имени ветки:
# raw.githubusercontent.com кеширует ссылки по имени ветки на несколько
# минут и отдаёт старый файл сразу после публикации.
set -e
cd "$(dirname "$0")"

REPO=Dalefa500/My-Profix
BRANCH=claude/cloud-code-erhqip

SHA=$(curl -fsS "https://api.github.com/repos/$REPO/commits/$BRANCH" \
      | grep -m1 '"sha"' | cut -d'"' -f4)
[ -n "$SHA" ] || { echo "Не удалось узнать последнюю версию на GitHub"; exit 1; }
echo "── Версия $SHA ──"

for f in app.py catalog_data.py update.sh; do
    curl -fsS -o "$f.new" "https://raw.githubusercontent.com/$REPO/$SHA/profix-bot/$f"
    mv "$f.new" "$f"
done

echo "── Пересобираю бота ──"
docker compose up -d --build

echo "── Проверка ──"
sleep 3
docker exec profix-instagram-bot python -c \
  "import urllib.request;print(urllib.request.urlopen('http://localhost:8000/health').read().decode())"
echo "── Готово ──"
