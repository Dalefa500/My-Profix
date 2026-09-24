"""Касса: экран кассира и то, что он вносит.

Кассир записывает приход и расход прямо в МойСклад кассовыми ордерами —
бухгалтерия видит их там же, где привыкла. Удалить операцию нельзя:
свою сегодняшнюю можно только отменить с причиной, документ при этом
остаётся в учёте непроведённым. В конце дня кассир закрывает смену —
вводит, сколько насчитал наличных, и расхождение с учётом сразу видно
учредителю.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from bot.moysklad import BASE_URL, MoySkladClient, MoySkladError, MoySkladUnreachable
from web import store
from web.access import Person, allow, audit, client_ip, require_can
from web.notify import notify_owners

logger = logging.getLogger(__name__)
router = APIRouter()

# Что приложению разрешено менять в МойСкладе: создать кассовый ордер и
# снять его с проведения. Всё остальное клиент отклонит сам.
CASH_WRITE_ALLOW = (
    r"POST /entity/(cashin|cashout)",
    r"PUT /entity/(cashin|cashout)/[0-9a-f-]{36}",
)

# Защита от лишнего нуля: крупнее этой суммы кассир провести не сможет
CASH_MAX_AMOUNT = float(os.environ.get("CASH_MAX_AMOUNT", "1000000"))
DEFAULT_AGENT_NAME = "Без контрагента"
REFS_TTL = 600

OPS_FILE = "cash_ops.jsonl"
SHIFTS_FILE = "shifts.jsonl"

cash_writer = require_can("cash_write")


def _money(value: float) -> str:
    return f"{value:,.0f}".replace(",", " ") + " с."


async def cash_balance(moysklad: MoySkladClient) -> float | None:
    """Остаток только по строкам-кассам отчёта «Остатки по счетам»:
    банковские счета кассиру не показываем. None — если отчёт недоступен
    или касс в нём не нашлось."""
    try:
        rows = await moysklad.get_account_balances()
    except MoySkladError:
        logger.info("Остаток кассы недоступен")
        return None
    cash_rows = [row for row in rows if "касс" in row["name"].lower()]
    return sum(row["balance"] for row in cash_rows) if cash_rows else None


def _app_ops() -> tuple[dict[str, dict], set[str]]:
    """Операции, внесённые через приложение, и отменённые из них."""
    created: dict[str, dict] = {}
    cancelled: set[str] = set()
    for entry in store.read_lines(OPS_FILE):
        if entry.get("cancel"):
            cancelled.add(entry["cancel"])
        elif entry.get("id"):
            created[entry["id"]] = entry
    return created, cancelled


@router.get("/api/cash", dependencies=allow("cash"))
async def cash(request: Request, me: Person = Depends(cash_writer)) -> dict:
    moysklad: MoySkladClient = request.app.state.moysklad
    try:
        operations = await moysklad.cash_today_operations()
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    balance = await cash_balance(moysklad)

    today = datetime.now().date().isoformat()
    created, cancelled = _app_ops()
    for op in operations:
        mine = created.get(op["id"])
        op["cancellable"] = bool(
            mine
            and mine.get("by") == me.id
            and mine.get("t", "").startswith(today)
            and op["applicable"]
            and op["id"] not in cancelled
        )

    live = [op for op in operations if op["applicable"]]
    shifts = [s for s in store.read_lines(SHIFTS_FILE) if s.get("t", "").startswith(today)]
    return {
        "balance": balance,
        "income": sum(op["sum"] for op in live if op["kind"] == "in"),
        "expense": sum(op["sum"] for op in live if op["kind"] == "out"),
        "operations": operations[:200],
        "shift": shifts[-1] if shifts else None,
    }


async def _expense_items(request: Request) -> list[dict]:
    cached = getattr(request.app.state, "expense_items", None)
    if cached and time.monotonic() - cached[0] < REFS_TTL:
        return cached[1]
    items = await request.app.state.moysklad.list_expense_items()
    request.app.state.expense_items = (time.monotonic(), items)
    return items


async def _default_agent(moysklad: MoySkladClient) -> dict | None:
    for row in await moysklad.search_counterparty(DEFAULT_AGENT_NAME, limit=5):
        if (row.get("name") or "").strip().lower() == DEFAULT_AGENT_NAME.lower():
            return {"href": row["meta"]["href"], "name": row["name"]}
    return None


@router.get("/api/cash/refs")
async def cash_refs(request: Request, _me: Person = Depends(cash_writer)) -> dict:
    try:
        items = await _expense_items(request)
        agent = await _default_agent(request.app.state.moysklad)
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"items": items, "defaultAgent": agent, "maxAmount": CASH_MAX_AMOUNT}


@router.get("/api/cash/agents")
async def cash_agents(request: Request, q: str = "", _me: Person = Depends(cash_writer)) -> dict:
    q = q.strip()
    if len(q) < 2:
        return {"agents": []}
    try:
        rows = await request.app.state.moysklad.search_counterparty(q[:60], limit=10)
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"agents": [{"href": r["meta"]["href"], "name": r.get("name", "?")} for r in rows]}


class CashOperation(BaseModel):
    kind: str
    amount: float
    agentHref: str = ""
    itemHref: str = ""
    comment: str = ""


@router.post("/api/cash/operation")
async def add_operation(
    payload: CashOperation, request: Request, me: Person = Depends(cash_writer)
) -> dict:
    moysklad: MoySkladClient = request.app.state.moysklad
    if payload.kind not in ("in", "out"):
        raise HTTPException(status_code=400, detail="Приход или расход?")
    amount = round(payload.amount, 2)
    if not 0 < amount <= CASH_MAX_AMOUNT:
        raise HTTPException(
            status_code=400, detail=f"Сумма должна быть больше нуля и не больше {_money(CASH_MAX_AMOUNT)}"
        )
    comment = payload.comment.strip()[:300]

    try:
        if payload.agentHref:
            # Ссылка приходит с телефона — пускаем только на контрагента
            if not payload.agentHref.startswith(f"{BASE_URL}/entity/counterparty/"):
                raise HTTPException(status_code=400, detail="Неизвестный контрагент")
            agent_href = payload.agentHref
        else:
            agent = await _default_agent(moysklad)
            if agent is None:
                raise HTTPException(status_code=400, detail="Выберите, от кого или кому")
            agent_href = agent["href"]

        item = None
        if payload.kind == "out":
            items = {i["href"]: i for i in await _expense_items(request)}
            item = items.get(payload.itemHref)
            if item is None:
                raise HTTPException(status_code=400, detail="Выберите статью расхода")

        description = "\n\n".join(filter(None, [comment, f"Внёс: {me.name} (приложение Profix)"]))
        try:
            doc = await moysklad.create_cash_order(
                payload.kind, amount, agent_href, description, item["href"] if item else None
            )
        except MoySkladUnreachable:
            # Ответ не дошёл, а запись могла пройти: повтор вслепую
            # провёл бы операцию дважды
            raise HTTPException(
                status_code=502,
                detail="Нет связи с МойСкладом — операция могла записаться. "
                "Обновите список операций и проверьте, прежде чем вносить снова.",
            )
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    store.append(
        OPS_FILE,
        {"id": doc.get("id", ""), "kind": payload.kind, "by": me.id, "t": store.now(), "sum": amount},
    )
    label = "Расход" if payload.kind == "out" else "Приход"
    detail = " · ".join(filter(None, [_money(amount), item["name"] if item else "", comment]))
    audit("cash_out" if payload.kind == "out" else "cash_in", me, client_ip(request), detail)
    return {"ok": True, "id": doc.get("id", ""), "number": doc.get("name", ""), "label": label}


class CancelRequest(BaseModel):
    reason: str


@router.post("/api/cash/operation/{kind}/{doc_id}/cancel")
async def cancel_operation(
    kind: str, doc_id: str, payload: CancelRequest, request: Request, me: Person = Depends(cash_writer)
) -> dict:
    reason = payload.reason.strip()[:200]
    if len(reason) < 3:
        raise HTTPException(status_code=400, detail="Напишите причину отмены")
    created, cancelled = _app_ops()
    mine = created.get(doc_id)
    today = datetime.now().date().isoformat()
    # Отменить можно только своё и только сегодняшнее: вчерашний день
    # уже сдан, чужие операции — не ваши.
    if (
        not mine
        or mine.get("by") != me.id
        or mine.get("kind") != kind
        or not mine.get("t", "").startswith(today)
        or doc_id in cancelled
    ):
        raise HTTPException(status_code=403, detail="Эту операцию отменить нельзя")

    note = f"ОТМЕНЕНО {datetime.now():%d.%m %H:%M} — {me.name}: {reason}"
    try:
        await request.app.state.moysklad.cancel_cash_order(kind, doc_id, note)
    except MoySkladError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    store.append(OPS_FILE, {"cancel": doc_id, "by": me.id, "t": store.now(), "reason": reason})
    detail = f"{_money(mine.get('sum', 0))} · {reason}"
    audit("cash_cancel", me, client_ip(request), detail)
    await notify_owners(f"Касса: {me.name} отменил(а) {'расход' if kind == 'out' else 'приход'} {detail}")
    return {"ok": True}


class CloseShift(BaseModel):
    counted: float


@router.post("/api/cash/close")
async def close_shift(payload: CloseShift, request: Request, me: Person = Depends(cash_writer)) -> dict:
    if payload.counted < 0:
        raise HTTPException(status_code=400, detail="Сумма не может быть меньше нуля")
    counted = round(payload.counted, 2)
    expected = await cash_balance(request.app.state.moysklad)
    diff = None if expected is None else round(counted - expected, 2)

    entry = {"t": store.now(), "by": me.id, "name": me.name, "counted": counted, "expected": expected, "diff": diff}
    store.append(SHIFTS_FILE, entry)

    if expected is None:
        detail = f"насчитано {_money(counted)}, остаток по учёту недоступен"
    else:
        detail = f"насчитано {_money(counted)}, по учёту {_money(expected)}, разница {_money(diff)}"
    audit("shift_closed", me, client_ip(request), detail)
    flag = "" if diff in (None, 0) else "⚠️ "
    await notify_owners(f"{flag}Касса закрыта ({me.name}): {detail}")
    return entry
