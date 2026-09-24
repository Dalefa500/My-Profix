"""Данные самого приложения: техкарты, замесы, смены кассы.

Лежат в томе app-data рядом с сотрудниками и журналом и переживают
перезапуск и обновление. Списки пишутся целиком через временный файл,
события — дописываются строкой в конец: оборванная запись не должна
оставить испорченный файл.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path

from web.access import DATA_DIR

_lock = threading.Lock()


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _path(name: str) -> Path:
    return DATA_DIR / name


def read_json(name: str, default):
    try:
        return json.loads(_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(name: str, data) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = _path(name)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)


def append(name: str, entry: dict) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = _path(name)
        # Если прошлая запись оборвалась на полуслове (сбой питания), без
        # перевода строки новая склеилась бы с ней и пропала бы тоже.
        torn = False
        try:
            with open(path, "rb") as fh:
                fh.seek(-1, os.SEEK_END)
                torn = fh.read(1) != b"\n"
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(("\n" if torn else "") + json.dumps(entry, ensure_ascii=False) + "\n")


def read_lines(name: str) -> list[dict]:
    try:
        raw = _path(name).read_bytes()
    except OSError:
        return []
    entries = []
    # Каждую строку разбираем отдельно: оборванная посреди русской буквы
    # не должна ронять чтение всего файла.
    for line in raw.split(b"\n"):
        try:
            entries.append(json.loads(line.decode("utf-8")))
        except ValueError:  # в том числе UnicodeDecodeError
            continue
    return entries
