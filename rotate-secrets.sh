#!/bin/sh
# Смена секретов Profix: ./rotate-secrets.sh
#
# Спрашивает новые значения по одному и проверяет каждое на
# работоспособность. В .env ничего не пишется, пока не проверено всё —
# так приложение не остаётся с наполовину заменёнными ключами.
# Ввод не показывается на экране и не попадает в историю команд.
#
# Что можно сменить:
#   MOYSKLAD_TOKEN — API-токен МойСклада
#   BOT_TOKEN      — токен телеграм-бота
#   WEB_PIN        — код входа в приложение
#   WEB_SECRET     — подпись сессий (генерируется сама)
#
# Любой пункт можно пропустить — просто нажмите Enter, старое значение
# останется. Если на сервере нет интернета и проверка не проходит,
# запустите так: ROTATE_NO_VERIFY=1 ./rotate-secrets.sh
set -e
cd "$(dirname "$0")/moysklad-bot"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Не нашёл файл $ENV_FILE рядом со скриптом — менять нечего."
    exit 1
fi

# Спросить значение, не показывая его на экране.
ask() {
    printf '%s' "$1"
    stty -echo 2>/dev/null || true
    read -r REPLY_VALUE || REPLY_VALUE=""
    stty echo 2>/dev/null || true
    printf '\n'
}

verify() { [ "${ROTATE_NO_VERIFY:-}" != "1" ]; }

no_network() {
    echo "   Не смог достучаться до $1 — похоже, на сервере нет интернета."
    echo "   Если интернет точно есть, запустите так:"
    echo "   ROTATE_NO_VERIFY=1 ./rotate-secrets.sh"
    exit 1
}

new_moysklad=""
new_bot=""
new_pin=""
new_secret=""
changed=""

# ── 1. Токен МойСклада ────────────────────────────────────────────────
echo "1) Токен МойСклада"
echo "   Взять: Настройки -> Обмен данными -> раздел API -> Токены доступа."
echo "   Сначала УДАЛИТЕ там старый токен, потом создайте новый."
ask "   Новый токен (Enter — пропустить): "
if [ -n "$REPLY_VALUE" ]; then
    new_moysklad="$REPLY_VALUE"
    if verify; then
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
            -H "Authorization: Bearer $new_moysklad" \
            "https://api.moysklad.ru/api/remap/1.2/context/employee") || code=000
        [ "$code" = "000" ] && no_network "МойСклада"
        if [ "$code" != "200" ]; then
            echo "   Токен не подошёл (ответ $code). Ничего не меняю."
            exit 1
        fi
        echo "   Проверка пройдена."
    fi
    changed="$changed МойСклад"
fi
echo

# ── 2. Токен бота ─────────────────────────────────────────────────────
echo "2) Токен телеграм-бота"
echo "   Взять: напишите @BotFather -> /mybots -> ваш бот -> API Token"
echo "   -> Revoke current token. Старый умрёт сразу."
ask "   Новый токен (Enter — пропустить): "
if [ -n "$REPLY_VALUE" ]; then
    new_bot="$REPLY_VALUE"
    if verify; then
        reply=$(curl -s --max-time 20 \
            "https://api.telegram.org/bot$new_bot/getMe") || reply=""
        [ -z "$reply" ] && no_network "Telegram"
        case "$reply" in
            *'"ok":true'*) echo "   Проверка пройдена." ;;
            *) echo "   Токен не подошёл. Ничего не меняю."; exit 1 ;;
        esac
        reply=""
    fi
    changed="$changed бот"
fi
echo

# ── 3. Код входа в приложение ─────────────────────────────────────────
echo "3) Код входа в приложение (минимум 6 цифр)"
ask "   Новый код (Enter — пропустить): "
if [ -n "$REPLY_VALUE" ]; then
    case "$REPLY_VALUE" in
        *[!0-9]*) echo "   В коде должны быть только цифры. Ничего не меняю."; exit 1 ;;
    esac
    if [ "${#REPLY_VALUE}" -lt 6 ]; then
        echo "   Слишком короткий код. Ничего не меняю."
        exit 1
    fi
    new_pin="$REPLY_VALUE"
    changed="$changed код-входа"
fi
echo

# ── 4. Подпись сессий ─────────────────────────────────────────────────
printf '4) Сменить подпись сессий? Все, кто вошёл, введут код заново. (д/н): '
read -r answer || answer=""
# Варианты перечислены целиком: в списке вида [дД] кириллица сравнивается
# побайтово, и «н» совпала бы с «д» — скрипт делал бы обратное сказанному.
case "$answer" in
    д|Д|да|Да|ДА|y|Y|yes|Yes|YES)
        if command -v openssl >/dev/null 2>&1; then
            new_secret=$(openssl rand -hex 32)
            changed="$changed подпись-сессий"
            echo "   Сменю."
        else
            echo "   На сервере нет openssl — пропускаю этот пункт."
        fi
        ;;
esac
echo

REPLY_VALUE=""

if [ -z "$changed" ]; then
    echo "Ничего не изменилось — перезапускать нечего."
    exit 0
fi

# ── Всё проверено, только теперь пишем ────────────────────────────────
backup="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$backup"
chmod 600 "$backup"
echo "Старые настройки сохранил в $backup"

# Экранируем то, что sed считает служебным, чтобы любой символ
# в токене записался как есть.
escape() {
    printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

# Записать КЛЮЧ=значение: заменить строку, а если такой строки нет — дописать.
put() {
    [ -n "$2" ] || return 0
    if grep -q "^$1=" "$ENV_FILE"; then
        sed -i "s|^$1=.*|$1=$(escape "$2")|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
    fi
}

put MOYSKLAD_TOKEN "$new_moysklad"
put BOT_TOKEN      "$new_bot"
put WEB_PIN        "$new_pin"
put WEB_SECRET     "$new_secret"
new_moysklad=""; new_bot=""; new_pin=""; new_secret=""
chmod 600 "$ENV_FILE"

echo "Изменил:$changed"
echo "── Перезапускаю приложение ──"
cd ..
./deploy.sh

echo
echo "Готово. Проверьте: откройте app.profix.tj и напишите боту /start."
echo "Если что-то сломалось, вернуть старое:"
echo "  cp moysklad-bot/$backup moysklad-bot/.env && ./deploy.sh"
