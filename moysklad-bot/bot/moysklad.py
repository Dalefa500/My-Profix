from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://api.moysklad.ru/api/remap/1.2"


# В каталоге остались хвосты вроде «Клей профикс 800 новый 2018» —
# метка давней переоценки, в отчётах она только мешает читать.
_STALE_SUFFIX = re.compile(r"\s*нов(?:ый|ая|ое|ые)\s*20\d\d\s*", re.IGNORECASE)


def clean_product_name(name: str) -> str:
    return _STALE_SUFFIX.sub(" ", name).strip()


# Итоги за всё время лежат на диске: перечитывать всю историю на каждое
# открытие карточки слишком дорого. Раз в неделю база пересчитывается —
# этого хватает, чтобы подхватить правки задним числом.
TOTALS_PATH = os.environ.get("TOTALS_CACHE", "/app/data/agent-totals.json")
BASE_MAX_AGE_DAYS = 7


def _load_totals() -> dict:
    try:
        with open(TOTALS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_totals(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(TOTALS_PATH) or ".", exist_ok=True)
        # Пишем через временный файл: оборванная запись не должна
        # оставить после себя испорченный JSON.
        tmp = f"{TOTALS_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, TOTALS_PATH)
    except OSError as exc:
        logger.warning("Не удалось сохранить итоги: %s", exc)


class MoySkladError(RuntimeError):
    """Raised when the MoySklad API returns an error response."""


class MoySkladUnreachable(MoySkladError):
    """Связь оборвалась или ответ не дождались. Для записи это значит
    «неизвестно»: МойСклад мог запрос и выполнить."""


# МойСклад пускает не больше 5 параллельных запросов от пользователя и 45
# за 3 секунды от аккаунта; сверх этого отвечает 429. Держим запас: бот и
# приложение ходят с одним токеном.
MAX_PARALLEL = 4
MAX_RETRIES = 3

class MoySkladClient:
    """Thin async wrapper around the MoySklad JSON API (REMAP 1.2).

    Only the handful of endpoints this bot needs are covered. Field names
    follow the documented REMAP 1.2 schema (https://dev.moysklad.ru/doc/api/remap/1.2/);
    verify against a live account on first run since some accounts customize
    required fields (mandatory custom attributes, cost items, etc.).
    """

    def __init__(
        self, token: str, *, read_only: bool = False, write_allow: tuple[str, ...] = ()
    ) -> None:
        # Приложению в телефоне запрещено всё, кроме чтения, прямо здесь,
        # на уровне клиента. Исключения перечисляются поштучно шаблонами
        # вида "POST /entity/cashin" — всё остальное отклоняется.
        self._read_only = read_only
        self._write_allow = tuple(re.compile(pattern) for pattern in write_allow)
        self._slots = asyncio.Semaphore(MAX_PARALLEL)
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept-Encoding": "gzip",
                "Content-Type": "application/json",
            },
            timeout=20.0,
            # Some hosts hand containers a dual-stack DNS answer but no
            # working outbound IPv6 route, which stalls every request while
            # it tries (and fails) the IPv6 candidate first. Binding to the
            # IPv4 wildcard address forces IPv4-only connections.
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0"),
        )
        self._organization_href: str | None = None
        self._store_href: str | None = None
        self._default_agent_href: str | None = None
        # Отчёт по взаиморасчётам приходится вычитывать целиком: на этом
        # аккаунте контрагентов десятки тысяч, а фильтра по одному нет.
        # Держим разобранный ответ недолго, чтобы ждать пришлось однажды.
        self._balances: dict[str, float] = {}
        self._balances_by_name: dict[str, float] = {}
        self._balances_at: float = 0.0

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict:
        if self._read_only and method.upper() != "GET":
            call = f"{method.upper()} {path}"
            if not any(pattern.fullmatch(call) for pattern in self._write_allow):
                raise MoySkladError(f"Только чтение: {call} запрещён")

        for attempt in range(MAX_RETRIES + 1):
            async with self._slots:
                try:
                    response = await self._client.request(method, path, **kwargs)
                except httpx.HTTPError as exc:
                    # Таймаут и обрыв связи — тоже ошибка МойСклада, иначе
                    # мимо неё проходят все откаты у вызывающих. Отдельным
                    # типом: запись при этом могла и пройти.
                    raise MoySkladUnreachable(f"Нет связи с МойСкладом: {exc.__class__.__name__}") from exc
            if response.status_code != 429 or attempt == MAX_RETRIES:
                break
            # Лимит запросов: МойСклад сам говорит, сколько подождать
            wait_ms = (
                response.headers.get("X-Lognex-Retry-After")
                or response.headers.get("X-Lognex-Retry-TimeInterval")
            )
            try:
                delay = float(wait_ms) / 1000 if wait_ms else float(response.headers.get("Retry-After", 1))
            except ValueError:
                delay = 1.0
            await asyncio.sleep(min(max(delay, 0.2), 5.0))

        if response.status_code >= 400:
            logger.error("MoySklad API error %s %s: %s", method, path, response.text)
            raise MoySkladError(f"{response.status_code}: {response.text[:500]}")
        if response.status_code == 204 or not response.content:
            return {}
        return response.json()

    @staticmethod
    def _meta(href: str, type_: str) -> dict:
        return {"meta": {"href": href, "type": type_, "mediaType": "application/json"}}

    async def get_default_organization_href(self) -> str:
        if self._organization_href is None:
            data = await self._request("GET", "/entity/organization", params={"limit": 1})
            rows = data.get("rows", [])
            if not rows:
                raise MoySkladError("В аккаунте МойСклад не найдено ни одной организации")
            self._organization_href = rows[0]["meta"]["href"]
        return self._organization_href

    async def get_default_store_href(self) -> str:
        if self._store_href is None:
            data = await self._request("GET", "/entity/store", params={"limit": 1})
            rows = data.get("rows", [])
            if not rows:
                raise MoySkladError("В аккаунте МойСклад не найден ни один склад")
            self._store_href = rows[0]["meta"]["href"]
        return self._store_href

    async def get_default_agent_href(self) -> str:
        """MoySklad requires an 'agent' (counterparty) on cash orders even
        for internal cash flow not tied to a real client/supplier. Reuse (or
        create once) a generic counterparty for that.
        """
        if self._default_agent_href is None:
            name = "Без контрагента"
            results = await self.search_counterparty(name, limit=1)
            matching = [r for r in results if r.get("name") == name]
            if matching:
                self._default_agent_href = matching[0]["meta"]["href"]
            else:
                created = await self.create_counterparty(name)
                self._default_agent_href = created["meta"]["href"]
        return self._default_agent_href

    async def search_counterparty(self, name: str, limit: int = 5) -> list[dict]:
        data = await self._request(
            "GET", "/entity/counterparty", params={"search": name, "limit": limit}
        )
        return data.get("rows", [])

    async def create_counterparty(self, name: str) -> dict:
        return await self._request("POST", "/entity/counterparty", json={"name": name})

    async def create_cash_in(self, sum_rub: float, comment: str, employee: str) -> dict:
        organization_href = await self.get_default_organization_href()
        agent_href = await self.get_default_agent_href()
        payload = {
            "organization": self._meta(organization_href, "organization"),
            "agent": self._meta(agent_href, "counterparty"),
            "sum": round(sum_rub * 100),
            "description": f"{comment}\n\nВнёс: {employee}",
        }
        return await self._request("POST", "/entity/cashin", json=payload)

    async def create_cash_out(self, sum_rub: float, comment: str, employee: str) -> dict:
        organization_href = await self.get_default_organization_href()
        agent_href = await self.get_default_agent_href()
        payload = {
            "organization": self._meta(organization_href, "organization"),
            "agent": self._meta(agent_href, "counterparty"),
            "sum": round(sum_rub * 100),
            "description": f"{comment}\n\nВнёс: {employee}",
        }
        return await self._request("POST", "/entity/cashout", json=payload)

    async def sum_cash_today(self, entity: str) -> float:
        # Постранично: в загруженный день документов бывает больше сотни
        now = datetime.now()
        rows = await self._documents_between(entity, now, now)
        return sum(row.get("sum", 0) for row in rows) / 100

    async def money_today(self) -> dict[str, float]:
        """Приход и расход за сегодня по всему регистру «Платежи»: касса и
        банк вместе — так же, как считает сам МойСклад.
        """
        now = datetime.now()
        totals = {"income": 0.0, "expense": 0.0}
        for entities, key in ((self.MONEY_IN, "income"), (self.MONEY_OUT, "expense")):
            for entity in entities:
                rows = await self._documents_between(entity, now, now)
                totals[key] += sum(row.get("sum", 0) for row in rows) / 100
        return totals

    async def cash_today_operations(self) -> list[dict]:
        """Кассовые ордера за сегодня — то, чем занимается кассир. Только
        касса: банковские платежи идут мимо него.
        """
        now = datetime.now()
        operations: list[dict] = []
        for entity, kind in (("cashin", "in"), ("cashout", "out")):
            expand = "agent,expenseItem" if kind == "out" else "agent"
            for row in await self._documents_between(entity, now, now, expand=expand):
                operations.append(
                    {
                        "id": row.get("id", ""),
                        "time": (row.get("moment") or "")[11:16],
                        "sum": row.get("sum", 0) / 100,
                        "kind": kind,
                        "agent": (row.get("agent") or {}).get("name", ""),
                        "item": (row.get("expenseItem") or {}).get("name", ""),
                        "purpose": row.get("description") or "",
                        "number": row.get("name", ""),
                        # Отменённая операция остаётся в учёте, но не проведена
                        "applicable": row.get("applicable", True),
                    }
                )
        operations.sort(key=lambda op: op["time"], reverse=True)
        return operations

    async def list_expense_items(self) -> list[dict]:
        """Статьи расходов из справочника МойСклада — те же, что видит
        бухгалтер. Архивные не показываем."""
        data = await self._request("GET", "/entity/expenseitem", params={"limit": 1000})
        return [
            {"href": row["meta"]["href"], "name": row.get("name", "?")}
            for row in data.get("rows", [])
            if not row.get("archived")
        ]

    async def create_cash_order(
        self,
        kind: str,
        amount: float,
        agent_href: str,
        description: str,
        expense_item_href: str | None = None,
    ) -> dict:
        """Приходный или расходный кассовый ордер. У расхода МойСклад
        требует статью."""
        entity = "cashin" if kind == "in" else "cashout"
        payload: dict[str, Any] = {
            "organization": self._meta(await self.get_default_organization_href(), "organization"),
            "agent": self._meta(agent_href, "counterparty"),
            "sum": round(amount * 100),
            "description": description,
        }
        if entity == "cashout":
            if not expense_item_href:
                raise MoySkladError("Для расхода нужна статья")
            payload["expenseItem"] = self._meta(expense_item_href, "expenseitem")
        return await self._request("POST", f"/entity/{entity}", json=payload)

    async def cancel_cash_order(self, kind: str, doc_id: str, note: str) -> str:
        entity = "cashin" if kind == "in" else "cashout"
        return await self.unpost(entity, doc_id, note)

    async def unpost(self, entity: str, doc_id: str, note: str) -> str:
        """Отмена без удаления: документ остаётся, но снимается с
        проведения, а в описании дописывается, кто и почему отменил.
        Возвращает прежнее описание — чтобы при откате вернуть его."""
        original = await self.get_description(entity, doc_id)
        await self.mark_unposted(entity, doc_id, note, original)
        return original

    async def get_description(self, entity: str, doc_id: str) -> str:
        doc = await self._request("GET", f"/entity/{entity}/{doc_id}")
        return doc.get("description") or ""

    async def mark_unposted(self, entity: str, doc_id: str, note: str, original: str) -> dict:
        return await self._request(
            "PUT",
            f"/entity/{entity}/{doc_id}",
            json={"applicable": False, "description": f"{note}\n\n{original}".strip()},
        )

    async def find_by_external_code(self, entity: str, code: str) -> dict | None:
        """Документ по нашему коду — чтобы узнать, прошла ли запись, ответ
        на которую не дошёл."""
        data = await self._request(
            "GET", f"/entity/{entity}", params={"filter": f"externalCode={code}", "limit": 1}
        )
        rows = data.get("rows") or []
        return rows[0] if rows else None

    async def repost(self, entity: str, doc_id: str, description: str | None = None) -> dict:
        """Провести документ обратно — откат, если замена сорвалась.
        С описанием — вернуть и его, без пометки об отмене."""
        payload: dict[str, Any] = {"applicable": True}
        if description is not None:
            payload["description"] = description
        return await self._request("PUT", f"/entity/{entity}/{doc_id}", json=payload)

    @staticmethod
    def assortment_meta(href: str) -> dict:
        """Ссылка на товар или модификацию — тип берётся из самой ссылки."""
        match = re.search(r"/entity/(product|variant|bundle|service)/", href)
        return MoySkladClient._meta(href, match.group(1) if match else "product")

    async def create_stock_document(
        self, entity: str, positions: list[dict], description: str, external_code: str = ""
    ) -> dict:
        """Списание (loss) сырья или оприходование (enter) готовых мешков
        на основной склад. positions: [{"href", "quantity", "price"?}],
        цена — в сомони за единицу."""
        if entity not in ("loss", "enter"):
            raise MoySkladError(f"Неизвестный складской документ: {entity}")
        rows = []
        for position in positions:
            row: dict[str, Any] = {
                "quantity": position["quantity"],
                "assortment": self.assortment_meta(position["href"]),
            }
            if "price" in position:
                row["price"] = round(position["price"] * 100)
            rows.append(row)
        payload = {
            "organization": self._meta(await self.get_default_organization_href(), "organization"),
            "store": self._meta(await self.get_default_store_href(), "store"),
            "description": description,
            "positions": rows,
        }
        if external_code:
            # Свой код у каждого документа: если ответ не дойдёт, по нему
            # можно найти, создан ли документ на самом деле
            payload["externalCode"] = external_code
        return await self._request("POST", f"/entity/{entity}", json=payload)

    async def get_account_balances(self) -> list[dict]:
        """Current balance per cash register / bank account via MoySklad's
        own money report (/report/money/byaccount). Not available on every
        tariff/account — raises MoySkladError if the endpoint doesn't return
        the expected shape, so callers should fall back to
        get_total_cash_balance_fallback().
        """
        data = await self._request("GET", "/report/money/byaccount")
        rows = data.get("rows") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise MoySkladError("Неожиданный формат ответа /report/money/byaccount")

        balances = []
        for row in rows:
            account = row.get("account") or {}
            balances.append(
                {
                    "name": account.get("name", "Касса"),
                    "balance": row.get("balance", 0) / 100,
                }
            )
        return balances

    async def get_total_cash_balance_fallback(self) -> float:
        """Sums every cashin/cashout document ever recorded in the account
        (paginated). Used when the money-by-account report isn't available.
        Slow on accounts with very long history — fine for an on-demand or
        once-a-day call.
        """
        total = 0.0
        limit = 1000
        for entity, sign in (("cashin", 1), ("cashout", -1)):
            offset = 0
            while True:
                data = await self._request(
                    "GET", f"/entity/{entity}", params={"limit": limit, "offset": offset}
                )
                rows = data.get("rows", [])
                total += sign * sum(row.get("sum", 0) for row in rows) / 100
                if len(rows) < limit:
                    break
                offset += limit
        return total

    async def get_stock_report(self, limit: int = 1000) -> list[dict]:
        """Current stock quantity per product/material (/report/stock/all),
        grouped by product folder (МойСклад's category/group) so raw
        materials and finished goods can be told apart — assuming the
        account keeps them in separate folders. If a row has no folder,
        it's labelled "Без категории".
        """
        # Постранично: раньше читалась одна страница, и всё, что после
        # сотой позиции, в «Остатках» просто не появлялось.
        rows: list[dict] = []
        offset = 0
        while True:
            data = await self._request(
                "GET", "/report/stock/all", params={"limit": limit, "offset": offset}
            )
            page = data.get("rows") if isinstance(data, dict) else data
            if not isinstance(page, list):
                raise MoySkladError("Неожиданный формат ответа /report/stock/all")
            rows.extend(page)
            if len(page) < limit:
                break
            offset += limit
        result = []
        for row in rows:
            folder = row.get("folder") or {}
            uom = row.get("uom") or {}
            result.append(
                {
                    "name": clean_product_name(row.get("name", "?")),
                    "stock": row.get("stock", 0),
                    "reserve": row.get("reserve", 0),
                    # Себестоимость единицы по учёту — из неё считаем
                    # стоимость мешка по техкарте
                    "cost": (row.get("price") or 0) / 100,
                    "folder": folder.get("name") or "Без категории",
                    # Единица измерения из карточки товара: кг, шт, л…
                    "uom": uom.get("name", ""),
                    # Ссылка на товар — по ней приложение тянет фото
                    "href": (row.get("meta") or {}).get("href", ""),
                }
            )
        return result

    async def get_counterparty_debts(self, limit: int = 30) -> list[dict]:
        """Outstanding balance per counterparty (/report/counterparty).

        Positive balance = the counterparty owes us; negative = we owe them.
        This endpoint is less commonly used than /report/money and /report/stock
        — treat the first live call as a test and adjust if the account
        returns an unexpected shape.
        """
        data = await self._request("GET", "/report/counterparty", params={"limit": limit})
        rows = data.get("rows") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise MoySkladError("Неожиданный формат ответа /report/counterparty")

        debts = []
        for row in rows:
            balance = row.get("balance", 0) / 100
            if abs(balance) < 0.01:
                continue
            debts.append({"name": row.get("name", "?"), "balance": balance})
        return debts

    async def get_cash_rows(
        self,
        entity: str,
        start: datetime,
        end: datetime,
        *,
        expand_agent: bool = False,
        agent_href: str | None = None,
    ) -> list[dict]:
        """Raw cashin/cashout documents (moment, sum, description, and —
        with expand_agent — the full counterparty object) between start and
        end (inclusive), paginated. Pass agent_href to filter server-side to
        one specific counterparty.
        """
        return await self._documents_between(
            entity, start, end, expand_agent=expand_agent, agent_href=agent_href
        )

    async def _documents_between(
        self,
        entity: str,
        start: datetime,
        end: datetime,
        *,
        expand_agent: bool = False,
        agent_href: str | None = None,
        expand: str | None = None,
    ) -> list[dict]:
        """Every document of one kind whose moment falls in the period,
        page by page. Shared by the cash reports and by shipments.
        """
        if expand_agent:
            expand = "agent"
        rows_all: list[dict] = []
        offset = 0
        # С раскрытием связанных объектов МойСклад отдаёт не больше сотни
        limit = 100 if expand else 1000
        filter_parts = [
            f"moment>={start.strftime('%Y-%m-%d')} 00:00:00",
            f"moment<={end.strftime('%Y-%m-%d')} 23:59:59",
        ]
        if agent_href:
            filter_parts.append(f"agent={agent_href}")
        while True:
            params: dict[str, Any] = {
                "filter": ";".join(filter_parts),
                "limit": limit,
                "offset": offset,
            }
            if expand:
                params["expand"] = expand
            data = await self._request("GET", f"/entity/{entity}", params=params)
            rows = data.get("rows", [])
            rows_all.extend(rows)
            if len(rows) < limit:
                break
            offset += limit
        return rows_all

    async def get_daily_cash_summary(
        self, start: datetime, end: datetime
    ) -> dict[str, dict[str, float]]:
        """Per-day income/expense totals for cashin/cashout between start and
        end (inclusive), keyed by 'YYYY-MM-DD'.
        """
        daily: dict[str, dict[str, float]] = {}
        for entity, key in (("cashin", "income"), ("cashout", "expense")):
            for row in await self.get_cash_rows(entity, start, end):
                day = (row.get("moment") or "")[:10]
                if not day:
                    continue
                daily.setdefault(day, {"income": 0.0, "expense": 0.0})
                daily[day][key] += row.get("sum", 0) / 100
        return daily

    async def get_daily_money_summary(
        self, start: datetime, end: datetime
    ) -> dict[str, dict[str, float]]:
        """То же по дням, но по всему регистру «Платежи»: касса и банк."""
        daily: dict[str, dict[str, float]] = {}
        for entities, key in ((self.MONEY_IN, "income"), (self.MONEY_OUT, "expense")):
            for entity in entities:
                for row in await self._documents_between(entity, start, end):
                    day = (row.get("moment") or "")[:10]
                    if not day:
                        continue
                    daily.setdefault(day, {"income": 0.0, "expense": 0.0})
                    daily[day][key] += row.get("sum", 0) / 100
        return daily

    async def _counterparty_names(self) -> dict[str, str]:
        """href -> name for every counterparty. Documents carry only a link
        to the counterparty; asking the API to expand it caps a page at 100
        rows, so for a year of shipments it is far cheaper to pull the list
        once and look names up locally.
        """
        names: dict[str, str] = {}
        offset = 0
        limit = 1000
        while True:
            data = await self._request(
                "GET", "/entity/counterparty", params={"limit": limit, "offset": offset}
            )
            rows = data.get("rows", [])
            for row in rows:
                href = (row.get("meta") or {}).get("href")
                if href:
                    names[href] = row.get("name", "?")
            if len(rows) < limit:
                break
            offset += limit
        return names

    # Касса и банк: в «Платежах» МойСклада они лежат вперемешку, и
    # оплата от покупателя может прийти любым из четырёх документов.
    MONEY_IN = ("cashin", "paymentin")
    MONEY_OUT = ("cashout", "paymentout")

    async def _money_by_agent(self, start: datetime, end: datetime) -> dict[str, float]:
        """Сколько каждый контрагент занёс за период (приход минус возвраты).
        Оплаты у нас не привязаны к отгрузкам — деньги приходят отдельным
        документом на контрагента, поэтому считать надо отсюда.
        """
        totals: dict[str, float] = {}
        for entities, factor in ((self.MONEY_IN, 1), (self.MONEY_OUT, -1)):
            for entity in entities:
                for row in await self._documents_between(entity, start, end):
                    href = ((row.get("agent") or {}).get("meta") or {}).get("href")
                    if not href:
                        continue
                    totals[href] = totals.get(href, 0.0) + factor * row.get("sum", 0) / 100
        return totals

    async def get_shipment_totals(self, start: datetime, end: datetime) -> float:
        """Только сумма отгрузок за период — для сравнения с предыдущим."""
        return sum(
            row.get("sum", 0) / 100
            for row in await self._documents_between("demand", start, end)
        )

    async def get_shipment_summary(self, start: datetime, end: datetime) -> dict:
        """Shipments (отгрузки) in the period: total, document count,
        per-day sums and a per-counterparty breakdown.
        """
        daily: dict[str, float] = {}
        by_agent: dict[str, dict[str, float]] = {}
        total = 0.0
        paid = 0.0
        count = 0
        for row in await self._documents_between("demand", start, end):
            amount = row.get("sum", 0) / 100
            total += amount
            count += 1
            day = (row.get("moment") or "")[:10]
            if day:
                daily[day] = daily.get(day, 0.0) + amount
            href = ((row.get("agent") or {}).get("meta") or {}).get("href")
            if href:
                entry = by_agent.setdefault(href, {"total": 0.0, "paid": 0.0})
                entry["total"] += amount

        if by_agent:
            money = await self._money_by_agent(start, end)
            for href, entry in by_agent.items():
                # Занести могли и больше отгруженного — гасили старый долг;
                # для этой вкладки считаем только в пределах периода.
                entry["paid"] = max(0.0, min(entry["total"], money.get(href, 0.0)))
                paid += entry["paid"]

        names = await self._counterparty_names() if by_agent else {}
        agents = sorted(
            (
                {
                    "name": names.get(href, "Без контрагента"),
                    "href": href,
                    "total": value["total"],
                    "paid": value["paid"],
                    "debt": value["total"] - value["paid"],
                }
                for href, value in by_agent.items()
            ),
            key=lambda a: -a["total"],
        )
        return {
            "total": total,
            "paid": paid,
            "debt": total - paid,
            "count": count,
            "daily": daily,
            "agents": agents,
        }

    async def _uom_names(self) -> dict[str, str]:
        """href -> название единицы измерения. В раскрытом товаре единица
        приходит ссылкой, а справочник маленький — забираем целиком.
        """
        names: dict[str, str] = {}
        data = await self._request("GET", "/entity/uom", params={"limit": 1000})
        for row in data.get("rows", []):
            href = (row.get("meta") or {}).get("href")
            if href:
                names[href] = row.get("name", "")
        return names

    async def get_shipment_detail(
        self, agent_href: str, start: datetime, end: datetime
    ) -> dict:
        """One counterparty's shipments in the period: what was shipped
        (summed up by product) and what is paid for.
        """
        docs: list[dict] = []
        goods: dict[str, dict] = {}
        total = 0.0
        offset = 0
        # С раскрытием позиций страница ограничена сотней документов.
        limit = 100
        filter_parts = [
            f"moment>={start.strftime('%Y-%m-%d')} 00:00:00",
            f"moment<={end.strftime('%Y-%m-%d')} 23:59:59",
            f"agent={agent_href}",
        ]
        while True:
            data = await self._request(
                "GET",
                "/entity/demand",
                params={
                    "filter": ";".join(filter_parts),
                    "expand": "positions.assortment",
                    "limit": limit,
                    "offset": offset,
                },
            )
            rows = data.get("rows", [])
            for row in rows:
                amount = row.get("sum", 0) / 100
                total += amount
                docs.append(
                    {
                        "date": (row.get("moment") or "")[:10],
                        "number": row.get("name", ""),
                        "sum": amount,
                    }
                )
                for position in ((row.get("positions") or {}).get("rows") or []):
                    item = position.get("assortment") or {}
                    name = item.get("name", "?")
                    href = (item.get("meta") or {}).get("href") or ""
                    quantity = position.get("quantity", 0) or 0
                    price = (position.get("price", 0) or 0) / 100
                    discount = position.get("discount", 0) or 0
                    line = quantity * price * (1 - discount / 100)
                    # Складываем по самому товару, а не по названию: разные
                    # позиции могут называться одинаково.
                    entry = goods.setdefault(
                        href or name,
                        {
                            "name": clean_product_name(name),
                            "qty": 0.0,
                            "sum": 0.0,
                            "uom_href": ((item.get("uom") or {}).get("meta") or {}).get("href", ""),
                            "href": href,
                        },
                    )
                    entry["qty"] += quantity
                    entry["sum"] += line
            if len(rows) < limit:
                break
            offset += limit

        # Деньги от контрагента — отдельными документами, поэтому
        # тянем их своим запросом и показываем рядом с отгрузками.
        payments: list[dict] = []
        paid = 0.0
        for entities, kind in ((self.MONEY_IN, "in"), (self.MONEY_OUT, "out")):
            for entity in entities:
                for row in await self.get_cash_rows(entity, start, end, agent_href=agent_href):
                    amount = row.get("sum", 0) / 100
                    paid += amount if kind == "in" else -amount
                    payments.append(
                        {
                            "date": (row.get("moment") or "")[:10],
                            "sum": amount,
                            "kind": kind,
                            "purpose": row.get("description") or "",
                        }
                    )
        payments.sort(key=lambda p: p["date"], reverse=True)

        uoms = await self._uom_names() if goods else {}
        for entry in goods.values():
            # Цена за единицу — средняя по периоду: одна и та же позиция
            # могла уходить по разной цене.
            entry["price"] = entry["sum"] / entry["qty"] if entry["qty"] else 0.0
            entry["uom"] = uoms.get(entry.pop("uom_href", ""), "")

        return {
            "total": total,
            "paid": paid,
            "debt": total - paid,
            "goods": sorted(goods.values(), key=lambda g: -g["sum"]),
            "docs": sorted(docs, key=lambda d: d["date"], reverse=True),
            "payments": payments,
        }

    @staticmethod
    def _row_counterparty_id(row: dict) -> str:
        """id контрагента из строки отчёта. Ссылка лежит по-разному: у
        одних отчётов это собственный meta строки, у других — поле
        counterparty или agent. Берём первую, которая ведёт на контрагента.
        """
        sources = (
            row.get("meta"),
            (row.get("counterparty") or {}).get("meta"),
            (row.get("agent") or {}).get("meta"),
        )
        for source in sources:
            href = (source or {}).get("href") or ""
            if "/counterparty/" in href:
                return href.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        return ""

    async def get_agent_totals_cached(self, agent_href: str, end: datetime) -> dict:
        """То же за всё время, но без перечитывания истории на каждое
        открытие. Один раз считаем базу по вчерашний день включительно и
        кладём на диск; дальше добавляем только документы с этого рубежа.
        Раз в неделю база пересчитывается заново — на случай, если задним
        числом поправили старый документ.
        """
        agent_id = agent_href.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        boundary = datetime.combine(end.date(), datetime.min.time())
        store = _load_totals()
        entry = store.get(agent_id)

        stale = True
        if entry:
            try:
                age = boundary - datetime.fromisoformat(entry["boundary"])
                stale = age > timedelta(days=BASE_MAX_AGE_DAYS)
            except (KeyError, ValueError):
                stale = True

        if stale:
            base = await self.get_agent_totals(agent_href, datetime(2000, 1, 1), boundary)
            entry = {
                "shipped": base["shipped"],
                "paid": base["paid"],
                "boundary": boundary.isoformat(),
            }
            store[agent_id] = entry
            _save_totals(store)
            logger.info("Пересчитана база по контрагенту %s", agent_id)

        since = datetime.fromisoformat(entry["boundary"])
        delta = await self.get_agent_totals(agent_href, since, end)
        return {
            "shipped": entry["shipped"] + delta["shipped"],
            "paid": entry["paid"] + delta["paid"],
        }

    async def get_agent_totals(
        self, agent_href: str, start: datetime, end: datetime
    ) -> dict:
        """Отгружено и занесено денег по контрагенту за период — без
        разбора позиций. Годится и для «за всё время»: фильтр по
        контрагенту делает сервер, документов возвращается немного.
        """
        shipped = sum(
            row.get("sum", 0) / 100
            for row in await self._documents_between(
                "demand", start, end, agent_href=agent_href
            )
        )
        paid = 0.0
        for entities, factor in ((self.MONEY_IN, 1), (self.MONEY_OUT, -1)):
            for entity in entities:
                for row in await self.get_cash_rows(
                    entity, start, end, agent_href=agent_href
                ):
                    paid += factor * row.get("sum", 0) / 100
        return {"shipped": shipped, "paid": paid}

    async def get_counterparty_balance(self, agent_href: str, agent_name: str = "") -> float:
        """Конечный остаток контрагента за всё время — та же цифра, что в
        «Деньги → Взаиморасчёты». Плюс означает, что должен он нам.

        Отчёт не принимает фильтр по agent (отвечает 412), а выборочный
        запрос через POST на этом аккаунте вернул не того контрагента.
        Поэтому пробуем по очереди и берём строку, только если она
        действительно про нужного контрагента, — чужой ноль хуже, чем
        честное «не смогли».
        """
        agent_id = agent_href.split("?")[0].rstrip("/").rsplit("/", 1)[-1]

        # 1. Выборочный отчёт одним запросом
        try:
            data = await self._request(
                "POST",
                "/report/counterparty",
                json={"counterparties": [self._meta(agent_href, "counterparty")]},
            )
            for row in data.get("rows") or []:
                if self._row_counterparty_id(row) == agent_id:
                    logger.info("Остаток по %s взят выборочным отчётом", agent_id)
                    return row.get("balance", 0) / 100
        except MoySkladError as exc:
            logger.info("Выборочный отчёт по контрагенту не сработал: %s", exc)

        # 2. Полный отчёт — медленно, но наверняка; держим в памяти
        balances, by_name = await self._all_balances()
        if agent_id in balances:
            logger.info("Остаток по %s взят из общего отчёта", agent_id)
            return balances[agent_id]
        # Последняя попытка: в отчёте может не оказаться ссылки, зато имя
        # там есть всегда.
        key = agent_name.strip().lower()
        if key and key in by_name:
            logger.info("Остаток по «%s» найден по имени", agent_name)
            return by_name[key]
        raise MoySkladError("Контрагент не найден в отчёте по взаиморасчётам")

    async def _all_balances(
        self, max_age: float = 600.0
    ) -> tuple[dict[str, float], dict[str, float]]:
        """Остатки по всем контрагентам: по id и по имени. Перечитываем не
        чаще раза в десять минут — за один проход это десятки запросов.
        """
        if self._balances and time.monotonic() - self._balances_at < max_age:
            return self._balances, self._balances_by_name

        balances: dict[str, float] = {}
        by_name: dict[str, float] = {}
        offset = 0
        limit = 1000
        shape_logged = False
        while offset < 100_000:
            try:
                data = await self._request(
                    "GET", "/report/counterparty", params={"limit": limit, "offset": offset}
                )
            except MoySkladError as exc:
                if limit > 100:
                    # Некоторые отчёты не принимают страницу больше сотни
                    logger.info("Отчёт не принял limit=%d (%s), пробую по 100", limit, exc)
                    limit = 100
                    continue
                raise
            rows = data.get("rows") or []
            if rows and not shape_logged:
                # Одной строкой в лог: по каким полям вообще можно опознать
                # контрагента, если вдруг снова не найдётся.
                logger.info("Строка отчёта по контрагентам: %s", sorted(rows[0].keys()))
                shape_logged = True
            for row in rows:
                balance = row.get("balance", 0) / 100
                key = self._row_counterparty_id(row)
                if key:
                    balances[key] = balance
                name = (row.get("name") or "").strip().lower()
                if name:
                    by_name[name] = balance
            if len(rows) < limit:
                break
            offset += limit

        logger.info(
            "Прочитан отчёт по взаиморасчётам: %d по ссылке, %d по имени",
            len(balances),
            len(by_name),
        )
        self._balances = balances
        self._balances_by_name = by_name
        self._balances_at = time.monotonic()
        return balances, by_name

    async def get_bonus_total(self, agent_name: str) -> dict:
        """Бонусы, выданные контрагенту. В учёте они висят на отдельном
        контрагенте («Бонус покупатель»), а кому именно — написано только
        в назначении платежа, поэтому ищем по имени в тексте.
        """
        bonus_agents = [
            candidate["meta"]["href"]
            for candidate in await self.search_counterparty("Бонус", limit=10)
            if "бонус" in (candidate.get("name") or "").lower()
        ]
        if not bonus_agents:
            return {"total": 0.0, "rows": []}

        # Имя контрагента в назначении пишут по-разному («Бонус ба Максуд»,
        # «Бонус ба Максуд осиё»), поэтому сверяем по значимым словам.
        words = [w.lower() for w in re.findall(r"\w+", agent_name) if len(w) > 3]
        if not words:
            return {"total": 0.0, "rows": []}

        start = datetime(2000, 1, 1)
        end = datetime.now()
        total = 0.0
        rows: list[dict] = []
        for entity in self.MONEY_OUT:
            for href in bonus_agents:
                for row in await self.get_cash_rows(entity, start, end, agent_href=href):
                    text = (row.get("description") or "").lower()
                    if not any(word in text for word in words):
                        continue
                    amount = row.get("sum", 0) / 100
                    total += amount
                    rows.append(
                        {
                            "date": (row.get("moment") or "")[:10],
                            "sum": amount,
                            "purpose": row.get("description") or "",
                        }
                    )
        rows.sort(key=lambda r: r["date"], reverse=True)
        return {"total": total, "rows": rows}

    async def get_product_image(self, assortment_href: str) -> tuple[bytes, str] | None:
        """Миниатюра товара. Список картинок и сам файл лежат по разным
        адресам: сперва спрашиваем список, потом скачиваем миниатюру.
        Возвращает None, если фото у товара нет.
        """
        path = assortment_href[len(BASE_URL) :]
        data = await self._request("GET", f"{path}/images", params={"limit": 1})
        rows = data.get("rows") or []
        if not rows:
            return None
        miniature = (rows[0].get("miniature") or {}).get("href")
        if not miniature:
            return None
        # Ссылка на файл ведёт на хранилище и сама по себе уже подписана;
        # httpx снимет заголовок авторизации на чужом хосте.
        try:
            response = await self._client.get(miniature, follow_redirects=True)
        except httpx.HTTPError:
            return None
        if response.status_code >= 400:
            return None
        return response.content, response.headers.get("content-type", "image/jpeg")

    async def resolve_tracked_agents(self, names: dict[str, str]) -> list[dict]:
        """Resolve a fixed list of counterparties, keyed by the search term
        used to find them in MoySklad with the display label to show
        instead (e.g. {"Дивиденды": "💼 Инвестор (вы)"}).
        """
        resolved: list[dict] = []
        seen_hrefs: set[str] = set()
        for search_name, display_label in names.items():
            candidates = await self.search_counterparty(search_name, limit=5)
            for candidate in candidates:
                href = candidate["meta"]["href"]
                if href in seen_hrefs:
                    continue
                seen_hrefs.add(href)
                # If the search term is broad enough to match more than one
                # real counterparty, keep the actual МойСклад name visible
                # too so they don't get silently conflated under one label.
                label = display_label
                if len(candidates) > 1:
                    label = f"{display_label} ({candidate.get('name', search_name)})"
                resolved.append({"name": label, "href": href})
        return resolved

    async def get_named_counterparty_expenses(
        self, names: dict[str, str], start: datetime, end: datetime
    ) -> list[dict]:
        """Expense totals for a fixed, known list of counterparties.
        Resolved once via search then queried directly with a server-side
        agent filter — far cheaper than scanning every cashout row in the
        period when you only care about a handful of people.
        """
        results: list[dict] = []
        for entry in await self.resolve_tracked_agents(names):
            breakdown = await self.get_counterparty_expense_breakdown(entry["href"], start, end)
            results.append({**entry, "total": breakdown["total"]})
        return sorted(results, key=lambda e: -e["total"])

    async def get_counterparty_expense_breakdown(
        self, agent_href: str, start: datetime, end: datetime
    ) -> dict:
        """Total + per-day expense for one specific counterparty (by href)."""
        daily: dict[str, float] = {}
        total = 0.0
        for row in await self.get_cash_rows("cashout", start, end, agent_href=agent_href):
            amount = row.get("sum", 0) / 100
            total += amount
            day = (row.get("moment") or "")[:10]
            if day:
                daily[day] = daily.get(day, 0.0) + amount
        return {"total": total, "daily": daily}
