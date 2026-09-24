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
ALLOW_UNSIGNED = os.getenv("ALLOW_UNSIGNED", "").strip() == "1"
OUR_IG_USERNAME = os.getenv("OUR_IG_USERNAME", "profix_dushanbe").strip().lower()

# Claude доступен двумя путями: через AIsa (api.aisa.one — тот же Claude,
# но оплата с кошелька AIsa) или напрямую у Anthropic. Задан ключ AIsa —
# идём через него, иначе через ANTHROPIC_API_KEY.
AISA_KEY = os.getenv("AISA_API_KEY", "").strip()
AISA_BASE_URL = os.getenv("AISA_BASE_URL", "https://api.aisa.one").strip().rstrip("/")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
MODEL = os.getenv("BOT_MODEL", "claude-opus-5")
BRAIN = "aisa" if AISA_KEY else "claude" if ANTHROPIC_KEY else "fallback"

# Куда уходят лиды. Сегодня Telegram, завтра шлюз WhatsApp —
# меняется одной переменной, код трогать не нужно.
LEAD_CHANNEL = os.getenv("LEAD_CHANNEL", "telegram")
TG_TOKEN = os.getenv("BOT_TOKEN", "").strip()
TG_CHAT_IDS = [c.strip() for c in os.getenv("OWNER_IDS", "").split(",") if c.strip()]
WA_GATEWAY_URL = os.getenv("WA_GATEWAY_URL", "").strip()
WA_GATEWAY_TOKEN = os.getenv("WA_GATEWAY_TOKEN", "").strip()
WA_TO = os.getenv("WA_TO", "").strip()

# WhatsApp Business компании. Бот может дать его клиенту, который
# хочет написать сам, — но сначала всё равно просит номер клиента.
MANAGER_WHATSAPP = os.getenv("MANAGER_WHATSAPP", "+992999518999").strip()
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

SYSTEM = f"""Тебя зовут Фарзона, ты представитель компании PROFIX в Instagram
Direct. Отвечаешь клиентам, которые пришли из публикаций про нашу
продукцию.

КТО ТЫ
- Ты девушка. По-русски говори о себе в женском роде: «рада помочь»,
  «я поняла», «я подобрала». Никогда «рад», «понял», «подобрал».
- В первом сообщении диалога поздоровайся и представься именно так:
  «Здравствуйте! Меня зовут Фарзона, я представитель компании PROFIX.»
  По-таджикски: «Салом! Номи ман Фарзона, ман намояндаи ширкати
  PROFIX ҳастам.» Сразу после этого — короткий вопрос по делу.
  Дальше по имени себя не называй, только если спросят.
- Если клиент прямо спросит, живой ли человек с ним переписывается
  или бот, — не обманывай: скажи, что ты виртуальный помощник PROFIX,
  а живой менеджер подключится, если оставить номер.

{CATALOG}

{"ЦЕНЫ (можешь называть): " + PRICES if PRICES else
 "ЦЕНЫ: тебе они неизвестны. Никогда не называй и не прикидывай цифры — скажи, что цену назовёт менеджер, и предложи оставить номер."}


КАК ТЫ РАБОТАЕШЬ

Твоя цель — не просто ответить, а довести разговор до заявки:
клиент оставляет номер телефона, и менеджер ему звонит.

- ПИШИ ОЧЕНЬ КОРОТКО. Максимум два предложения, до 200 символов.
  Это переписка в директе, а не статья: длинное сообщение клиент
  не дочитает и уйдёт.
- Один вопрос за раз. Не задавай три подряд.
- Никаких списков, заголовков и перечислений через запятую на
  полстроки. Простая живая фраза.
- Пиши на языке клиента: по-русски — отвечай по-русски, на таджикском —
  на таджикском. Но НАЗВАНИЯ ПРОДУКЦИИ никогда не переводи, не меняй
  и не подгоняй под таджикскую грамматику — даже в таджикской фразе
  название вставляй ровно как на упаковке: «Штукатурка гипсовая
  FIZERBERG», «Плиточный клей 700», «Ровнитель для пола». НЕПРАВИЛЬНО:
  «штукатуркаи гипси» (изафет, перевод) — ПРАВИЛЬНО: «штукатурка
  гипсовая FIZERBERG» (как на мешке), даже посреди таджикского
  предложения. Так клиент узнает товар, если увидит его вживую или
  в публикации.
- Говори по-человечески, без канцелярита и без «уважаемый клиент».
- Сначала пойми задачу клиента, потом предлагай. Спроси, что за объект,
  внутри или снаружи, какая площадь.
- Советуй то, что действительно подходит. Если клиент собрался класть
  плитку на улице — честно скажи, что нужен 800-й, а не 700-й.
- Предлагай сопутствующее, когда это уместно: под жидкую шпатлевку —
  грунтовку PROFIX, под штукатурку — работы нашей бригадой.
- Номер телефона проси естественно, когда разговор к этому подошёл,
  а не в первом же сообщении.{
  " Если клиенту удобнее написать самому — сначала всё же предложи"
  " оставить номер: так менеджер перезвонит сам. Если он всё равно"
  " хочет написать сам, дай кнопку WhatsApp: ответь ОДНОЙ меткой"
  " [WHATSAPP], без всякого текста. Бот сам пришлёт карточку с"
  " логотипом и кнопкой — комментировать её («нажмите кнопку ниже»)"
  " не нужно. Сам номер WhatsApp и ссылку на него НИКОГДА не пиши."
  if MANAGER_WHATSAPP else ""
  }
- Получил номер — поблагодари и скажи, что менеджер свяжется.

КОГДА КЛИЕНТ ПРОСИТ МЕНЕДЖЕРА
- Если клиент пишет, что хочет поговорить с менеджером, с живым
  человеком, «соедините с начальником» и т.п., — сначала один раз
  предложи свою помощь. Например: «Могу сама помочь прямо здесь — подобрать
  продукцию и ответить на вопросы. А если удобнее поговорить с
  менеджером — оставьте номер телефона, он вам перезвонит.»
  По-таджикски: «Метавонам ҳамин ҷо дар интихоби маҳсулот кӯмак
  кунам. Агар бо менеҷер гап задан хоҳед — рақами телефонатонро
  монед, ӯ ба шумо занг мезанад.»
- Если клиент соглашается общаться с тобой — продолжай консультацию.
- Если клиент настаивает на менеджере или сразу пишет номер — больше
  не уговаривай, просто возьми номер, поблагодари и скажи, что
  менеджер перезвонит.
- Спрашивает цену — это тоже повод сказать, что цену назовёт менеджер,
  и попросить номер.

ЧЕГО НЕ ДЕЛАЕШЬ

- Не выдумываешь фактов, которых нет в описании выше. Не знаешь —
  так и скажи, предложи уточнить у менеджера.
- НИКОГДА не называешь номер телефона, WhatsApp, объёмы, сроки или
  любые другие цифры и контакты, которых нет в этом промпте или в
  переписке с клиентом. Нет номера менеджера в инструкции — значит
  его нет, не сочиняй похожий на настоящий. Сомневаешься — не пиши
  цифру вообще, просто предложи оставить номер клиента.
- Не называешь расход на м²: он зависит от кривизны основания.
- Не обещаешь сроки поставки и наличие.
- Не обсуждаешь ничего, кроме продукции PROFIX и работ с ней.
- Не давишь и не уговариваешь навязчиво. Ты помогаешь выбрать,
  а не впариваешь.
"""

COMMENT_SYSTEM = SYSTEM + """

СЕЙЧАС ТЫ ОТВЕЧАЕШЬ НА КОММЕНТАРИЙ ПОД ПУБЛИКАЦИЕЙ, А НЕ В ДИРЕКТЕ.

Это видят все. Поэтому:
- ОДНО предложение, максимум 120 символов. Не два, не три.
- Своё имя в комментарии НЕ называй — представишься только в директе.
- Никаких номеров телефона и WhatsApp в комментарии — ни нашего, ни
  чужого, даже если просят. Всё это только в директе.
- Просят номер телефона или WhatsApp — ответь: «Отправили вам в директ 👌»
  (по-таджикски: «Ба директ фиристодем 👌»). Сам номер не пиши.
- Ответь по существу вопроса, если он есть.
- В конце позови в личку: «написали вам в директ» или «подробности в директе».
- Никаких цен, даже если спрашивают прямо.
- На «огонь», смайлики и похвалу отвечай коротким спасибо, без продаж.
- На грубость и претензии не спорь: извинись одной фразой и позови
  к менеджеру в директ.
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


# Раньше после карточки WhatsApp в историю писалась пометка вроде
# «(отправлена кнопка WhatsApp)», и модель начала слать её клиенту
# текстом. Теперь в историю идёт сама метка, а старые пометки в уже
# сохранённых диалогах и в ответах модели распознаём и заменяем.
_WA_NOTE_RE = re.compile(r"\(отправлен\w*\s+(?:карточк\w*|кнопк\w*)[^)]*whatsapp[^)]*\)", re.IGNORECASE)


def history_for(sender: str) -> list[dict[str, str]]:
    item = STATE.get(sender)
    if not item or time.time() - item.get("ts", 0) > DIALOG_TTL:
        return []
    messages = item.get("messages", [])
    for m in messages:
        if m.get("role") == "assistant" and _WA_NOTE_RE.search(m.get("content", "")):
            m["content"] = WHATSAPP_MARK
    return messages


def remember(sender: str, role: str, text: str) -> None:
    item = STATE.setdefault(sender, {"messages": [], "ts": 0, "lead_sent": False})
    if time.time() - item.get("ts", 0) > DIALOG_TTL:
        item["messages"] = []
        item["lead_sent"] = False
    item["messages"] = (item["messages"] + [{"role": role, "content": text}])[-HISTORY_LIMIT:]
    item["ts"] = time.time()
    _save_state(STATE)


# ── разговор ───────────────────────────────────────────────────────

async def ask_claude(messages: list[dict[str, str]], system: str = "") -> str | None:
    if BRAIN == "fallback":
        return None
    try:
        from anthropic import AsyncAnthropic, omit
    except ImportError:
        print("пакет anthropic не установлен", flush=True)
        return None

    if BRAIN == "aisa":
        # AIsa ждёт ключ как Bearer. X-Api-Key выключаем явно: иначе SDK
        # сам подхватит ANTHROPIC_API_KEY из окружения и отправит ключ
        # Anthropic на чужой сервер.
        client = AsyncAnthropic(
            base_url=AISA_BASE_URL,
            auth_token=AISA_KEY,
            default_headers={"X-Api-Key": omit},
        )
    else:
        client = AsyncAnthropic(api_key=ANTHROPIC_KEY)
    try:
        resp = await client.messages.create(
            model=MODEL,
            max_tokens=300,
            # Системный промпт большой и неизменный — кешируем его,
            # иначе каждый ответ оплачивается по полной.
            system=[{"type": "text", "text": system or SYSTEM, "cache_control": {"type": "ephemeral"}}],
            # Через extra_body: закреплённый anthropic==0.69.0 ещё не знает
            # параметр output_config и падает с TypeError до отправки.
            extra_body={"output_config": {"effort": "low"}},
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


_TAJIK_WORDS = ("салом", "рахмат", "раҳмат", "чанд", "нарх", "мехоҳам", "мехохам", "лозим")


def looks_tajik(text: str) -> bool:
    lowered = text.lower()
    return any(ch in lowered for ch in "қғӣӯҳҷ") or any(w in lowered for w in _TAJIK_WORDS)


GREETING_RU = "Здравствуйте! Меня зовут Фарзона, я представитель компании PROFIX."
GREETING_TJ = "Салом! Номи ман Фарзона, ман намояндаи ширкати PROFIX ҳастам."


def fallback_reply(text: str) -> str:
    """Ответ без Claude — чтобы бот не молчал, если ключа нет."""
    if find_phone(text):
        return ("Спасибо! Номер получили, менеджер свяжется с вами. "
                "Напишите, что именно нужно и какой объём.")
    if looks_tajik(text):
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


WHATSAPP_MARK = "[WHATSAPP]"


def strip_our_number(text: str) -> str:
    """Убирает из текста наш номер WhatsApp в любом написании и ссылки wa.me."""
    digits = re.sub(r"\D", "", MANAGER_WHATSAPP)
    if not digits:
        return text
    text = re.sub(r"https?://(?:wa\.me|api\.whatsapp\.com)/\S*", "", text)
    local = digits[-9:]
    # Цифры номера, между которыми могут стоять пробелы, скобки и дефисы.
    sep = r"[\s\-().]*"
    pattern = r"\+?(?:" + sep.join(digits[:-9]) + sep + r")?" + sep.join(local)
    text = re.sub(pattern, "", text)
    text = re.sub(r"\s+([.,!?:;])", r"\1", text)
    text = re.sub(r"[:—-]\s*([.!?]|$)", r"\1", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


_CONTACT_RE = re.compile(
    r"номер|телефон|тел\b|контакт|ватсап|вацап|вотсап|whats\s*app|вотс|\bwa\b"
    r"|рақам|раками|рақами|телефонатон|позвон|связ",
    re.IGNORECASE,
)


def asks_contact(text: str) -> bool:
    """Клиент просит номер телефона или WhatsApp."""
    return bool(_CONTACT_RE.search(text))


def whatsapp_url() -> str:
    return "https://wa.me/" + re.sub(r"\D", "", MANAGER_WHATSAPP)


# Картинка карточки лежит на GitHub Pages: Instagram берёт её только по
# публичной ссылке. Instagram показывает её квадратом во всю ширину
# карточки (уменьшить нельзя), прозрачность заливает белым, а GIF не
# проигрывает — поэтому это квадратный логотип PROFIX с короткой
# подсказкой под ним на языке клиента: wa-profix-ru.png / wa-profix-tj.png.
WA_CARD_BASE = os.getenv("WA_CARD_BASE", "https://dalefa500.github.io/My-Profix/img").rstrip("/")
WA_CARD_IMAGE = os.getenv("WA_CARD_IMAGE", "wa-profix-{lang}.png").strip()


async def _post_message(recipient: dict[str, str], message: dict[str, Any]) -> httpx.Response:
    url = f"https://graph.instagram.com/{GRAPH_API_VERSION}/me/messages"
    async with httpx.AsyncClient(timeout=20) as http:
        return await http.post(
            url,
            params={"access_token": IG_ACCESS_TOKEN},
            json={"recipient": recipient, "message": message},
        )


async def send_whatsapp_card(recipient: dict[str, str], tajik: bool) -> bool:
    """Круглый логотип PROFIX и кнопка «WhatsApp» под ним.

    Номер клиент не видит. Лишнего текста в карточке нет: у Instagram
    заголовок обязателен, поэтому сначала пробуем невидимый, потом
    «PROFIX», потом простую кнопку без картинки. True — если дошло.
    """
    wa = whatsapp_url()
    button = {"type": "web_url", "url": wa, "title": "WhatsApp"}

    def card(title: str) -> dict[str, Any]:
        return {"attachment": {"type": "template", "payload": {
            "template_type": "generic",
            "elements": [{
                "title": title,
                "image_url": f"{WA_CARD_BASE}/" + WA_CARD_IMAGE.format(lang="tj" if tajik else "ru"),
                "default_action": {"type": "web_url", "url": wa},
                "buttons": [button],
            }],
        }}}

    plain = {"attachment": {"type": "template", "payload": {
        "template_type": "button",
        "text": "WhatsApp PROFIX 👇",
        "buttons": [{**button, "title": "Навиштан ба WhatsApp" if tajik else "Написать в WhatsApp"}],
    }}}
    attempts = (("карточка", card("\u2060")), ("карточка PROFIX", card("PROFIX")), ("кнопка", plain))
    for kind, message in attempts:
        resp = await _post_message(recipient, message)
        if resp.status_code < 400:
            return True
        print(f"WhatsApp: {kind} не ушла: {resp.status_code} {resp.text[:300]}", flush=True)
    return False


async def send_whatsapp_button(recipient_id: str, tajik: bool) -> None:
    """Кнопка WhatsApp в директе; не вышло — голая ссылка, чтобы клиент
    всё равно смог написать (номер в ней виден)."""
    if not await send_whatsapp_card({"id": recipient_id}, tajik):
        await send_message(recipient_id, whatsapp_url())


async def reply_to_comment(comment_id: str, text: str) -> None:
    """Публичный ответ веткой под комментарием."""
    url = f"https://graph.instagram.com/{GRAPH_API_VERSION}/{comment_id}/replies"
    async with httpx.AsyncClient(timeout=20) as http:
        resp = await http.post(url, params={"access_token": IG_ACCESS_TOKEN},
                               data={"message": text[:280]})
    if resp.status_code >= 400:
        print(f"ответ на комментарий отклонён: {resp.status_code} {resp.text[:300]}", flush=True)


async def send_private_reply(comment_id: str, text: str) -> None:
    """Личное сообщение тому, кто оставил комментарий.

    Meta разрешает написать первым, если человек прокомментировал нашу
    публикацию, — но только один раз и только по этому комментарию.
    """
    url = f"https://graph.instagram.com/{GRAPH_API_VERSION}/me/messages"
    async with httpx.AsyncClient(timeout=20) as http:
        resp = await http.post(
            url,
            params={"access_token": IG_ACCESS_TOKEN},
            json={"recipient": {"comment_id": comment_id}, "message": {"text": text[:1000]}},
        )
    if resp.status_code >= 400:
        print(f"личное сообщение по комментарию отклонено: {resp.status_code} {resp.text[:300]}", flush=True)


async def handle_comment(comment_id: str, author: str, text: str) -> None:
    public = await ask_claude([{"role": "user", "content": text}], system=COMMENT_SYSTEM)
    if public:
        public = public.replace(WHATSAPP_MARK, "").strip()
    # Комментарий видят все: имя и номер там запрещены. Промпт об этом
    # просит, а здесь страховка — если модель всё же их вставила,
    # публикуем нейтральную фразу, а подробности уйдут в директ.
    if public and (find_phone(public) or "фарзона" in public.lower()):
        print("ответ на комментарий содержал имя или номер — заменён", flush=True)
        public = None
    if not public:
        public = "Спасибо за вопрос! Написали вам в директ."
    await reply_to_comment(comment_id, public)

    tajik = looks_tajik(text)
    # Спрашивают номер или WhatsApp — первым сообщением в директ сразу
    # шлём карточку с кнопкой. По комментарию Meta разрешает написать
    # только одно сообщение, поэтому это и будет оно.
    if asks_contact(text) and MANAGER_WHATSAPP:
        if await send_whatsapp_card({"comment_id": comment_id}, tajik):
            return
        print("карточка по комментарию не ушла — шлём текст", flush=True)

    opener = await ask_claude([{"role": "user", "content":
        f"Клиент написал под нашей публикацией: «{text}». "
        f"Напиши ему первое сообщение в директ: поздоровайся, ответь по делу "
        f"и мягко выясни задачу."}])
    if opener:
        opener = strip_our_number(opener.replace(WHATSAPP_MARK, "")).strip()
        if "фарзона" not in opener.lower():
            opener = f"{GREETING_TJ if tajik else GREETING_RU} {opener}"
        await send_private_reply(comment_id, opener)


def iter_comments(payload: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Достаёт (id комментария, автор, текст) из события."""
    found: list[tuple[str, str, str]] = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            if change.get("field") != "comments":
                continue
            value = change.get("value") or {}
            author = ((value.get("from") or {}).get("username") or "").lower()
            # Свои же комментарии и ответы пропускаем, иначе бот
            # ответит сам себе и уйдёт в бесконечную ветку.
            if author == OUR_IG_USERNAME:
                continue
            cid = value.get("id") or ""
            text = (value.get("text") or "").strip()
            if cid and text:
                found.append((cid, author, text))
    return found


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
    # Аварийный клапан: если Meta вдруг сменит секрет, бот замолчит.
    # Тогда ALLOW_UNSIGNED=1 вернёт приём событий, адресованных нашему
    # аккаунту, — но это дыра, и включать её стоит только на время.
    if ALLOW_UNSIGNED and OUR_IG_ID and OUR_IG_ID.encode() in body:
        print("ВНИМАНИЕ: подпись не сошлась, пропускаю по ALLOW_UNSIGNED", flush=True)
        return True
    # Отклонённые запросы почти всегда — уведомления о прочтении
    # ("read"), не сами сообщения: их подписывает другой продукт
    # Meta, и это не влияет на приём заявок. Текст сообщений в лог
    # не пишем — это переписка клиентов.
    print(f"ОТКЛОНЕНО: подпись не сошлась (длина тела {len(body)})", flush=True)
    return False


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "brain": BRAIN}


@app.get("/webhook")
async def verify_webhook(request: Request) -> Response:
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == VERIFY_TOKEN:
        return Response(content=q.get("hub.challenge", ""), media_type="text/plain")
    raise HTTPException(status_code=403, detail="Verification failed")


async def handle_message(sender: str, text: str) -> None:
    remember(sender, "user", text)
    history = history_for(sender)

    first_reply = not any(m["role"] == "assistant" for m in history)

    reply = await ask_claude(history) or fallback_reply(text)

    # В первом ответе Фарзона обязательно представляется. Промпт это
    # требует, а здесь страховка на случай, если модель забыла.
    tajik = looks_tajik(text)
    if first_reply and "фарзона" not in reply.lower():
        reply = f"{GREETING_TJ if tajik else GREETING_RU} {reply}"

    wants_button = bool(MANAGER_WHATSAPP) and (
        WHATSAPP_MARK in reply or bool(_WA_NOTE_RE.search(reply)))
    reply = _WA_NOTE_RE.sub("", reply.replace(WHATSAPP_MARK, "")).strip()
    # Номер WhatsApp в тексте не показываем. Модель его не знает, но
    # может повторить из старой переписки — тогда вырезаем его и шлём
    # кнопку вместо цифр.
    stripped = strip_our_number(reply)
    if stripped != reply:
        reply, wants_button = stripped, bool(MANAGER_WHATSAPP)
    remember(sender, "assistant", WHATSAPP_MARK if wants_button else reply)
    if wants_button:
        # Только карточка с логотипом и кнопкой — без подписи над ней.
        await send_whatsapp_button(sender, tajik)
    elif reply:
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

    for cid, author, text in iter_comments(payload):
        if not already_handled(f"comment:{cid}"):
            print(f"комментарий от @{author}: {text[:80]}", flush=True)
            await handle_comment(cid, author, text)

    return {"status": "received"}
