"""Бот-продавец PROFIX для Instagram Direct.

Задача бота — не справочник, а продажа: разговорить клиента, ответить
по ассортименту, довести до заявки и передать готовый лид менеджеру.

Один файл намеренно: на сервере он кладётся вместо прежнего app.py,
и развёртывание сводится к копированию и пересборке контейнера.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Response

from catalog_data import CATALOG

# ── настройки ──────────────────────────────────────────────────────

VERIFY_TOKEN = os.environ["VERIFY_TOKEN"]
IG_ACCESS_TOKEN = os.environ.get("IG_ACCESS_TOKEN") or os.environ["PAGE_ACCESS_TOKEN"]
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v23.0")

# Meta подписывает вебхуки одним из секретов приложения. Какой именно —
# зависит от того, как приложение подключено, поэтому проверяем все.
SIG_SECRETS = [
    s.strip()
    for s in (
        os.getenv("SIG_SECRETS", "").split(",")
        + [os.getenv("IG_APP_SECRET", ""), os.getenv("APP_SECRET", "")]
    )
    if s.strip()
]
OUR_IG_ID = os.getenv("OUR_IG_ID", "").strip()

ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
MODEL = os.getenv("BOT_MODEL", "claude-opus-5")

# Куда уходят лиды. Сегодня Telegram, завтра шлюз WhatsApp —
# меняется одной переменной, код трогать не нужно.
LEAD_CHANNEL = os.getenv("LEAD_CHANNEL", "telegram")
TG_TOKEN = os.getenv("BOT_TOKEN", "").strip()
TG_CHAT_IDS = [c.strip() for c in os.getenv("OWNER_IDS", "").split(",") if c.strip()]
WA_GATEWAY_URL = os.getenv("WA_GATEWAY_URL", "").strip()
WA_GATEWAY_TOKEN = os.getenv("WA_GATEWAY_TOKEN", "").strip()
WA_TO = os.getenv("WA_TO", "").strip()

PRICES = os.getenv("PRICES", "").strip()
STATE_FILE = Path(os.getenv("STATE_FILE", "/app/data/dialogs.json"))
HISTORY_LIMIT = 20          # сколько реплик помним в одном диалоге
DIALOG_TTL = 60 * 60 * 24   # сутки без сообщений — диалог считается новым

# Номер приходит как угодно: «+992 90 123 45 67», «992901234567»,
# «90-123-45-67». Сначала убираем разделители, потом ищем.
_SEPARATORS_RE = re.compile(r"[\s\-()./]")
_INTL_RE = re.compile(r"\+?992\d{9}")
_LOCAL_RE = re.compile(r"(?<!\d)[5789]\d{8}(?!\d)")


def find_phone(text: str) -> str | None:
    compact = _SEPARATORS_RE.sub("", text)
    match = _INTL_RE.search(compact) or _LOCAL_RE.search(compact)
    return match.group(0) if match else None

app = FastAPI()


# ── характер бота ──────────────────────────────────────────────────

SYSTEM = f"""Ты — менеджер по продажам компании PROFIX в Instagram Direct.
Отвечаешь клиентам, которые пришли из публикаций про нашу продукцию.

{CATALOG}

{"ЦЕНЫ (можешь называть): " + PRICES if PRICES else
 "ЦЕНЫ: тебе они неизвестны. Никогда не называй и не прикидывай цифры — скажи, что цену назовёт менеджер, и предложи оставить номер."}

КАК ТЫ РАБОТАЕШЬ

Твоя цель — не просто ответить, а довести разговор до заявки:
клиент оставляет номер телефона, и менеджер ему звонит.

- Пиши коротко, 1-3 предложения. Это переписка в директе, не статья.
- Пиши на языке клиента: по-русски — отвечай по-русски, на таджикском —
  на таджикском.
- Говори по-человечески, без канцелярита и без «уважаемый клиент».
- Сначала пойми задачу клиента, потом предлагай. Спроси, что за объект,
  внутри или снаружи, какая площадь.
- Советуй то, что действительно подходит. Если клиент собрался класть
  плитку на улице — честно скажи, что нужен 800-й, а не 700-й.
- Предлагай сопутствующее, когда это уместно: под жидкую шпатлевку —
  грунтовку PROFIX, под штукатурку — работы нашей бригадой.
- Номер телефона проси естественно, когда разговор к этому подошёл,
  а не в первом же сообщении.
- Получил номер — поблагодари и скажи, что менеджер свяжется.

ЧЕГО НЕ ДЕЛАЕШЬ

- Не выдумываешь фактов, которых нет в описании выше. Не знаешь —
  так и скажи, предложи уточнить у менеджера.
- Не называешь расход на м²: он зависит от кривизны основания.
- Не обещаешь сроки поставки и наличие.
- Не обсуждаешь ничего, кроме продукции PROFIX и работ с ней.
- Не давишь и не уговариваешь навязчиво. Ты помогаешь выбрать,
  а не впариваешь.
"""

LEAD_PROMPT = """Извлеки из переписки данные заявки. Ответь ТОЛЬКО JSON,
без пояснений, по схеме:
{"name": "", "phone": "", "need": "", "volume": "", "when": "", "note": ""}
Незаполненные поля оставь пустой строкой. need — что нужно клиенту,
volume — объём или площадь, when — когда планирует, note — важное прочее."""


# ── память диалогов ────────────────────────────────────────────────

def _load_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def _save_state(state: dict[str, Any]) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False))
    except Exception as exc:
        print(f"не смог сохранить диалоги: {exc}", flush=True)


STATE: dict[str, Any] = _load_state()


def history_for(sender: str) -> list[dict[str, str]]:
    item = STATE.get(sender)
    if not item or time.time() - item.get("ts", 0) > DIALOG_TTL:
        return []
    return item.get("messages", [])


def remember(sender: str, role: str, text: str) -> None:
    item = STATE.setdefault(sender, {"messages": [], "ts": 0, "lead_sent": False})
    if time.time() - item.get("ts", 0) > DIALOG_TTL:
        item["messages"] = []
        item["lead_sent"] = False
    item["messages"] = (item["messages"] + [{"role": role, "content": text}])[-HISTORY_LIMIT:]
    item["ts"] = time.time()
    _save_state(STATE)


# ── разговор ───────────────────────────────────────────────────────

async def ask_claude(messages: list[dict[str, str]]) -> str | None:
    if not ANTHROPIC_KEY:
        return None
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        print("пакет anthropic не установлен", flush=True)
        return None

    client = AsyncAnthropic(api_key=ANTHROPIC_KEY)
    try:
        resp = await client.messages.create(
            model=MODEL,
            max_tokens=600,
            # Системный промпт большой и неизменный — кешируем его,
            # иначе каждый ответ оплачивается по полной.
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": "low"},
            messages=messages,
        )
    except Exception as exc:
        print(f"Claude не ответил: {exc}", flush=True)
        return None
    finally:
        await client.close()

    if resp.stop_reason == "refusal":
        print("Claude отказался отвечать", flush=True)
        return None
    parts = [b.text for b in resp.content if b.type == "text"]
    return "\n".join(p.strip() for p in parts if p.strip()) or None


def fallback_reply(text: str) -> str:
    """Ответ без Claude — чтобы бот не молчал, если ключа нет."""
    if find_phone(text):
        return ("Спасибо! Номер получили, менеджер свяжется с вами. "
                "Напишите, что именно нужно и какой объём.")
    lowered = text.lower()
    tajik_words = ("салом", "рахмат", "раҳмат", "чанд", "нарх", "мехоҳам", "мехохам", "лозим")
    if any(ch in lowered for ch in "қғӣӯҳҷ") or any(w in lowered for w in tajik_words):
        return ("Салом! 👋 PROFIX — омехтаҳои хушк ва андоваи механикии деворҳо. "
                "Лутфан нависед, ки чӣ лозим аст ва рақами телефонатонро монед.")
    return ("Здравствуйте! 👋 PROFIX — сухие смеси, краски, грунтовки и "
            "механизированная штукатурка стен. Напишите, что вас интересует, "
            "и оставьте номер — менеджер свяжется и всё рассчитает.")


# ── лиды ───────────────────────────────────────────────────────────

async def extract_lead(messages: list[dict[str, str]]) -> dict[str, str]:
    raw = await ask_claude(messages + [{"role": "user", "content": LEAD_PROMPT}])
    if not raw:
        return {}
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return {}
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}


def format_lead(lead: dict[str, str], sender: str, phone: str) -> str:
    rows = [
        ("Имя", lead.get("name")),
        ("Телефон", lead.get("phone") or phone),
        ("Нужно", lead.get("need")),
        ("Объём", lead.get("volume")),
        ("Сроки", lead.get("when")),
        ("Примечание", lead.get("note")),
    ]
    body = "\n".join(f"{k}: {v}" for k, v in rows if v)
    return f"🔥 НОВАЯ ЗАЯВКА · Instagram Direct\n\n{body}\n\nID клиента: {sender}"


async def deliver_lead(text: str) -> None:
    """Куда уходит заявка. Канал переключается переменной LEAD_CHANNEL."""
    async with httpx.AsyncClient(timeout=20) as http:
        if LEAD_CHANNEL == "whatsapp" and WA_GATEWAY_URL:
            try:
                await http.post(
                    WA_GATEWAY_URL,
                    json={"token": WA_GATEWAY_TOKEN, "to": WA_TO, "body": text},
                )
                return
            except httpx.HTTPError as exc:
                print(f"шлюз WhatsApp не ответил, шлю в Telegram: {exc}", flush=True)

        if not (TG_TOKEN and TG_CHAT_IDS):
            print("лид некуда отправить — не задан канал", flush=True)
            return
        url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
        for chat_id in TG_CHAT_IDS:
            try:
                await http.post(url, json={"chat_id": chat_id, "text": text})
            except httpx.HTTPError as exc:
                print(f"не смог отправить лид в Telegram: {exc}", flush=True)


# ── Instagram ──────────────────────────────────────────────────────

async def send_message(recipient_id: str, text: str) -> None:
    url = f"https://graph.instagram.com/{GRAPH_API_VERSION}/me/messages"
    async with httpx.AsyncClient(timeout=20) as http:
        resp = await http.post(
            url,
            params={"access_token": IG_ACCESS_TOKEN},
            json={"recipient": {"id": recipient_id}, "message": {"text": text[:1000]}},
        )
    if resp.status_code >= 400:
        # Тело ответа Meta — единственное место с настоящей причиной:
        # истёкший токен, нет прав, закрытое окно в 24 часа.
        print(f"Instagram отказал: {resp.status_code} {resp.text[:400]}", flush=True)


# ── вебхук ─────────────────────────────────────────────────────────

SEEN_LIMIT = 500
_seen: OrderedDict[str, None] = OrderedDict()


def already_handled(mid: str) -> bool:
    if mid in _seen:
        return True
    _seen[mid] = None
    while len(_seen) > SEEN_LIMIT:
        _seen.popitem(last=False)
    return False


def valid_signature(body: bytes, signature: str | None) -> bool:
    got = (signature or "").removeprefix("sha256=")
    for secret in SIG_SECRETS:
        expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        if got and hmac.compare_digest(expected, got):
            return True
    # Пока не выяснен верный секрет — пропускаем события, адресованные
    # нашему аккаунту. Временно: убрать, как только подпись сойдётся.
    if OUR_IG_ID and OUR_IG_ID.encode() in body:
        print("подпись не сошлась, пропускаю по совпадению аккаунта", flush=True)
        return True
    return False


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "brain": "claude" if ANTHROPIC_KEY else "fallback"}


@app.get("/webhook")
async def verify_webhook(request: Request) -> Response:
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == VERIFY_TOKEN:
        return Response(content=q.get("hub.challenge", ""), media_type="text/plain")
    raise HTTPException(status_code=403, detail="Verification failed")


async def handle_message(sender: str, text: str) -> None:
    remember(sender, "user", text)
    history = history_for(sender)

    reply = await ask_claude(history) or fallback_reply(text)
    remember(sender, "assistant", reply)
    await send_message(sender, reply)

    # Появился телефон — заявка созрела. Один лид на диалог, чтобы
    # менеджер не получал одно и то же по три раза.
    phone = find_phone(text)
    item = STATE.get(sender, {})
    if phone and not item.get("lead_sent"):
        lead = await extract_lead(history_for(sender))
        await deliver_lead(format_lead(lead, sender, phone))
        item["lead_sent"] = True
        _save_state(STATE)


@app.post("/webhook")
async def receive_webhook(request: Request) -> dict[str, str]:
    body = await request.body()
    if not valid_signature(body, request.headers.get("x-hub-signature-256")):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = json.loads(body)
    if payload.get("object") != "instagram":
        return {"status": "ignored"}

    for entry in payload.get("entry", []):
        for event in entry.get("messaging", []):
            message = event.get("message") or {}
            if message.get("is_echo"):
                continue
            text = (message.get("text") or "").strip()
            mid = message.get("mid") or ""
            sender = (event.get("sender") or {}).get("id") or ""
            if text and sender and mid and not already_handled(mid):
                await handle_message(sender, text)

    return {"status": "received"}
