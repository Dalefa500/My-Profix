"""Как бот придумывает ответ.

Два режима. Если в .env задан AISA_API_KEY или ANTHROPIC_API_KEY — отвечает
Claude, живым текстом, с каталогом в системном промпте. Если ключа нет — работают
правила по ключевым словам: беднее, но не требует ни ключа, ни денег и
никогда не выдумывает того, чего нет в каталоге.

В обоих режимах действует одно правило: про цены, сроки и наличие бот не
угадывает, а зовёт менеджера. Ошибка в цене в переписке дороже паузы.
"""

from __future__ import annotations

import logging

from .catalog import catalog_text, find_products
from .config import InstagramConfig

logger = logging.getLogger(__name__)

MAX_REPLY_TOKENS = 1000

SYSTEM_PROMPT = """Ты — консультант компании PowerMix в Instagram Direct.
PowerMix производит сухие строительные смеси в Таджикистане.

Каталог продукции — единственный источник правды о товарах:
{catalog}

Правила:
- Отвечай коротко, 1-3 предложения. Это переписка в директе, не статья.
- Пиши на языке клиента. Пишет по-русски — отвечай по-русски, на таджикском
  — на таджикском.
- Про цену, наличие, сроки доставки и объём скидки ты НЕ ЗНАЕШЬ. Никогда не
  называй и не прикидывай цифры. Скажи, что уточнит менеджер{handoff}.
- Не выдумывай товары, которых нет в каталоге. Нет подходящего — так и скажи
  и предложи связаться с менеджером.
- Не обсуждай ничего, кроме продукции PowerMix и работы с ней. На посторонние
  вопросы вежливо возвращай к теме.
- Без формальных приветствий вроде «Здравствуйте, уважаемый клиент» —
  пиши по-человечески.
"""

GREETING_WORDS = ("привет", "салом", "assalom", "здравств", "hello", "hi ", "ассалом")
PRICE_WORDS = ("цена", "цену", "сколько стоит", "стоимость", "прайс", "нарх", "почём", "почем")
DELIVERY_WORDS = ("доставк", "привез", "привоз", "самовывоз", "отгруз")
CONTACT_WORDS = ("телефон", "номер", "связаться", "менеджер", "позвонить", "whatsapp")


def _handoff_clause(config: InstagramConfig) -> str:
    return f" по телефону {config.handoff_phone}" if config.handoff_phone else ""


def rule_based_reply(text: str, config: InstagramConfig) -> str:
    """Ответ без Claude — на ключевых словах."""
    lowered = text.lower().strip()
    handoff = _handoff_clause(config)

    if any(word in lowered for word in PRICE_WORDS):
        return (
            "Цены уточняет менеджер — они зависят от объёма и условий доставки."
            f" Он свяжется с вами{handoff}."
        )

    if any(word in lowered for word in DELIVERY_WORDS):
        return f"По доставке и самовывозу ответит менеджер{handoff} — он напишет вам здесь же."

    if any(word in lowered for word in CONTACT_WORDS):
        return (
            f"Менеджер свяжется с вами{handoff}."
            if handoff
            else "Передал ваше сообщение менеджеру — он ответит здесь в ближайшее время."
        )

    matched = find_products(lowered)
    if matched:
        lines = [f"{p.name} — {p.description}" for p in matched[:3]]
        return "\n".join(lines) + "\n\nПо цене и наличию ответит менеджер."

    if any(word in lowered for word in GREETING_WORDS):
        return (
            "Здравствуйте! PowerMix — сухие строительные смеси: плиточные клеи, "
            "штукатурки, шпаклёвки, наливные полы и стяжки. Что вас интересует?"
        )

    return (
        "Передал ваш вопрос менеджеру — он ответит здесь в ближайшее время. "
        "А пока подскажите, что именно нужно: клей для плитки, штукатурка, "
        "шпаклёвка или наливной пол?"
    )


async def claude_reply(text: str, config: InstagramConfig) -> str | None:
    """Ответ через Claude. None — если что-то пошло не так, тогда падаем на правила."""
    try:
        from anthropic import AsyncAnthropic, omit
    except ImportError:
        logger.warning("Пакет anthropic не установлен — отвечаю по правилам")
        return None

    if config.uses_aisa:
        # AIsa ждёт ключ как Bearer. X-Api-Key выключаем явно: иначе SDK
        # сам подхватит ANTHROPIC_API_KEY из окружения и отправит ключ
        # Anthropic на чужой сервер.
        client = AsyncAnthropic(
            base_url=config.aisa_base_url,
            auth_token=config.aisa_key,
            default_headers={"X-Api-Key": omit},
        )
    else:
        client = AsyncAnthropic(api_key=config.anthropic_key)
    system = SYSTEM_PROMPT.format(catalog=catalog_text(), handoff=_handoff_clause(config))

    try:
        response = await client.messages.create(
            model=config.model,
            max_tokens=MAX_REPLY_TOKENS,
            # Мышление оставляем включённым (на Opus 5 оно по умолчанию), но
            # на минимальном усилии: вопросы в директе простые, а выключать
            # мышление на этой модели чревато артефактами в тексте ответа.
            # Через extra_body: закреплённый anthropic==0.69.0 ещё не знает
            # параметр output_config и падает с TypeError до отправки.
            extra_body={"output_config": {"effort": "low"}},
            system=system,
            messages=[{"role": "user", "content": text}],
        )
    except Exception:
        logger.exception("Claude не ответил — падаю на правила")
        return None
    finally:
        await client.close()

    if response.stop_reason == "refusal":
        logger.warning("Claude отказался отвечать на сообщение из директа")
        return None

    parts = [block.text for block in response.content if block.type == "text"]
    reply = "\n".join(part.strip() for part in parts if part.strip())
    return reply or None


async def build_reply(text: str, config: InstagramConfig) -> str:
    if config.uses_claude:
        reply = await claude_reply(text, config)
        if reply:
            return reply
    return rule_based_reply(text, config)
