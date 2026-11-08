"""Shared-snippet storage in SQLite."""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from pathlib import Path

_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class SnippetStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute(
                """CREATE TABLE IF NOT EXISTS snippets (
                       id TEXT PRIMARY KEY,
                       files TEXT NOT NULL,
                       entry TEXT NOT NULL,
                       created_at INTEGER NOT NULL
                   )"""
            )
            self._conn.commit()

    def create(self, files: list[dict], entry: str) -> str:
        payload = json.dumps(files, ensure_ascii=False)
        with self._lock:
            for _ in range(10):
                sid = "".join(secrets.choice(_ALPHABET) for _ in range(8))
                try:
                    self._conn.execute(
                        "INSERT INTO snippets (id, files, entry, created_at) VALUES (?, ?, ?, ?)",
                        (sid, payload, entry, int(time.time())),
                    )
                    self._conn.commit()
                    return sid
                except sqlite3.IntegrityError:
                    continue
        raise RuntimeError("could not allocate snippet id")

    def get(self, sid: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT files, entry, created_at FROM snippets WHERE id = ?", (sid,)).fetchone()
        if not row:
            return None
        return {"id": sid, "files": json.loads(row[0]), "entry": row[1], "created_at": row[2]}
