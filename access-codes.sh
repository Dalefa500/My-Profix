#!/bin/sh
# Коды входа в приложение Profix — у каждого человека свой.
#
#   ./access-codes.sh                 кто сейчас может войти
#   ./access-codes.sh add Rizvon      выдать код (или заменить старый)
#   ./access-codes.sh remove Rizvon   отключить человека
#
# Код придумывается сам — 8 случайных цифр — и показывается один раз.
# Отключённый человек вылетает из приложения сразу, даже если он был
# внутри. Имена лучше писать латиницей: не придётся переключать раскладку.
#
# Перед каждым изменением делается копия настроек. Если после изменения
# приложение не поднимется, копия вернётся сама.
set -e
cd "$(dirname "$0")/moysklad-bot"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Не нашёл файл $ENV_FILE — запускайте из папки powermix-site на сервере."
    exit 1
fi

current=$(grep '^WEB_PINS=' "$ENV_FILE" | head -1 | cut -d= -f2-)

# Имена из WEB_PINS по одному на строку. Имя — всё до последнего «:».
names() {
    printf '%s\n' "$current" | tr ',' '\n' | sed -n 's/^ *\(.*\):[^:]*$/\1/p'
}

has_name() {
    names | grep -Fqx -- "$1"
}

# Все записи, кроме человека с этим именем.
without() {
    printf '%s' "$current" | tr ',' '\n' | awk -F: -v who="$1" '
        NF == 0 { next }
        { name = $0; sub(/:[^:]*$/, "", name); sub(/^ +/, "", name) }
        name != who { out = out (out == "" ? "" : ",") $0 }
        END { printf "%s", out }'
}

list() {
    if [ -z "$current" ]; then
        if grep -q '^WEB_PIN=.' "$ENV_FILE"; then
            echo "Сейчас вход по одному общему коду (старый способ)."
            echo "Выдайте первый именной код, и общий перестанет работать:"
            echo "  ./access-codes.sh add Jamshed"
        else
            echo "Кодов входа нет."
        fi
        return
    fi
    echo "Могут войти:"
    names | sed 's/^/  • /'
}

# Проверка имени. Запрещённые символы все латинские, поэтому побайтовое
# сравнение в case безопасно и для кириллицы в самом имени.
check_name() {
    case "$1" in
        "") echo "Укажите имя, например: ./access-codes.sh add Rizvon"; exit 1 ;;
        *[,:=\ \"\'\#\\\|\&\;]*)
            echo "В имени не должно быть пробелов и знаков , : = # \" ' ; | & \\"
            echo "Пишите одним словом, например: Rizvon"
            exit 1 ;;
    esac
}

new_code() {
    while :; do
        n=$(od -An -N4 -tu4 /dev/urandom | tr -d ' \n')
        code=$(printf '%08d' $((n % 100000000)))
        # Не выдаём код, который уже есть у кого-то другого.
        case ",$current," in
            *":$code,"*) continue ;;
        esac
        printf '%s' "$code"
        return
    done
}

save() {
    backup="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$backup"
    chmod 600 "$backup"

    if grep -q '^WEB_PINS=' "$ENV_FILE"; then
        sed -i "s|^WEB_PINS=.*|WEB_PINS=$1|" "$ENV_FILE"
    else
        printf 'WEB_PINS=%s\n' "$1" >> "$ENV_FILE"
    fi
    # Общий код больше не нужен: с именными он всё равно не работает,
    # а лишняя строка только сбивает с толку.
    sed -i '/^WEB_PIN=/d' "$ENV_FILE"
    chmod 600 "$ENV_FILE"
}

# restart читает старые настройки контейнера — новые коды подхватываются
# только при пересоздании.
restart_web() {
    docker compose up -d --no-build --force-recreate web >/dev/null 2>&1
}

web_is_up() {
    i=0
    while [ $i -lt 20 ]; do
        if docker compose exec -T web python -c \
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/session', timeout=3)" \
            >/dev/null 2>&1; then
            return 0
        fi
        i=$((i + 1))
        sleep 2
    done
    return 1
}

apply() {
    echo "Перезапускаю приложение..."
    restart_web
    if web_is_up; then
        rm -f "$backup"
        return 0
    fi
    echo
    echo "Приложение не поднялось. Возвращаю прежние настройки."
    cp "$backup" "$ENV_FILE"
    restart_web
    web_is_up || true
    echo "Вернул. Ничего не изменилось. Последние строки журнала:"
    docker compose logs --tail 15 web 2>/dev/null | tail -15
    exit 1
}

case "${1:-}" in
    ""|list)
        list
        ;;

    add)
        name="$2"
        check_name "$name"
        code=$(new_code)
        if has_name "$name"; then
            rest=$(without "$name")
            replaced=1
        else
            rest="$current"
            replaced=0
        fi
        entry="$name:$code"
        save "${rest:+$rest,}$entry"
        apply
        echo
        if [ "$replaced" = 1 ]; then
            echo "Код для $name заменён. Старый уже не работает."
        else
            echo "Выдан код для $name."
        fi
        echo
        echo "    $code"
        echo
        echo "Больше он нигде не покажется — перепишите его сейчас."
        echo "Передайте лично или в личном сообщении. Экран не фотографируйте."
        code=""
        ;;

    remove)
        name="$2"
        check_name "$name"
        if ! has_name "$name"; then
            echo "Такого имени нет."
            list
            exit 1
        fi
        rest=$(without "$name")
        if [ -z "$rest" ]; then
            echo "Это последний код — без него в приложение не войдёт никто."
            echo "Сначала выдайте код другому человеку, потом отключайте этого."
            exit 1
        fi
        save "$rest"
        apply
        echo "$name отключён. Если он был в приложении — его уже выкинуло."
        ;;

    *)
        echo "Не понял команду «$1». Можно так:"
        echo "  ./access-codes.sh                 кто может войти"
        echo "  ./access-codes.sh add Rizvon      выдать или заменить код"
        echo "  ./access-codes.sh remove Rizvon   отключить"
        exit 1
        ;;
esac
