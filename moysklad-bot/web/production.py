"""Цех: техкарты и замесы.

В МойСкладе техкарт нет, поэтому рецептуры живут здесь: на замес марки —
сколько какого сырья и сколько мешков выходит. Цены сырья берутся из
себестоимости в МойСкладе, поэтому стоимость мешка всегда по текущим
закупкам.

Замес отмечает мастер (он же бухгалтер): марка, сколько замесов, в норме
ли качество, и если поправлял — какую химию и сколько добавил. Так видно
настоящую себестоимость с учётом доливок, какие марки приходится
поправлять чаще и сколько химии уходит сверх рецепта.

Сырьё в МойСкладе пока не списывается: как у завода оформляется выпуск,
ещё не решено, и двойное списание хуже, чем никакого.
"""

from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from bot.moysklad import BASE_URL, MoySkladClient, MoySkladError
from web import store
from web.access import Person, allow, audit, client_ip, require_can, require_person

router = APIRouter()
editor = require_can("production_edit")

CARDS_FILE = "techcards.json"
BATCHES_FILE = "batches.jsonl"
CATALOG_TTL = 300


def _key(href: str) -> str:
    return href.split("?")[0]


async def _catalog(request: Request) -> list[dict]:
    """Товары и сырьё с себестоимостью. Отчёт по остаткам тяжёлый —
    держим его пять минут, а не тянем на каждое нажатие."""
    cached = getattr(request.app.state, "catalog", None)
    if cached and time.monotonic() - cached[0] < CATALOG_TTL:
        return cached[1]
    moysklad: MoySkladClient = request.app.state.moysklad
    try:
        rows = await moysklad.get_stock_report()
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    items = [
        {"href": _key(r["href"]), "name": r["name"], "uom": r["uom"], "cost": r.get("cost", 0.0)}
        for r in rows
        if r.get("href")
    ]
    request.app.state.catalog = (time.monotonic(), items)
    return items


def _cards() -> list[dict]:
    return [c for c in store.read_json(CARDS_FILE, {"cards": []}).get("cards", [])]


def _priced(card: dict, prices: dict[str, float]) -> dict:
    """Техкарта со стоимостью: каждой строки, замеса и мешка."""
    materials = []
    total = 0.0
    missing = 0
    for m in card.get("materials", []):
        cost = prices.get(_key(m["href"]))
        if not cost:
            missing += 1
        line = (cost or 0.0) * m["qty"]
        total += line
        materials.append({**m, "cost": cost or 0.0, "line": line})
    bags = card.get("bags") or 1
    return {
        **card,
        "materials": materials,
        "costPerBatch": total,
        "costPerBag": total / bags,
        "missingPrices": missing,
    }


def _batches() -> tuple[list[dict], set[str]]:
    batches, cancelled = [], set()
    for entry in store.read_lines(BATCHES_FILE):
        if entry.get("cancel"):
            cancelled.add(entry["cancel"])
        elif entry.get("id"):
            batches.append(entry)
    return batches, cancelled


@router.get("/api/catalog")
async def catalog(request: Request, q: str = "", _me: Person = Depends(editor)) -> dict:
    needle = q.strip().casefold()
    items = await _catalog(request)
    found = [i for i in items if needle in i["name"].casefold()] if needle else items
    return {"items": found[:25]}


@router.get("/api/production", dependencies=allow("production"))
async def production(
    request: Request, days: int = Query(30, ge=1, le=400), me: Person = Depends(require_person)
) -> dict:
    prices = {i["href"]: i["cost"] for i in await _catalog(request)}
    cards = [c for c in _cards() if not c.get("archived")]
    priced = [_priced(c, prices) for c in cards]

    since = (datetime.now() - timedelta(days=days)).date().isoformat()
    today = datetime.now().date().isoformat()
    batches, cancelled = _batches()
    live = [b for b in batches if b["t"][:10] >= since and b["id"] not in cancelled]

    by_card: dict[str, dict] = {}
    for b in live:
        row = by_card.setdefault(
            b["cardId"], {"cardId": b["cardId"], "name": b["cardName"], "bags": 0, "batches": 0, "corrected": 0}
        )
        row["bags"] += b["bags"]
        row["batches"] += b["count"]
        # Одна запись может означать несколько замесов подряд — считаем замесы
        row["corrected"] += 0 if b["ok"] else b["count"]

    recent = []
    for b in sorted(
        (b for b in batches if b["t"][:10] >= since), key=lambda b: b["t"], reverse=True
    )[:40]:
        recent.append(
            {
                **b,
                "cancelled": b["id"] in cancelled,
                "cancellable": b["by"] == me.id and b["t"].startswith(today) and b["id"] not in cancelled,
            }
        )

    return {
        "totals": {
            "records": len(live),
            "batches": sum(b["count"] for b in live),
            "bags": sum(b["bags"] for b in live),
            "kg": sum(b["kg"] for b in live),
            "corrected": sum(b["count"] for b in live if not b["ok"]),
            "extraCost": sum(b.get("extraCost", 0.0) for b in live),
        },
        "byCard": sorted(by_card.values(), key=lambda r: -r["bags"]),
        "recent": recent,
        "cards": sorted(priced, key=lambda c: c["name"]),
        "canEdit": me.can("production_edit"),
    }


# --- техкарты -------------------------------------------------------------


class Material(BaseModel):
    href: str
    name: str = Field(max_length=120)
    uom: str = Field("", max_length=20)
    qty: float = Field(gt=0, le=100_000)


def _check_href(href: str) -> str:
    # Ссылка приходит с телефона — принимаем только товар из МойСклада
    if not href.startswith(f"{BASE_URL}/entity/"):
        raise HTTPException(status_code=400, detail="Сырьё выберите из списка")
    return _key(href)


class TechCard(BaseModel):
    id: str = ""
    name: str = Field(min_length=2, max_length=80)
    productHref: str = ""
    bags: int = Field(ge=1, le=1000)
    bagKg: float = Field(25, gt=0, le=100)
    materials: list[Material] = Field(min_length=1, max_length=30)
    note: str = Field("", max_length=300)


@router.post("/api/techcards")
async def save_card(payload: TechCard, request: Request, me: Person = Depends(editor)) -> dict:
    data = store.read_json(CARDS_FILE, {"cards": []})
    cards = data.get("cards", [])
    card = {
        "id": payload.id or f"tc_{secrets.token_hex(4)}",
        "name": payload.name.strip(),
        "productHref": _check_href(payload.productHref) if payload.productHref else "",
        "bags": payload.bags,
        "bagKg": payload.bagKg,
        "materials": [
            {"href": _check_href(m.href), "name": m.name.strip(), "uom": m.uom, "qty": m.qty}
            for m in payload.materials
        ],
        "note": payload.note.strip(),
        "updated": store.now(),
        "updatedBy": me.name,
    }
    existing = next((i for i, c in enumerate(cards) if c["id"] == card["id"]), None)
    if payload.id and existing is None:
        raise HTTPException(status_code=404, detail="Техкарта не найдена")
    if existing is None:
        cards.append(card)
    else:
        cards[existing] = card
    store.write_json(CARDS_FILE, {"cards": cards})
    audit("techcard_saved", me, client_ip(request), card["name"])
    return {"ok": True, "id": card["id"]}


@router.post("/api/techcards/{card_id}/archive")
async def archive_card(card_id: str, request: Request, me: Person = Depends(editor)) -> dict:
    data = store.read_json(CARDS_FILE, {"cards": []})
    for card in data.get("cards", []):
        if card["id"] == card_id:
            card["archived"] = True
            store.write_json(CARDS_FILE, data)
            audit("techcard_archived", me, client_ip(request), card["name"])
            return {"ok": True}
    raise HTTPException(status_code=404, detail="Техкарта не найдена")


# --- замесы ---------------------------------------------------------------


class Addition(BaseModel):
    href: str
    name: str = Field(max_length=120)
    uom: str = Field("", max_length=20)
    qty: float = Field(gt=0, le=10_000)


class Batch(BaseModel):
    cardId: str
    count: int = Field(ge=1, le=100)
    ok: bool
    additions: list[Addition] = Field(default_factory=list, max_length=10)
    note: str = Field("", max_length=300)


@router.post("/api/batches")
async def add_batch(payload: Batch, request: Request, me: Person = Depends(editor)) -> dict:
    card = next((c for c in _cards() if c["id"] == payload.cardId and not c.get("archived")), None)
    if card is None:
        raise HTTPException(status_code=404, detail="Техкарта не найдена")
    if not payload.ok and not payload.additions and not payload.note.strip():
        raise HTTPException(status_code=400, detail="Что поправили? Укажите добавку или напишите")

    prices = {i["href"]: i["cost"] for i in await _catalog(request)}
    additions = []
    extra = 0.0
    for a in payload.additions:
        href = _check_href(a.href)
        cost = prices.get(href, 0.0)
        extra += cost * a.qty
        additions.append({"href": href, "name": a.name.strip(), "uom": a.uom, "qty": a.qty, "cost": cost})

    bags = card["bags"] * payload.count
    base_cost = _priced(card, prices)["costPerBatch"] * payload.count
    entry = {
        "id": f"b_{secrets.token_hex(5)}",
        "t": store.now(),
        "by": me.id,
        "name": me.name,
        "cardId": card["id"],
        "cardName": card["name"],
        "count": payload.count,
        "bags": bags,
        "kg": bags * card.get("bagKg", 25),
        "ok": payload.ok,
        "additions": additions,
        "extraCost": extra,
        "baseCost": base_cost,
        "note": payload.note.strip(),
    }
    store.append(BATCHES_FILE, entry)
    status = "в норме" if payload.ok else "поправлен: " + ", ".join(
        f"{a['name']} {a['qty']:g} {a['uom']}".strip() for a in additions
    )
    audit("batch", me, client_ip(request), f"{card['name']} × {payload.count} · {status}")
    return {"ok": True, "id": entry["id"]}


class CancelBatch(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


@router.post("/api/batches/{batch_id}/cancel")
async def cancel_batch(
    batch_id: str, payload: CancelBatch, request: Request, me: Person = Depends(editor)
) -> dict:
    batches, cancelled = _batches()
    batch = next((b for b in batches if b["id"] == batch_id), None)
    today = datetime.now().date().isoformat()
    if not batch or batch["by"] != me.id or not batch["t"].startswith(today) or batch_id in cancelled:
        raise HTTPException(status_code=403, detail="Этот замес отменить нельзя")
    store.append(BATCHES_FILE, {"cancel": batch_id, "by": me.id, "t": store.now(), "reason": payload.reason})
    audit("batch_cancel", me, client_ip(request), f"{batch['cardName']} × {batch['count']} · {payload.reason}")
    return {"ok": True}
