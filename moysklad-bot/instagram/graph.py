"""Отправка сообщений обратно в Instagram Direct через Graph API."""

from __future__ import annotations

import logging

import httpx

from .config import InstagramConfig

logger = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(20.0)


class GraphClient:
    def __init__(self, config: InstagramConfig) -> None:
        self._config = config
        self._http = httpx.AsyncClient(timeout=TIMEOUT)

    async def close(self) -> None:
        await self._http.aclose()

    async def send_text(self, recipient_id: str, text: str) -> bool:
        """True — если Meta приняла сообщение.

        Отвечать можно только в течение 24 часов после сообщения клиента:
        вне этого окна Meta вернёт ошибку, и это не поломка, а правило
        платформы — такие диалоги должен дожимать живой менеджер.
        """
        payload = {
            "recipient": {"id": recipient_id},
            "message": {"text": text[:1000]},
        }
        try:
            response = await self._http.post(
                self._config.send_url,
                params={"access_token": self._config.access_token},
                json=payload,
            )
        except httpx.HTTPError:
            logger.exception("Не смог достучаться до Graph API")
            return False

        if response.status_code >= 400:
            # Тело ответа Meta — единственное место, где написана настоящая
            # причина отказа: истёкший токен, нет прав, закрыто окно 24 часов.
            logger.error(
                "Graph API отказал: %s %s", response.status_code, response.text[:500]
            )
            return False

        return True


async def notify_manager(config: InstagramConfig, sender_id: str, text: str) -> None:
    """Дублируем входящее сообщение менеджеру в Telegram.

    Бот отвечает сам, но живой человек должен видеть, что клиент написал —
    иначе заявка потеряется между автоответом и реальной продажей.
    """
    if not (config.notify_bot_token and config.notify_chat_ids):
        return

    url = f"https://api.telegram.org/bot{config.notify_bot_token}/sendMessage"
    message = f"📩 Instagram Direct\nОт: {sender_id}\n\n{text[:800]}"

    async with httpx.AsyncClient(timeout=TIMEOUT) as http:
        for chat_id in config.notify_chat_ids:
            try:
                await http.post(url, json={"chat_id": chat_id, "text": message})
            except httpx.HTTPError:
                logger.exception("Не смог уведомить менеджера %s", chat_id)
