"""Короткие сообщения учредителю в Telegram — через того же бота, что
присылает ежедневный отчёт. Если бот не настроен или Telegram не ответил,
приложение работает дальше: запись в журнале остаётся в любом случае.
"""

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)


def _owner_ids() -> list[str]:
    return [c.strip() for c in os.environ.get("OWNER_IDS", "").split(",") if c.strip()]


async def notify_owners(text: str) -> None:
    token = os.environ.get("BOT_TOKEN", "").strip()
    chat_ids = _owner_ids()
    if not token or not chat_ids:
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        async with httpx.AsyncClient(
            timeout=10,
            # Как и у МойСклада: только IPv4, без попытки через IPv6
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0"),
        ) as http:
            for chat_id in chat_ids:
                await http.post(url, json={"chat_id": chat_id, "text": text})
    except httpx.HTTPError as exc:
        logger.warning("Не удалось отправить уведомление в Telegram: %s", exc)
