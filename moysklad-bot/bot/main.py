from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import socket
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware, Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand, TelegramObject, Update

from .config import Config, load_config
from .handlers import routers
from .handlers.report import build_full_report_text, build_month_report_text
from .moysklad import MoySkladClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Ipv4OnlySession(AiohttpSession):
    """Some hosts hand containers a dual-stack DNS answer for
    api.telegram.org but no working outbound IPv6 route, so aiohttp's
    connector stalls trying the IPv6 candidate first. Forcing IPv4-only
    skips that dead end.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._connector_init["family"] = socket.AF_INET


class AccessControlMiddleware(BaseMiddleware):
    """Blocks anyone who isn't a configured owner or employee."""

    def __init__(self, allowed_ids: set[int]) -> None:
        self._allowed_ids = allowed_ids

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        user = data.get("event_from_user")
        if user is not None and user.id not in self._allowed_ids:
            logger.warning("Blocked access from unknown user_id=%s", user.id)
            if isinstance(event, Update) and event.message:
                await event.message.answer(
                    "Доступ к этому боту ограничен. Обратись к владельцу цеха, "
                    "чтобы добавить твой Telegram ID в список сотрудников."
                )
            return None
        return await handler(event, data)


def _seconds_until(hour: int, minute: int) -> float:
    now = dt.datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += dt.timedelta(days=1)
    return (target - now).total_seconds()


async def daily_report_loop(bot: Bot, moysklad: MoySkladClient, config: Config) -> None:
    """Pushes the full report (income + expense + balance) to owners and
    directors once a day, so nobody has to remember to type /balance.
    Regular employees are never included here — they only see the balance,
    and only when they ask for it via /balance.
    """
    try:
        hour_str, minute_str = config.daily_report_time.split(":")
        hour, minute = int(hour_str), int(minute_str)
    except ValueError:
        logger.warning(
            "Invalid DAILY_REPORT_TIME=%r, defaulting to 20:00", config.daily_report_time
        )
        hour, minute = 20, 0

    # CASH_REPORT: off — ничего не присылать (так попросил учредитель:
    # в Telegram только заявки и напоминания об оплатах), monthly — касса
    # за месяц в последний день месяца, daily — отчёт каждый день.
    schedule = os.environ.get("CASH_REPORT", "off").strip().lower()
    if schedule == "off":
        return

    while True:
        await asyncio.sleep(_seconds_until(hour, minute))
        today = dt.date.today()
        if schedule == "monthly" and (today + dt.timedelta(days=1)).month == today.month:
            continue
        try:
            if schedule == "monthly":
                text = await build_month_report_text(moysklad, today.year, today.month)
            else:
                text = await build_full_report_text(moysklad)
        except Exception:
            logger.exception("Failed to build scheduled daily report")
            continue
        for management_id in config.management_ids:
            try:
                await bot.send_message(management_id, text)
            except Exception:
                logger.exception("Failed to send daily report to user_id=%s", management_id)


async def main() -> None:
    config = load_config()
    bot = Bot(
        token=config.bot_token,
        session=Ipv4OnlySession(),
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    # Меню и команды бота учредитель попросил убрать: заявки из Instagram
    # и напоминания об оплатах шлют другие сервисы тем же ботом, а этот
    # процесс остаётся только ради отчёта по CASH_REPORT (по умолчанию выключен).
    # Вернуть меню: TELEGRAM_MENU=1.
    if os.environ.get("TELEGRAM_MENU", "0").strip() != "1":
        await bot.delete_my_commands()
        moysklad = MoySkladClient(config.moysklad_token)
        logger.info("Menu disabled; only the scheduled cash report runs")
        try:
            await daily_report_loop(bot, moysklad, config)
            await asyncio.Event().wait()  # CASH_REPORT=off: просто не выходим
        finally:
            await moysklad.close()
            await bot.session.close()
        return

    await bot.set_my_commands(
        [
            BotCommand(command="start", description="Открыть меню"),
            BotCommand(command="balance", description="Показать баланс/кассу"),
            BotCommand(command="report", description="Отчёт: день/месяц/полгода/год"),
            BotCommand(command="stock", description="Остатки на складе"),
            BotCommand(command="debts", description="Задолженность контрагентов"),
            BotCommand(command="counterparties", description="Расход по команде"),
        ]
    )
    dp = Dispatcher(storage=MemoryStorage())

    dp.update.outer_middleware(AccessControlMiddleware(config.allowed_ids))

    for router in routers:
        dp.include_router(router)

    moysklad = MoySkladClient(config.moysklad_token)

    logger.info(
        "Starting bot: %d owner(s), %d director(s), %d employee(s) allowed, "
        "daily report at %s",
        len(config.owner_ids),
        len(config.director_ids),
        len(config.employee_ids),
        config.daily_report_time,
    )

    daily_task = asyncio.create_task(daily_report_loop(bot, moysklad, config))

    try:
        await dp.start_polling(bot, moysklad=moysklad, config=config)
    finally:
        daily_task.cancel()
        await moysklad.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
