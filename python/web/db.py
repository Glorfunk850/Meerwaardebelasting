"""SQLite-opslag. Bedragen worden als TEXT bewaard om Decimal-precisie te behouden."""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    isin           TEXT PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT '',
    asset_type     TEXT NOT NULL DEFAULT 'aandeel',
    currency       TEXT NOT NULL DEFAULT 'EUR',
    listed         INTEGER NOT NULL DEFAULT 1,
    ref_value_eur  TEXT,                -- waarde per stuk op 31/12/2025
    ref_source     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner           TEXT NOT NULL DEFAULT 'default',
    broker          TEXT NOT NULL DEFAULT '',
    trade_date      TEXT NOT NULL,
    type            TEXT NOT NULL,
    asset           TEXT NOT NULL,
    quantity        TEXT NOT NULL DEFAULT '0',
    price           TEXT NOT NULL DEFAULT '0',
    currency        TEXT NOT NULL DEFAULT 'EUR',
    fx_per_eur      TEXT NOT NULL DEFAULT '1',
    fees            TEXT NOT NULL DEFAULT '0',
    taxes           TEXT NOT NULL DEFAULT '0',
    split_ratio     TEXT,
    historic_proven INTEGER NOT NULL DEFAULT 0,
    cost_known      INTEGER NOT NULL DEFAULT 1,
    reynders_eur    TEXT NOT NULL DEFAULT '0',
    amount          TEXT NOT NULL DEFAULT '0',
    note            TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tax_years (
    year                  INTEGER PRIMARY KEY,
    rate                  TEXT NOT NULL,
    base_exemption        TEXT NOT NULL,
    carry_slice           TEXT NOT NULL,
    carry_validity_years  INTEGER NOT NULL,
    source                TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS withheld (
    owner   TEXT NOT NULL,
    year    INTEGER NOT NULL,
    amount  TEXT NOT NULL,
    PRIMARY KEY (owner, year)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {"historic_method": "FIFO", "fifo_scope": "EIGENAAR"}


def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM tax_years").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO tax_years VALUES (2026, '0.10', '10000', '1000', 5, ?)",
            ("Wet 6.4.2026 (BS 21.4.2026); vrijstelling 2026 = 10.000 EUR",),
        )
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings VALUES (?, ?)", (k, v))
    conn.commit()
