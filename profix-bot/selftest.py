"""Проверка бота через настоящий Claude, без Instagram и Telegram.

Запуск на сервере (из папки бота):
    docker exec -i profix-instagram-bot python - < selftest.py

Прогоняет типичные разговоры, печатает переписку и проверяет правила:
приветствие с именем Фарзона один раз, без нашего номера, карточка WhatsApp
только по просьбе клиента, язык клиента, без запасного шаблона.
Клиентам ничего не уходит: отправка в Instagram и Telegram подменена.
Настоящие диалоги не трогаются. Стоит несколько центов (запросы к Claude).
"""
import asyncio
import re

import app

app.STATE = {}
app._save_state = lambda state: None
app.REPLY_DELAY = 0.5

out: dict[str, list] = {}
fallbacks: list[str] = []
leads: list[str] = []

_real_fallback = app.fallback_reply


def _fallback(text, tajik=None):
    fallbacks.append(text)
    return _real_fallback(text, tajik)


async def _send_message(sender, text):
    out.setdefault(sender, []).append(("text", text))


async def _send_button(sender, tajik):
    out.setdefault(sender, []).append(("card", "tj" if tajik else "ru"))


async def _deliver_lead(text):
    leads.append(text)


app.fallback_reply = _fallback
app.send_message = _send_message
app.send_whatsapp_button = _send_button
app.deliver_lead = _deliver_lead

OUR_DIGITS = re.sub(r"\D", "", app.MANAGER_WHATSAPP or "")[-9:]
BOOKISH = ("масоҳат", "метри мураббаъ", "таъмир", "муроҷиат", "сувоқ", "мутахассис")
TJ_LETTERS = set("ҳҷқғӣӯ")

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"   {'✅' if ok else '❌'} {what}")
    if not ok:
        failures.append(what)


async def say(sender: str, *messages: str) -> list:
    """Клиент пишет одно или несколько сообщений подряд; ждём ответ бота."""
    before = len(out.get(sender, []))
    fb_before = len(fallbacks)
    for m in messages:
        print(f"👤 {m}")
        app.queue_message(sender, m)
    await asyncio.sleep(app.REPLY_DELAY + 0.2)
    lock = app._reply_locks.setdefault(sender, asyncio.Lock())
    while sender in app._inbox or lock.locked():
        await asyncio.sleep(0.2)
    got = out.get(sender, [])[before:]
    for kind, body in got:
        print(f"🤖 {body}" if kind == "text" else f"🤖 [карточка WhatsApp, {body}]")
    check(len(fallbacks) == fb_before, "ответил Claude, а не запасной шаблон")
    return got


def texts(got) -> str:
    return " ".join(b for k, b in got if k == "text")


def common(got, *, first: bool, tajik: bool, card: bool) -> None:
    t = texts(got)
    low = t.lower()
    check(bool(t.strip()), "есть текст ответа")
    check(low.count("фарзона") <= (1 if first else 0),
          "называет имя Фарзона только в приветствии")
    check(not OUR_DIGITS or OUR_DIGITS not in re.sub(r"\D", "", t), "не пишет наш номер")
    greet = app.GREETING_TJ if tajik else app.GREETING_RU
    if first:
        check(t.startswith(greet), "первый ответ начинается с приветствия")
    else:
        check(not re.match(r"\s*(салом|ассалом|здравствуй|добр\w+ (день|утро|вечер))", low),
              "посреди разговора не здоровается заново")
    check(t.count("PROFIX ҳастам") + t.count("представитель компании PROFIX") <= (1 if first else 0),
          "представляется только в первом ответе")
    check(any(k == "card" for k, _ in got) == card,
          "карточка WhatsApp пришла" if card else "карточки WhatsApp нет (клиент не просил)")
    if tajik:
        check(bool(TJ_LETTERS & set(low)) or "ташаккур" in low or "салом" in low, "ответ на таджикском")
        check(not any(w in low for w in BOOKISH), "без книжных слов")
    check(len(t) <= 450, f"коротко ({len(t)} символов)")


async def main() -> None:
    print(f"Модель: {app.MODEL}\n")

    print("── 1. Таджик: приветствие, затем цена клея (как на скриншоте) ──")
    got = await say("t1", "Салому Алейкум")
    common(got, first=True, tajik=True, card=False)
    check(not any(w in texts(got).lower() for w in ("рақам", "раками", "телефон")),
          "на простое приветствие не просит номер сразу")
    got = await say("t1", "Ака клей кафел чанд сумай оптовиш")
    common(got, first=False, tajik=True, card=False)
    got = await say("t1", "Оставьте номер телефона я позвоню")
    common(got, first=False, tajik=True, card=True)

    print("\n── 2. Несколько сообщений подряд ──")
    got = await say("t2", "Салом", "Ака", "Барои плитка кадом клей хуб?")
    common(got, first=True, tajik=True, card=False)
    check(len([1 for k, _ in got if k == "text"]) == 1, "один ответ на три сообщения")

    print("\n── 3. Русский: ремонт → механизированная штукатурка ──")
    got = await say("r1", "Здравствуйте, делаю ремонт в квартире, стены кривые")
    common(got, first=True, tajik=False, card=False)
    got = await say("r1", "А сколько стоит механизированная штукатурка?")
    common(got, first=False, tajik=False, card=False)
    t = texts(got).lower()
    check("80" in t, "называет цену «от 80 сомони»")
    check("55" not in t and "себестоим" not in t, "не раскрывает внутренние цифры")
    check("обои" not in t and "покрас" not in t, "не говорит про обои и покраску после штукатурки")

    print("\n── 4. Клиент оставляет свой номер → заявка ──")
    got = await say("r1", "Площадь около 120 квадратов, Душанбе, мой номер 901234567")
    common(got, first=False, tajik=False, card=False)
    await asyncio.sleep(0.5)
    check(len(leads) == 1, "заявка ушла менеджеру")
    if leads:
        print("   " + leads[-1].replace("\n", "\n   "))

    print("\n── 5. Просит WhatsApp по-русски ──")
    got = await say("r2", "Добрый день, дайте ваш ватсап")
    common(got, first=True, tajik=False, card=True)

    print("\n── 6. Спрашивает цену мешка ──")
    got = await say("r3", "Сколько стоит гипсовая штукатурка?")
    common(got, first=True, tajik=False, card=False)
    check(not re.search(r"\d+\s*(сом|smn|с\.)", texts(got).lower()), "не выдумывает цену мешка")

    def has(got, *words) -> bool:
        low = texts(got).lower()
        return any(w in low for w in words)

    print("\n── 8. Плитка на улице → честно советует 800-й ──")
    got = await say("s1", "Какой клей нужен для плитки на улице, на фасад?")
    common(got, first=True, tajik=False, card=False)
    check(has(got, "800"), "советует Плиточный клей 800")

    print("\n── 9. «Ротбанд» → наша гипсовая штукатурка ──")
    got = await say("s2", "У вас есть ротбанд?")
    common(got, first=True, tajik=False, card=False)
    check(has(got, "fizerberg", "гипсов"), "предлагает штукатурку гипсовую FIZERBERG")

    print("\n── 10. Возражения: «дорого», «я подумаю» ──")
    got = await say("s3", "Сколько стоит механизированная штукатурка?")
    common(got, first=True, tajik=False, card=False)
    got = await say("s3", "Дорого")
    common(got, first=False, tajik=False, card=False)
    check(not has(got, "скидк"), "не придумывает скидку")
    check(has(got, "110", "цемент", "быстр", "ровн", "качеств", "под ключ", "входит"),
          "отвечает ценностью, а не уступкой")
    got = await say("s3", "Я подумаю")
    common(got, first=False, tajik=False, card=False)
    check(not has(got, "скидк", "только сегодня", "успейте"), "без давления и ложной срочности")

    print("\n── 11. Оптовик на таджикском ──")
    got = await say("s4", "Салом, 200 мешок штукатурка оптом лозим, нархаш чанд?")
    common(got, first=True, tajik=True, card=False)
    check(has(got, "рақам", "раками", "телефон"), "просит номер для оптовых условий")
    check(not re.search(r"\d+\s*сомон", texts(got).lower()), "не называет цену мешка")

    print("\n── 12. Просит менеджера → сначала предлагает помощь ──")
    got = await say("s5", "Хочу поговорить с менеджером")
    common(got, first=True, tajik=False, card=False)
    check(has(got, "помо", "подобра"), "предлагает свою помощь")
    check(has(got, "номер"), "предлагает оставить номер для менеджера")

    print("\n── 13. Под покраску → жидкая шпатлевка финишная ──")
    got = await say("s6", "Что нанести на стены перед покраской?")
    common(got, first=True, tajik=False, card=False)
    check(has(got, "шпатл"), "предлагает жидкую шпатлевку финишную")

    print("\n── 14. «Вы бот?» → честно ──")
    got = await say("s7", "Вы бот или человек?")
    common(got, first=True, tajik=False, card=False)
    check(has(got, "виртуальн", "помощни"), "честно говорит, что виртуальный помощник")

    print("\n── 15. Грубость → спокойно и вежливо ──")
    got = await say("s8", "Вы все обманщики, товар плохой")
    common(got, first=True, tajik=False, card=False)
    check(not has(got, " ты ", "сам ты"), "без грубости в ответ")

    print("\n── 16. Комментарий под постом с просьбой номера ──")
    posted: list[str] = []
    private: list[str] = []

    async def _reply_to_comment(cid, text):
        posted.append(text)

    async def _card(recipient, tajik):
        private.append("card")
        return True

    async def _private(cid, text):
        private.append(text)

    app.reply_to_comment = _reply_to_comment
    app.send_whatsapp_card = _card
    app.send_private_reply = _private
    await app.handle_comment("c1", "someone", "Номер телефона дайте")
    print(f"💬 публично: {posted[-1] if posted else '—'}")
    print(f"📩 в директ: {private}")
    pub = (posted[-1] if posted else "").lower()
    check("фарзон" not in pub and not re.search(r"\d{6,}", pub), "в комментарии нет имени и номера")
    check(private == ["card"], "в директ ушла карточка WhatsApp")

    print("\n══════════")
    if failures:
        print(f"❌ Ошибок: {len(failures)}")
        for f in failures:
            print(f"   • {f}")
    else:
        print("✅ Все проверки пройдены")


asyncio.run(main())
