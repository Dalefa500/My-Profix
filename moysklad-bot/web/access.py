"""Кто может войти и что он видит.

У каждого человека свой код и своя роль. Учредитель входит по WEB_PIN из
.env — его нельзя отключить из приложения, поэтому запереть самого себя
не получится. Остальных учредитель заводит в приложении: код создаётся
на сервере, показывается один раз и хранится только в виде подписи.

Права проверяет сервер на каждом запросе. Скрытая в телефоне вкладка
ничего не защищает — защищает отказ сервера отдать данные.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("WEB_DATA_DIR", "/app/data"))
USERS_PATH = DATA_DIR / "users.json"
AUDIT_PATH = DATA_DIR / "audit.jsonl"
AUDIT_MAX_BYTES = 2_000_000
AUDIT_KEEP_LINES = 5_000

OWNER_ID = "owner"
CODE_DIGITS = 8

# Что открыто каждой роли. Вкладки — то, что видно в телефоне;
# сервер сверяется с этим же списком, когда отдаёт данные.
# «can» — что роль может не только смотреть, но и вносить.
ROLES: dict[str, dict] = {
    "owner": {
        "label": "Учредитель",
        "tabs": ["balance", "report", "shipments", "stock", "production", "team"],
        "manage": True,
        "can": ["production_edit"],
    },
    "director": {
        "label": "Директор",
        "tabs": ["balance", "report", "shipments", "stock", "production", "team"],
        "manage": False,
        "can": [],
    },
    # Бухгалтер он же мастер замеса: ведёт техкарты и отмечает замесы
    "accountant": {
        "label": "Бухгалтер",
        "tabs": ["balance", "report", "shipments", "stock", "production"],
        "manage": False,
        "can": ["production_edit"],
    },
    "cashier": {
        "label": "Кассир",
        "tabs": ["cash"],
        "manage": False,
        "can": ["cash_write"],
    },
}


@dataclass(frozen=True)
class Person:
    id: str
    name: str
    role: str
    version: int = 0

    @property
    def role_label(self) -> str:
        return ROLES[self.role]["label"]

    @property
    def tabs(self) -> list[str]:
        return ROLES[self.role]["tabs"]

    @property
    def can_manage(self) -> bool:
        return ROLES[self.role]["manage"]

    @property
    def actions(self) -> list[str]:
        return ROLES[self.role]["can"]

    def may(self, tab: str) -> bool:
        return tab in self.tabs

    def can(self, action: str) -> bool:
        return action in self.actions


class Access:
    def __init__(self, owner_pin: str, secret: str, owner_name: str = "Учредитель") -> None:
        self._owner_pin = owner_pin
        # Коды сотрудников хранятся подписью на секрете сервера: по самому
        # файлу их не восстановить, даже если он утечёт.
        self._key = hashlib.sha256(f"pmx-codes:{secret}".encode()).digest()
        self.owner = Person(OWNER_ID, owner_name, "owner")
        self._lock = threading.Lock()

    # --- хранение ---------------------------------------------------------

    def _load(self) -> list[dict]:
        try:
            data = json.loads(USERS_PATH.read_text(encoding="utf-8"))
            users = data.get("users", [])
            return [u for u in users if u.get("role") in ROLES]
        except (OSError, ValueError):
            return []

    def _save(self, users: list[dict]) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = USERS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps({"users": users}, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, USERS_PATH)

    def _digest(self, code: str) -> str:
        return hmac.new(self._key, code.strip().encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _person(user: dict) -> Person:
        return Person(user["id"], user["name"], user["role"], int(user.get("version", 0)))

    # --- вход -------------------------------------------------------------

    def check_code(self, code: str) -> Person | None:
        """Чей это код. Сравниваем со всеми, не останавливаясь на первом
        совпадении, — по времени ответа не угадать, близко ли попали."""
        code = code.strip()
        found: Person | None = None
        if hmac.compare_digest(code.encode(), self._owner_pin.encode()):
            found = self.owner
        digest = self._digest(code)
        for user in self._load():
            if hmac.compare_digest(digest, user.get("code", "")) and user.get("active", True):
                found = found or self._person(user)
        return found

    def session_person(self, payload: object) -> Person | None:
        """Кто стоит за подписанной сессией — и жива ли она ещё. Отключили
        человека или сменили ему код — его сессия перестаёт действовать
        на следующем же запросе."""
        # Сессии, выданные до появления ролей, — это вход по WEB_PIN
        if payload == "ok":
            return self.owner
        if not isinstance(payload, dict):
            return None
        user_id = payload.get("u")
        if user_id == OWNER_ID:
            return self.owner
        for user in self._load():
            if user["id"] == user_id:
                if not user.get("active", True):
                    return None
                if int(user.get("version", 0)) != payload.get("v"):
                    return None
                return self._person(user)
        return None

    @staticmethod
    def session_payload(person: Person) -> dict:
        return {"u": person.id, "v": person.version}

    def mark_login(self, person: Person) -> None:
        if person.id == OWNER_ID:
            return
        with self._lock:
            users = self._load()
            for user in users:
                if user["id"] == person.id:
                    user["last_login"] = _now()
            self._save(users)

    # --- управление сотрудниками -----------------------------------------

    def list_people(self) -> list[dict]:
        return [
            {
                "id": u["id"],
                "name": u["name"],
                "role": u["role"],
                "roleLabel": ROLES[u["role"]]["label"],
                "active": u.get("active", True),
                "created": u.get("created", ""),
                "lastLogin": u.get("last_login", ""),
            }
            for u in self._load()
        ]

    def _new_code(self, users: list[dict]) -> str:
        taken = {u.get("code") for u in users}
        while True:
            code = "".join(str(secrets.randbelow(10)) for _ in range(CODE_DIGITS))
            if code != self._owner_pin and self._digest(code) not in taken:
                return code

    def add(self, name: str, role: str) -> tuple[dict, str]:
        if role not in ROLES:
            raise ValueError("Неизвестная роль")
        name = name.strip()
        if not name:
            raise ValueError("Укажите имя")
        with self._lock:
            users = self._load()
            code = self._new_code(users)
            user = {
                "id": f"u_{secrets.token_hex(4)}",
                "name": name[:60],
                "role": role,
                "code": self._digest(code),
                "active": True,
                "version": 1,
                "created": _now(),
            }
            users.append(user)
            self._save(users)
        return user, code

    def _update(self, user_id: str, change) -> dict:
        with self._lock:
            users = self._load()
            for user in users:
                if user["id"] == user_id:
                    result = change(user, users)
                    self._save(users)
                    return result if result is not None else user
        raise KeyError(user_id)

    def set_active(self, user_id: str, active: bool) -> dict:
        def change(user: dict, _users: list[dict]) -> None:
            if user.get("active", True) and not active:
                # Отключение сразу закрывает уже открытые сессии
                user["version"] = int(user.get("version", 0)) + 1
            user["active"] = active

        return self._update(user_id, change)

    def new_code(self, user_id: str) -> tuple[dict, str]:
        issued: dict[str, str] = {}

        def change(user: dict, users: list[dict]) -> None:
            code = self._new_code(users)
            issued["code"] = code
            user["code"] = self._digest(code)
            # Старый код и все сессии по нему больше не действуют
            user["version"] = int(user.get("version", 0)) + 1

        user = self._update(user_id, change)
        return user, issued["code"]


# --- журнал ---------------------------------------------------------------

_audit_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def audit(action: str, person: Person | None, ip: str, detail: str = "") -> None:
    """Одна строка в журнал действий. Журнал только дописывается: из
    приложения его не стереть и не поправить."""
    entry = {
        "t": _now(),
        "action": action,
        "who": person.name if person else "",
        "role": person.role if person else "",
        "ip": ip,
        "detail": detail,
    }
    try:
        with _audit_lock:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if AUDIT_PATH.stat().st_size > AUDIT_MAX_BYTES:
                lines = AUDIT_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-AUDIT_KEEP_LINES:]
                tmp = AUDIT_PATH.with_suffix(".tmp")
                tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
                os.replace(tmp, AUDIT_PATH)
    except OSError as exc:
        logger.warning("Не удалось записать в журнал: %s", exc)


def read_audit(limit: int = 200) -> list[dict]:
    try:
        # errors="replace": оборванная посреди буквы строка просто не
        # разберётся ниже, а не уронит чтение всего журнала
        lines = AUDIT_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except OSError:
        return []
    entries = []
    for line in reversed(lines):
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    return entries


# --- проверки в обработчиках ----------------------------------------------

COOKIE_NAME = "pmx_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # вход запоминается на месяц


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def current_person(request: Request) -> Person | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    try:
        payload = request.app.state.serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    return request.app.state.access.session_person(payload)


def require_person(request: Request) -> Person:
    person = current_person(request)
    if person is None:
        raise HTTPException(status_code=401, detail="Нужно войти")
    return person


def allow(*tabs: str):
    """Пускает только тех, кому по роли открыт хотя бы один из разделов."""

    def check(person: Person = Depends(require_person)) -> Person:
        if not any(person.may(tab) for tab in tabs):
            raise HTTPException(status_code=403, detail="Этот раздел вам недоступен")
        return person

    return [Depends(check)]


def require_can(action: str):
    """Для записи: смотреть раздел мало, нужно право вносить."""

    def check(person: Person = Depends(require_person)) -> Person:
        if not person.can(action):
            raise HTTPException(status_code=403, detail="Вносить это вам нельзя")
        return person

    return check


def require_manager(person: Person = Depends(require_person)) -> Person:
    if not person.can_manage:
        raise HTTPException(status_code=403, detail="Доступами управляет учредитель")
    return person
