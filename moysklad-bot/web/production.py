"""Цех: техкарты и замесы.

В МойСкладе техкарт нет, поэтому рецептуры живут здесь: на замес марки —
сколько какого сырья и сколько мешков выходит. Цены сырья берутся из
себестоимости в МойСкладе, поэтому стоимость мешка всегда по текущим
закупкам.

Замес отмечает мастер (он же бухгалтер): марка, сколько замесов, в норме
ли качество, и если поправлял — какую химию и сколько добавил. Так видно
настоящую себестоимость с учётом доливок, какие марки приходится
поправлять чаще и сколько химии уходит сверх рецепта.

Выпуск на заводе оформляется оприходованием мешков и списанием сырья.
Когда учредитель включает «Списание в МойСкладе», каждый замес сам
создаёт оба документа: списание сырья по техкарте (с доливками) и
оприходование мешков по себестоимости замеса. Выключено по умолчанию:
пока бухгалтер вносит их вручную, автоматика задвоила бы списание.
Отмена замеса снимает оба документа с проведения, не удаляя их.
"""

from __future__ import annotations

import logging
import math
import secrets
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from bot.moysklad import BASE_URL, MoySkladClient, MoySkladError
from web import store
from web.access import Person, allow, audit, client_ip, require_can, require_manager, require_person

logger = logging.getLogger(__name__)
router = APIRouter()
editor = require_can("production_edit")

CARDS_FILE = "techcards.json"
BATCHES_FILE = "batches.jsonl"
SETTINGS_FILE = "settings.json"
CATALOG_TTL = 300

# Что цеху разрешено в МойСкладе: создать списание и оприходование и
# снять их с проведения при отмене замеса.
PRODUCTION_WRITE_ALLOW = (
    r"POST /entity/(loss|enter)",
    r"PUT /entity/(loss|enter)/[0-9a-f-]{36}",
)


def _settings() -> dict:
    return store.read_json(SETTINGS_FILE, {})


def write_off_enabled() -> bool:
    return bool(_settings().get("productionWriteOff"))


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
    ledger, cancelled = _ledger()
    batches = list(ledger.values())
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
        own_today = b["by"] == me.id and b["t"].startswith(today) and b["id"] not in cancelled
        recent.append(
            {
                **b,
                "recipe": _recipe_of(b),
                "cancelled": b["id"] in cancelled,
                # Свой сегодняшний замес можно исправить или отменить
                "cancellable": own_today,
                "editable": own_today,
            }
        )

    return {
        "totals": {
            "records": len(live),
            "batches": sum(b["count"] for b in live),
            "bags": sum(b["bags"] for b in live),
            "kg": sum(b["kg"] for b in live),
            "corrected": sum(b["count"] for b in live if not b["ok"]),
            # Со знаком: химия сверх рецепта минус то, что положили меньше
            "extraCost": sum(b.get("extraCost", 0.0) for b in live),
        },
        "byCard": sorted(by_card.values(), key=lambda r: -r["bags"]),
        "recent": recent,
        "cards": sorted(priced, key=lambda c: c["name"]),
        "canEdit": me.can("production_edit"),
        "writeOff": write_off_enabled(),
        "canToggle": me.can_manage,
    }


class WriteOffSetting(BaseModel):
    writeOff: bool


@router.post("/api/production/settings")
async def production_settings(
    payload: WriteOffSetting, request: Request, me: Person = Depends(require_manager)
) -> dict:
    settings = _settings()
    settings.update(
        {"productionWriteOff": payload.writeOff, "changedBy": me.name, "changedAt": store.now()}
    )
    store.write_json(SETTINGS_FILE, settings)
    audit("writeoff_on" if payload.writeOff else "writeoff_off", me, client_ip(request))
    return {"ok": True, "writeOff": payload.writeOff}


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
    # Готовый мешок в МойСкладе — его оприходует замес
    productHref: str = ""
    productName: str = Field("", max_length=120)
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
        "productName": payload.productName.strip() if payload.productHref else "",
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
#
# Химии в замес кладут по-разному: то больше рецепта, то меньше. Поэтому
# замес хранит отклонения от техкарты со знаком: +0,5 кг — добавили,
# −0,3 кг — положили меньше. В тот же день мастер может свой замес
# исправить: отклонения, качество, заметку. Файл замесов только
# дописывается — исправление и отмена ложатся отдельными строками поверх
# исходной записи, так что история не теряется.

EPSILON = 1e-9


class Delta(BaseModel):
    href: str
    name: str = Field(max_length=120)
    uom: str = Field("", max_length=20)
    # Со знаком: плюс — добавили сверх техкарты, минус — положили меньше
    qty: float = Field(ge=-10_000, le=10_000)


class Batch(BaseModel):
    cardId: str
    count: int = Field(ge=1, le=100)
    ok: bool
    deltas: list[Delta] = Field(default_factory=list, max_length=20)
    note: str = Field("", max_length=300)


class Amend(BaseModel):
    ok: bool
    deltas: list[Delta] = Field(default_factory=list, max_length=20)
    note: str = Field("", max_length=300)


def _snapshot(card: dict) -> dict:
    """Рецепт на момент замеса. Техкарту потом могут поправить — прошлые
    замесы должны остаться такими, какими их замешали."""
    return {
        "recipe": [
            {"href": m["href"], "name": m["name"], "uom": m.get("uom", ""), "qty": m["qty"]}
            for m in card["materials"]
        ],
        "bagsPerBatch": card["bags"],
        "bagKg": card.get("bagKg", 25),
        "productHref": card.get("productHref", ""),
    }


def _ledger() -> tuple[dict[str, dict], set[str]]:
    """Замесы в том виде, в каком они сейчас: исходная запись плюс
    последнее исправление поверх, и набор отменённых."""
    batches: dict[str, dict] = {}
    cancelled: set[str] = set()
    for entry in store.read_lines(BATCHES_FILE):
        if entry.get("cancel"):
            cancelled.add(entry["cancel"])
        elif entry.get("amend"):
            base = batches.get(entry["amend"])
            if base is not None:
                for key in ("ok", "deltas", "extraCost", "note", "lossId", "enterId"):
                    if key in entry:
                        base[key] = entry[key]
                base["amendedAt"] = entry.get("t", "")
        elif entry.get("id"):
            # Записи до отклонений со знаком хранили только добавки
            if "deltas" not in entry:
                entry["deltas"] = entry.pop("additions", [])
            batches[entry["id"]] = entry
    return batches, cancelled


def _recipe_of(batch_or_card: dict) -> list[dict]:
    return batch_or_card.get("recipe") or batch_or_card.get("materials") or []


def _resolve_deltas(
    raw: list[Delta], recipe: list[dict], count: int, prices: dict[str, float]
) -> tuple[list[dict], float]:
    """Проверяет отклонения и сводит их по сырью. Убавить можно только то,
    что есть в техкарте, и не больше, чем положено по ней."""
    planned: dict[str, float] = {}
    for m in recipe:
        planned[_key(m["href"])] = planned.get(_key(m["href"]), 0.0) + m["qty"] * count

    merged: dict[str, dict] = {}
    for d in raw:
        if not math.isfinite(d.qty):
            raise HTTPException(status_code=400, detail="Неверное количество")
        href = _check_href(d.href)
        row = merged.setdefault(href, {"href": href, "name": d.name.strip(), "uom": d.uom, "qty": 0.0})
        row["qty"] += d.qty

    deltas: list[dict] = []
    extra = 0.0
    for href, row in merged.items():
        if abs(row["qty"]) < EPSILON:
            continue
        if row["qty"] < 0:
            if href not in planned:
                raise HTTPException(
                    status_code=400, detail=f"«{row['name']}» нет в техкарте — убавлять нечего"
                )
            if planned[href] + row["qty"] < -EPSILON:
                raise HTTPException(
                    status_code=400,
                    detail=f"«{row['name']}»: по техкарте {planned[href]:g} {row['uom']}, "
                    f"убавить больше нельзя",
                )
        cost = prices.get(href, 0.0)
        extra += cost * row["qty"]
        deltas.append({**row, "cost": cost})
    return deltas, extra


def _usage(recipe: list[dict], count: int, deltas: list[dict]) -> dict[str, float]:
    """Сколько сырья фактически ушло: техкарта × замесы ± отклонения."""
    used: dict[str, float] = {}
    for m in recipe:
        href = _key(m["href"])
        used[href] = used.get(href, 0.0) + m["qty"] * count
    for d in deltas:
        used[d["href"]] = used.get(d["href"], 0.0) + d["qty"]
    return {href: qty for href, qty in used.items() if qty > EPSILON}


def _describe_deltas(deltas: list[dict]) -> str:
    return ", ".join(f"{d['name']} {d['qty']:+g} {d['uom']}".strip() for d in deltas)


@router.post("/api/batches")
async def add_batch(payload: Batch, request: Request, me: Person = Depends(editor)) -> dict:
    card = next((c for c in _cards() if c["id"] == payload.cardId and not c.get("archived")), None)
    if card is None:
        raise HTTPException(status_code=404, detail="Техкарта не найдена")
    if not payload.ok and not payload.deltas and not payload.note.strip():
        raise HTTPException(status_code=400, detail="Что поправили? Укажите химию или напишите")

    prices = {i["href"]: i["cost"] for i in await _catalog(request)}
    snapshot = _snapshot(card)
    deltas, extra = _resolve_deltas(payload.deltas, snapshot["recipe"], payload.count, prices)
    bags = card["bags"] * payload.count
    base_cost = _priced(card, prices)["costPerBatch"] * payload.count

    documents: dict[str, str] = {}
    if write_off_enabled():
        documents = await _post_to_moysklad(
            request, card["name"], snapshot, payload.count, deltas, bags, base_cost + extra, me
        )

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
        "deltas": deltas,
        "extraCost": extra,
        "baseCost": base_cost,
        "note": payload.note.strip(),
        **snapshot,
        **documents,
    }
    store.append(BATCHES_FILE, entry)
    status = "в норме" if payload.ok else "поправлен"
    changes = f" · {_describe_deltas(deltas)}" if deltas else ""
    posted = " · в МойСкладе" if documents else ""
    audit("batch", me, client_ip(request), f"{card['name']} × {payload.count} · {status}{changes}{posted}")
    return {"ok": True, "id": entry["id"], "posted": bool(documents)}


def _own_today(batch_id: str, me: Person, action: str) -> dict:
    batches, cancelled = _ledger()
    batch = batches.get(batch_id)
    today = datetime.now().date().isoformat()
    # Только свой, только сегодняшний и не отменённый: вчерашний день
    # закрыт, чужие замесы — не ваши.
    if not batch or batch["by"] != me.id or not batch["t"].startswith(today) or batch_id in cancelled:
        raise HTTPException(status_code=403, detail=f"Этот замес {action} нельзя")
    return batch


@router.post("/api/batches/{batch_id}/amend")
async def amend_batch(
    batch_id: str, payload: Amend, request: Request, me: Person = Depends(editor)
) -> dict:
    batch = _own_today(batch_id, me, "изменить")
    if not payload.ok and not payload.deltas and not payload.note.strip():
        raise HTTPException(status_code=400, detail="Что поправили? Укажите химию или напишите")

    recipe = _recipe_of(batch)
    if not recipe:
        # Старая запись без рецепта — берём техкарту, если она ещё есть
        card = next((c for c in _cards() if c["id"] == batch["cardId"]), None)
        if card is None:
            raise HTTPException(status_code=409, detail="Техкарта этого замеса не найдена")
        recipe = card["materials"]

    prices = {i["href"]: i["cost"] for i in await _catalog(request)}
    deltas, extra = _resolve_deltas(payload.deltas, recipe, batch["count"], prices)

    documents: dict[str, str] = {}
    if batch.get("lossId") or batch.get("enterId"):
        # Замес уже в МойСкладе — меняем его документы на исправленные
        snapshot = {
            "recipe": recipe,
            "productHref": batch.get("productHref") or "",
        }
        if not snapshot["productHref"]:
            card = next((c for c in _cards() if c["id"] == batch["cardId"]), None)
            snapshot["productHref"] = (card or {}).get("productHref", "")
        documents = await _replace_in_moysklad(
            request, batch, snapshot, deltas, batch.get("baseCost", 0.0) + extra, me
        )

    entry = {
        "amend": batch_id,
        "t": store.now(),
        "by": me.id,
        "name": me.name,
        "ok": payload.ok,
        "deltas": deltas,
        "extraCost": extra,
        "note": payload.note.strip(),
        **documents,
    }
    store.append(BATCHES_FILE, entry)
    changes = _describe_deltas(deltas) or "как в техкарте"
    posted = " · в МойСкладе заменено" if documents else ""
    audit("batch_amend", me, client_ip(request), f"{batch['cardName']} × {batch['count']} · {changes}{posted}")
    return {"ok": True, "posted": bool(documents)}


async def _post_to_moysklad(
    request: Request,
    card_name: str,
    snapshot: dict,
    count: int,
    deltas: list[dict],
    bags: int,
    cost: float,
    me: Person,
    suffix: str = "",
) -> dict[str, str]:
    """Списание сырья и оприходование мешков за один замес. Сначала
    списание: если оприходование потом не пройдёт, списание снимается
    с проведения — половинчатого выпуска в учёте не остаётся."""
    if not snapshot.get("productHref"):
        raise HTTPException(
            status_code=400,
            detail="В техкарте не выбран готовый мешок из МойСклада — откройте техкарту и укажите его",
        )
    used = _usage(snapshot["recipe"], count, deltas)

    moysklad: MoySkladClient = request.app.state.moysklad
    description = f"Замес: {card_name} × {count} — {me.name} (приложение Profix){suffix}"
    try:
        loss = await moysklad.create_stock_document(
            "loss", [{"href": href, "quantity": qty} for href, qty in used.items()], description
        )
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=f"Списание в МойСклад не прошло: {exc}")
    try:
        enter = await moysklad.create_stock_document(
            "enter",
            [{"href": snapshot["productHref"], "quantity": bags, "price": max(cost, 0.0) / bags}],
            description,
        )
    except MoySkladError as exc:
        try:
            await moysklad.unpost("loss", loss["id"], "ОТМЕНЕНО: оприходование не прошло")
        except MoySkladError:
            logger.error("Не удалось снять списание %s после сбоя оприходования", loss.get("id"))
        raise HTTPException(status_code=502, detail=f"Оприходование в МойСклад не прошло: {exc}")
    return {"lossId": loss.get("id", ""), "enterId": enter.get("id", "")}


async def _replace_in_moysklad(
    request: Request, batch: dict, snapshot: dict, deltas: list[dict], cost: float, me: Person
) -> dict[str, str]:
    """Исправленный замес в МойСкладе: новые списание и оприходование,
    старые — снять с проведения с пометкой. Если по дороге что-то не
    прошло, возвращаем как было: новые снимаем, старые проводим обратно."""
    moysklad: MoySkladClient = request.app.state.moysklad
    stamp = f"{datetime.now():%d.%m %H:%M}"
    new = await _post_to_moysklad(
        request, batch["cardName"], snapshot, batch["count"], deltas, batch["bags"], cost, me,
        suffix=f" · исправлен {stamp}",
    )
    note = f"ИЗМЕНЕНО {stamp} — {me.name}: заменён исправленным документом"
    unposted: list[tuple[str, str]] = []
    try:
        for entity, key in (("enter", "enterId"), ("loss", "lossId")):
            if batch.get(key):
                await moysklad.unpost(entity, batch[key], note)
                unposted.append((entity, batch[key]))
    except MoySkladError as exc:
        for entity, doc_id in unposted:
            try:
                await moysklad.repost(entity, doc_id)
            except MoySkladError:
                logger.error("Не удалось провести обратно %s %s", entity, doc_id)
        for entity, key in (("enter", "enterId"), ("loss", "lossId")):
            try:
                await moysklad.unpost(entity, new[key], "ОТМЕНЕНО: исправление не прошло")
            except MoySkladError:
                logger.error("Не удалось снять новый %s %s", entity, new[key])
        raise HTTPException(status_code=502, detail=f"МойСклад не принял исправление: {exc}")
    return new


class CancelBatch(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


@router.post("/api/batches/{batch_id}/cancel")
async def cancel_batch(
    batch_id: str, payload: CancelBatch, request: Request, me: Person = Depends(editor)
) -> dict:
    batch = _own_today(batch_id, me, "отменить")
    # Документы в МойСкладе снимаем с проведения раньше, чем отмечаем
    # отмену у себя: не вышло там — замес остаётся действующим и здесь.
    note = f"ОТМЕНЕНО {datetime.now():%d.%m %H:%M} — {me.name}: {payload.reason}"
    try:
        for entity, key in (("enter", "enterId"), ("loss", "lossId")):
            if batch.get(key):
                await request.app.state.moysklad.unpost(entity, batch[key], note)
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=f"МойСклад не принял отмену: {exc}")
    store.append(BATCHES_FILE, {"cancel": batch_id, "by": me.id, "t": store.now(), "reason": payload.reason})
    audit("batch_cancel", me, client_ip(request), f"{batch['cardName']} × {batch['count']} · {payload.reason}")
    return {"ok": True}
