"""Вебхук Instagram Direct.

Отдельное приложение, а не роут в web/main.py: туда ходит только владелец
по PIN-коду, а сюда — Meta и, через неё, любой человек из интернета. Общий
процесс означал бы, что дыра в публичном обработчике достаёт до кассы.
Здесь нет ни токена МойСклад, ни сессий, ни финансовых данных.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import BackgroundTasks, FastAPI, Request, Response

from .brain import build_reply
from .config import load_config
from .graph import GraphClient, notify_manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Meta повторяет доставку, если не ответить 200 достаточно быстро, поэтому
# один и тот же mid приходит по нескольку раз. Помним последние, чтобы не
# отвечать клиенту дважды на одно сообщение.
SEEN_LIMIT = 500
_seen_mids: OrderedDict[str, None] = OrderedDict()


def _already_handled(mid: str) -> bool:
    if mid in _seen_mids:
        return True
    _seen_mids[mid] = None
    while len(_seen_mids) > SEEN_LIMIT:
        _seen_mids.popitem(last=False)
    return False


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.config = load_config()
    app.state.graph = GraphClient(app.state.config)
    logger.info(
        "Instagram-бот запущен (Claude: %s)",
        "да" if app.state.config.uses_claude else "нет, работают правила",
    )
    try:
        yield
    finally:
        await app.state.graph.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/webhook")
async def verify(request: Request) -> Response:
    """Разовая проверка адреса при подключении вебхука в консоли Meta.

    Meta дёргает этот адрес с нашим же verify token и ждёт обратно
    hub.challenge простым текстом. Пока этот шаг не пройдёт, вебхук в
    консоли сохранить нельзя.
    """
    config = request.app.state.config
    params = request.query_params

    if params.get("hub.mode") == "subscribe" and params.get("hub.verify_token") == config.verify_token:
        challenge = params.get("hub.challenge", "")
        logger.info("Meta подтвердила адрес вебхука")
        return Response(content=challenge, media_type="text/plain")

    logger.warning("Проверка вебхука не прошла: неверный verify token")
    return Response(content="forbidden", status_code=403)


def _signature_ok(secret: str, body: bytes, header: str | None) -> bool:
    """Подпись Meta по сырому телу запроса.

    Без этой проверки адрес вебхука открыт всему интернету: кто угодно
    сможет слать выдуманные сообщения от имени клиентов.
    """
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


async def _handle_message(app: FastAPI, sender_id: str, text: str) -> None:
    config = app.state.config
    reply = await build_reply(text, config)
    sent = await app.state.graph.send_text(sender_id, reply)
    if not sent:
        logger.error("Ответ клиенту %s не доставлен", sender_id)
    await notify_manager(config, sender_id, text)


def _iter_messages(payload: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Достаёт (mid, sender_id, text) из того, что прислала Meta."""
    found: list[tuple[str, str, str]] = []
    for entry in payload.get("entry", []):
        for event in entry.get("messaging", []):
            message = event.get("message") or {}
            # is_echo — это наш собственный ответ, вернувшийся вебхуком.
            # Без этой проверки бот начнёт отвечать сам себе по кругу.
            if message.get("is_echo"):
                continue
            text = (message.get("text") or "").strip()
            mid = message.get("mid") or ""
            sender_id = (event.get("sender") or {}).get("id") or ""
            if text and mid and sender_id:
                found.append((mid, sender_id, text))
    return found


@app.post("/webhook")
async def receive(request: Request, background: BackgroundTasks) -> Response:
    config = request.app.state.config
    body = await request.body()

    if not _signature_ok(config.app_secret, body, request.headers.get("x-hub-signature-256")):
        logger.warning("Отклонён запрос с неверной подписью")
        return Response(content="forbidden", status_code=403)

    payload = await request.json()
    if payload.get("object") != "instagram":
        return Response(content="ok", media_type="text/plain")

    for mid, sender_id, text in _iter_messages(payload):
        if _already_handled(mid):
            continue
        # Отвечаем фоном: Meta ждёт 200 быстро, а Claude думает секунды.
        background.add_task(_handle_message, request.app, sender_id, text)

    return Response(content="ok", media_type="text/plain")
