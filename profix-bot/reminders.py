"""Напоминания об оплатах — в Telegram владельцу.

Запускается на сервере по расписанию (cron, раз в час). Раз в сутки,
начиная с 10:00 по Душанбе, смотрит payments.json и присылает через того
же Telegram-бота, что шлёт заявки, напоминание за 3, 2, 1 день и в день
оплаты.

Номера карт в репозиторий не кладём — он публичный. В payments.json
пишется короткое имя «card:visa1814», а что за ним стоит («Visa •••• 1814»),
лежит только на сервере в data/cards.json.

    python3 reminders.py          обычный запуск (из cron)
    python3 reminders.py --test   прислать проверочное сообщение сейчас
    python3 reminders.py --list   показать ближайшие даты, ничего не слать
"""

from __future__ import annotations

import calendar
import json
import socket
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
PAYMENTS = HERE / "payments.json"
CARDS = DATA / "cards.json"
SENT_LOG = DATA / "reminders-sent.json"

TZ = timezone(timedelta(hours=5))  # Душанбе, без перехода на летнее время
SEND_FROM_HOUR = 10
DEFAULT_DAYS = [3, 2, 1, 0]

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря"]

# На этом сервере IPv6 до внешнего мира не ходит, а Python пробует его
# первым и зависает до таймаута — поэтому разрешаем только IPv4.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only(host, port, family=0, *args, **kwargs):
    return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)


socket.getaddrinfo = _ipv4_only


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = HERE / ".env"
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def next_due(item: dict, today: date) -> date | None:
    """Ближайшая дата оплаты начиная с сегодня."""
    if item.get("due"):
        return date.fromisoformat(item["due"])
    day = item.get("monthly_day")
    if not day:
        return None
    year, month = today.year, today.month
    for _ in range(2):
        last = calendar.monthrange(year, month)[1]
        candidate = date(year, month, min(int(day), last))
        if candidate >= today:
            return candidate
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return None


def when_text(days: int) -> str:
    if days == 0:
        return "Сегодня"
    if days == 1:
        return "Завтра"
    return f"Через {days} дня" if days < 5 else f"Через {days} дней"


def pay_text(pay: str, cards: dict[str, str]) -> str:
    if pay.startswith("card:"):
        alias = pay[5:]
        return cards.get(alias, f"карта «{alias}»")
    return pay


def format_message(item: dict, due: date, days: int, cards: dict[str, str]) -> str:
    lines = [f"💳 {when_text(days)} оплата: {item['title']}",
             f"Дата: {due.day} {MONTHS[due.month - 1]}"]
    if item.get("amount"):
        lines.append(f"Сумма: {item['amount']}")
    if item.get("pay"):
        lines.append(f"Чем платить: {pay_text(item['pay'], cards)}")
    if item.get("note"):
        lines.append(item["note"])
    return "\n".join(lines)


def send(env: dict[str, str], text: str) -> bool:
    token = env.get("BOT_TOKEN", "")
    chats = [c.strip() for c in env.get("OWNER_IDS", "").split(",") if c.strip()]
    if not (token and chats):
        print("нет BOT_TOKEN или OWNER_IDS в .env — некуда слать", flush=True)
        return False
    ok = True
    for chat in chats:
        body = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        try:
            with urllib.request.urlopen(
                f"https://api.telegram.org/bot{token}/sendMessage", body, timeout=20
            ) as resp:
                ok &= resp.status == 200
        except Exception as exc:  # noqa: BLE001 — cron должен дожить до конца
            print(f"Telegram не принял сообщение: {exc}", flush=True)
            ok = False
    return ok


def main(argv: list[str]) -> int:
    env = load_env()
    now = datetime.now(TZ)
    today = now.date()
    payments = load_json(PAYMENTS, [])
    cards = load_json(CARDS, {})

    if "--test" in argv:
        sent = send(env, "✅ Проверка: напоминания об оплатах PROFIX работают.\n"
                         "Они будут приходить сюда за 3, 2, 1 день и в день оплаты, в 10:00.")
        print("проверочное сообщение отправлено" if sent else "не отправилось")
        return 0 if sent else 1

    if "--list" in argv:
        for item in payments:
            due = next_due(item, today)
            print(f"{due} | {item['title']} | {pay_text(item.get('pay', ''), cards)}")
        return 0

    if now.hour < SEND_FROM_HOUR:
        return 0

    sent_log = load_json(SENT_LOG, {})
    for item in payments:
        due = next_due(item, today)
        if due is None:
            continue
        days = (due - today).days
        if days not in item.get("days_before", DEFAULT_DAYS):
            continue
        key = f"{item['title']}|{due.isoformat()}|{days}"
        if key in sent_log:
            continue
        if send(env, format_message(item, due, days, cards)):
            sent_log[key] = now.isoformat(timespec="minutes")
            print(f"{now:%Y-%m-%d %H:%M} отправлено: {key}", flush=True)

    # Старые записи больше не нужны — храним только последние 60 дней.
    cutoff = (today - timedelta(days=60)).isoformat()
    sent_log = {k: v for k, v in sent_log.items() if k.split("|")[1] >= cutoff}
    DATA.mkdir(exist_ok=True)
    SENT_LOG.write_text(json.dumps(sent_log, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
