"""Настройки бота Instagram Direct.

Сознательно НЕ импортирует ничего из bot/ и web/: у этого сервиса не
должно быть ни токена МойСклад, ни доступа к кассе. В директ пишут
посторонние люди, поэтому единственное, что здесь есть — каталог
продукции и телефон менеджера.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class InstagramConfig:
    verify_token: str
    app_secret: str
    access_token: str
    page_id: str
    graph_base: str
    api_version: str
    model: str
    anthropic_key: str
    handoff_phone: str
    notify_bot_token: str
    notify_chat_ids: tuple[int, ...]

    @property
    def send_url(self) -> str:
        # Instagram Login отправляет через graph.instagram.com/…/me/messages,
        # Facebook Login — через graph.facebook.com/…/<page_id>/messages.
        # Поддерживаем оба: путь берётся из IG_PAGE_ID, если он задан.
        node = self.page_id or "me"
        return f"{self.graph_base}/{self.api_version}/{node}/messages"

    @property
    def uses_claude(self) -> bool:
        return bool(self.anthropic_key)


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} не задан в .env — бот Instagram не запустится без него")
    return value


def _parse_ids(raw: str) -> tuple[int, ...]:
    return tuple(int(chunk.strip()) for chunk in raw.split(",") if chunk.strip())


def load_config() -> InstagramConfig:
    return InstagramConfig(
        verify_token=_required("IG_VERIFY_TOKEN"),
        app_secret=_required("IG_APP_SECRET"),
        access_token=_required("IG_ACCESS_TOKEN"),
        page_id=os.environ.get("IG_PAGE_ID", "").strip(),
        graph_base=os.environ.get("IG_GRAPH_BASE", "https://graph.instagram.com").rstrip("/"),
        api_version=os.environ.get("IG_API_VERSION", "v23.0"),
        model=os.environ.get("IG_MODEL", "claude-opus-5"),
        anthropic_key=os.environ.get("ANTHROPIC_API_KEY", "").strip(),
        handoff_phone=os.environ.get("IG_HANDOFF_PHONE", "").strip(),
        # Уведомления менеджеру шлём в тот же Telegram, где уже живёт
        # учётный бот — отдельного канала заводить не нужно.
        notify_bot_token=os.environ.get("BOT_TOKEN", "").strip(),
        notify_chat_ids=_parse_ids(os.environ.get("IG_NOTIFY_IDS", os.environ.get("OWNER_IDS", ""))),
    )
