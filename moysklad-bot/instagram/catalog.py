"""Каталог PowerMix — то же, что на сайте powermix-site/index.html.

Цены здесь сознательно не указаны: они меняются, а ошибиться в цене в
переписке с клиентом дороже, чем попросить его связаться с менеджером.
Когда цены зафиксируются, добавьте поле `price` и упомяните его в
SYSTEM_PROMPT в brain.py.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    name: str
    category: str
    description: str
    keywords: tuple[str, ...]


PRODUCTS: tuple[Product, ...] = (
    Product(
        "PowerMix Keramik",
        "Плиточный клей",
        "Плиточный клей для керамогранита и плитки, внутренние и наружные работы.",
        ("керамик", "керамогранит", "плитка", "плиточный клей", "кафель"),
    ),
    Product(
        "PowerMix Universal",
        "Плиточный клей",
        "Универсальный плиточный клей повышенной эластичности.",
        ("универсал", "эластичный", "универсальный клей"),
    ),
    Product(
        "PowerMix Gips",
        "Штукатурка",
        "Гипсовая штукатурка для машинного и ручного нанесения.",
        ("гипс", "гипсовая", "штукатурка гипс", "машинное нанесение"),
    ),
    Product(
        "PowerMix Fasad",
        "Штукатурка",
        "Цементная фасадная штукатурка, устойчива к перепадам температур.",
        ("фасад", "фасадная", "наружная штукатурка", "цементная штукатурка"),
    ),
    Product(
        "PowerMix Finish",
        "Шпаклёвка",
        "Финишная шпаклёвка для идеально гладких поверхностей под окраску.",
        ("финиш", "финишная", "под покраску", "шпаклевка финиш"),
    ),
    Product(
        "PowerMix Start",
        "Шпаклёвка",
        "Стартовая шпаклёвка для выравнивания стен и потолков.",
        ("старт", "стартовая", "выравнивание", "шпаклевка старт"),
    ),
    Product(
        "PowerMix Floor",
        "Пол",
        "Самовыравнивающийся наливной пол для финишных покрытий.",
        ("наливной", "наливной пол", "самовыравнивающийся", "флор", "floor"),
    ),
    Product(
        "PowerMix Stroy",
        "Пол",
        "Цементно-песчаная стяжка для полов с высокой нагрузкой.",
        ("стяжка", "строй", "цементно-песчаная", "пескобетон"),
    ),
)


def catalog_text() -> str:
    """Каталог одним блоком — уходит в системный промпт Claude."""
    lines = []
    for product in PRODUCTS:
        lines.append(f"- {product.name} ({product.category}): {product.description}")
    return "\n".join(lines)


def find_products(text: str) -> list[Product]:
    """Грубый поиск по ключевым словам — для режима без Claude."""
    lowered = text.lower()
    return [p for p in PRODUCTS if any(kw in lowered for kw in p.keywords)]
