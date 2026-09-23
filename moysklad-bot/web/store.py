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
        with open(_path(name), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_lines(name: str) -> list[dict]:
    try:
        lines = _path(name).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    entries = []
    for line in lines:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    return entries
