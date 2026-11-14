"""Webapp (Flask): JSON-API + statische frontend.

Start:  python3 -m web.app            (http://127.0.0.1:5000)
DB:     MEERWAARDE_DB=pad/naar.db      (standaard ./meerwaarde.db)
"""

from __future__ import annotations

import csv
import io
import os
import sqlite3
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_from_directory

from engine import (
    EngineConfig,
    FifoScope,
    HistoricMethod,
    TaxYearConfig,
    Transaction,
    TxType,
    calculate,
)
from engine.models import ACQUISITION_TYPES

from . import db as dbmod

STATIC = Path(__file__).parent / "static"
ASSET_TYPES = ["aandeel", "etf", "obligatie", "fonds", "crypto", "valuta", "verzekering", "ander"]


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


# ---------------------------------------------------------------- parsing/validatie

def dec(value, field: str, *, required=False, positive=False, non_negative=False) -> Decimal | None:
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if required:
            raise ApiError(f"Veld '{field}' is verplicht.")
        return None
    try:
        d = Decimal(str(value).strip().replace(",", "."))
    except InvalidOperation:
        raise ApiError(f"Veld '{field}' is geen geldig getal: {value!r}")
    if not d.is_finite():
        raise ApiError(f"Veld '{field}' is geen geldig getal.")
    if positive and d <= 0:
        raise ApiError(f"Veld '{field}' moet groter dan 0 zijn.")
    if non_negative and d < 0:
        raise ApiError(f"Veld '{field}' mag niet negatief zijn.")
    return d


def s(d: Decimal | None) -> str | None:
    return None if d is None else str(d)


def validate_tx(p: dict) -> dict:
    try:
        tx_type = TxType(p.get("type", ""))
    except ValueError:
        raise ApiError(f"Onbekend transactietype: {p.get('type')!r}")
    try:
        trade_date = date.fromisoformat(str(p.get("trade_date", "")))
    except ValueError:
        raise ApiError("Datum moet het formaat JJJJ-MM-DD hebben.")
    asset = str(p.get("asset", "")).strip().upper()
    if not asset:
        raise ApiError("Actief (ISIN of ticker) is verplicht.")

    out = {
        "owner": str(p.get("owner") or "default").strip(),
        "broker": str(p.get("broker") or "").strip(),
        "trade_date": trade_date.isoformat(),
        "type": tx_type.value,
        "asset": asset,
        "currency": str(p.get("currency") or "EUR").strip().upper(),
        "fx_per_eur": s(dec(p.get("fx_per_eur") or "1", "wisselkoers", positive=True)),
        "fees": s(dec(p.get("fees") or "0", "kosten", non_negative=True)),
        "taxes": s(dec(p.get("taxes") or "0", "taksen", non_negative=True)),
        "historic_proven": 1 if p.get("historic_proven") else 0,
        "cost_known": 0 if p.get("cost_known") is False else 1,
        "reynders_eur": s(dec(p.get("reynders_eur") or "0", "Reynders-bedrag", non_negative=True)),
        "note": str(p.get("note") or "").strip(),
        "quantity": "0", "price": "0", "amount": "0", "split_ratio": None,
    }
    if out["currency"] == "EUR" and Decimal(out["fx_per_eur"]) != 1:
        raise ApiError("Voor EUR moet de wisselkoers 1 zijn.")

    if tx_type in ACQUISITION_TYPES or tx_type == TxType.SELL:
        out["quantity"] = s(dec(p.get("quantity"), "aantal", required=True, positive=True))
        need_price = tx_type == TxType.SELL or out["cost_known"]
        price = dec(p.get("price"), "prijs", required=need_price, non_negative=True)
        out["price"] = s(price if price is not None else Decimal(0))
    elif tx_type == TxType.SPLIT:
        out["split_ratio"] = s(dec(p.get("split_ratio"), "split-ratio", required=True, positive=True))
    elif tx_type in (TxType.DIVIDEND, TxType.FEE):
        out["amount"] = s(dec(p.get("amount"), "bedrag", required=True, non_negative=True))
    return out


# ---------------------------------------------------------------- app

def create_app(db_path: str | Path | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["DB_PATH"] = str(db_path or os.environ.get("MEERWAARDE_DB", "meerwaarde.db"))
    conn0 = dbmod.connect(app.config["DB_PATH"])
    dbmod.init(conn0)
    conn0.close()

    def conn() -> sqlite3.Connection:
        if "db" not in g:
            g.db = dbmod.connect(app.config["DB_PATH"])
        return g.db

    @app.teardown_appcontext
    def _close(_exc):
        c = g.pop("db", None)
        if c is not None:
            c.close()

    @app.errorhandler(ApiError)
    def _api_error(e: ApiError):
        return jsonify(error=e.message), e.status

    @app.errorhandler(ValueError)
    def _value_error(e: ValueError):
        return jsonify(error=f"Ongeldige waarde: {e}"), 400

    def body() -> dict:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ApiError("Verwacht een JSON-object.")
        return data

    def ensure_asset(isin: str, currency: str) -> None:
        conn().execute(
            "INSERT OR IGNORE INTO assets (isin, name, currency) VALUES (?, ?, ?)", (isin, "", currency)
        )

    # -- statisch
    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(STATIC, name)

    # -- meta
    @app.get("/api/meta")
    def meta():
        return jsonify(
            tx_types=[t.value for t in TxType],
            asset_types=ASSET_TYPES,
            historic_methods=[m.value for m in HistoricMethod],
            fifo_scopes=[m.value for m in FifoScope],
        )

    # -- transacties
    @app.get("/api/transactions")
    def list_tx():
        q, args = "SELECT * FROM transactions WHERE 1=1", []
        if request.args.get("year"):
            q += " AND substr(trade_date,1,4)=?"
            args.append(request.args["year"])
        if request.args.get("owner"):
            q += " AND owner=?"
            args.append(request.args["owner"])
        if request.args.get("asset"):
            q += " AND asset=?"
            args.append(request.args["asset"].upper())
        rows = conn().execute(q + " ORDER BY trade_date DESC, id DESC", args).fetchall()
        return jsonify([tx_row(r) for r in rows])

    @app.post("/api/transactions")
    def create_tx():
        t = validate_tx(body())
        ensure_asset(t["asset"], t["currency"])
        cols = ", ".join(t)
        cur = conn().execute(
            f"INSERT INTO transactions ({cols}) VALUES ({', '.join('?' * len(t))})", list(t.values())
        )
        conn().commit()
        return jsonify(tx_row(get_tx(cur.lastrowid))), 201

    @app.put("/api/transactions/<int:tx_id>")
    def update_tx(tx_id):
        get_tx(tx_id)
        t = validate_tx(body())
        ensure_asset(t["asset"], t["currency"])
        conn().execute(
            f"UPDATE transactions SET {', '.join(f'{k}=?' for k in t)} WHERE id=?",
            [*t.values(), tx_id],
        )
        conn().commit()
        return jsonify(tx_row(get_tx(tx_id)))

    @app.delete("/api/transactions/<int:tx_id>")
    def delete_tx(tx_id):
        get_tx(tx_id)
        conn().execute("DELETE FROM transactions WHERE id=?", (tx_id,))
        conn().commit()
        return "", 204

    def get_tx(tx_id):
        r = conn().execute("SELECT * FROM transactions WHERE id=?", (tx_id,)).fetchone()
        if r is None:
            raise ApiError("Transactie niet gevonden.", 404)
        return r

    def tx_row(r) -> dict:
        d = dict(r)
        d["historic_proven"] = bool(d["historic_proven"])
        d["cost_known"] = bool(d["cost_known"])
        return d

    # -- activa
    @app.get("/api/assets")
    def list_assets():
        rows = conn().execute(
            """SELECT a.*,
                  (SELECT MIN(trade_date) FROM transactions t WHERE t.asset=a.isin) AS first_tx,
                  EXISTS(SELECT 1 FROM transactions t WHERE t.asset=a.isin AND t.trade_date < '2026-01-01'
                         AND t.type IN ('BUY','TRANSFER_IN','GIFT_IN','INHERIT_IN')) AS needs_ref
               FROM assets a ORDER BY a.isin"""
        ).fetchall()
        return jsonify([{**dict(r), "listed": bool(r["listed"]), "needs_ref": bool(r["needs_ref"])} for r in rows])

    @app.put("/api/assets/<isin>")
    def upsert_asset(isin):
        p = body()
        isin = isin.strip().upper()
        atype = p.get("asset_type") or "aandeel"
        if atype not in ASSET_TYPES:
            raise ApiError(f"Onbekend type actief: {atype}")
        ref = dec(p.get("ref_value_eur"), "waarde 31/12/2025", non_negative=True)
        conn().execute(
            """INSERT INTO assets (isin, name, asset_type, currency, listed, ref_value_eur, ref_source)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(isin) DO UPDATE SET name=excluded.name, asset_type=excluded.asset_type,
                 currency=excluded.currency, listed=excluded.listed,
                 ref_value_eur=excluded.ref_value_eur, ref_source=excluded.ref_source""",
            (isin, str(p.get("name") or ""), atype, str(p.get("currency") or "EUR").upper(),
             1 if p.get("listed", True) else 0, s(ref), str(p.get("ref_source") or "")),
        )
        conn().commit()
        return jsonify(ok=True)

    @app.delete("/api/assets/<isin>")
    def delete_asset(isin):
        isin = isin.upper()
        if conn().execute("SELECT 1 FROM transactions WHERE asset=?", (isin,)).fetchone():
            raise ApiError("Dit actief heeft nog transacties.", 409)
        conn().execute("DELETE FROM assets WHERE isin=?", (isin,))
        conn().commit()
        return "", 204

    # -- fiscale jaren
    @app.get("/api/years")
    def list_years():
        return jsonify([dict(r) for r in conn().execute("SELECT * FROM tax_years ORDER BY year")])

    @app.put("/api/years/<int:year>")
    def upsert_year(year):
        if not 2026 <= year <= 2100:
            raise ApiError("Jaar moet vanaf 2026 zijn.")
        p = body()
        rate = dec(p.get("rate"), "tarief", required=True, non_negative=True)
        if rate > 1:
            raise ApiError("Tarief als fractie invoeren (0.10 = 10%).")
        vals = (
            year, s(rate),
            s(dec(p.get("base_exemption"), "basisvrijstelling", required=True, non_negative=True)),
            s(dec(p.get("carry_slice"), "overdraagbare schijf", required=True, non_negative=True)),
            int(p.get("carry_validity_years") or 5), str(p.get("source") or ""),
        )
        conn().execute(
            """INSERT INTO tax_years VALUES (?,?,?,?,?,?) ON CONFLICT(year) DO UPDATE SET
               rate=excluded.rate, base_exemption=excluded.base_exemption, carry_slice=excluded.carry_slice,
               carry_validity_years=excluded.carry_validity_years, source=excluded.source""", vals)
        conn().commit()
        return jsonify(ok=True)

    @app.delete("/api/years/<int:year>")
    def delete_year(year):
        conn().execute("DELETE FROM tax_years WHERE year=?", (year,))
        conn().commit()
        return "", 204

    # -- ingehouden bronheffing
    @app.get("/api/withheld")
    def list_withheld():
        return jsonify([dict(r) for r in conn().execute("SELECT * FROM withheld ORDER BY year, owner")])

    @app.put("/api/withheld")
    def upsert_withheld():
        p = body()
        owner = str(p.get("owner") or "default").strip()
        year = int(p.get("year") or 0)
        if year < 2026:
            raise ApiError("Jaar moet vanaf 2026 zijn.")
        amount = dec(p.get("amount"), "bedrag", required=True, non_negative=True)
        conn().execute(
            "INSERT INTO withheld VALUES (?,?,?) ON CONFLICT(owner,year) DO UPDATE SET amount=excluded.amount",
            (owner, year, s(amount)))
        conn().commit()
        return jsonify(ok=True)

    @app.delete("/api/withheld/<owner>/<int:year>")
    def delete_withheld(owner, year):
        conn().execute("DELETE FROM withheld WHERE owner=? AND year=?", (owner, year))
        conn().commit()
        return "", 204

    # -- instellingen
    @app.get("/api/settings")
    def get_settings():
        return jsonify({r["key"]: r["value"] for r in conn().execute("SELECT * FROM settings")})

    @app.put("/api/settings")
    def put_settings():
        p = body()
        if "historic_method" in p:
            HistoricMethod(p["historic_method"])
        if "fifo_scope" in p:
            FifoScope(p["fifo_scope"])
        for k in ("historic_method", "fifo_scope"):
            if k in p:
                conn().execute("UPDATE settings SET value=? WHERE key=?", (p[k], k))
        conn().commit()
        return get_settings()

    # -- rapport
    def load_engine_inputs(method: HistoricMethod | None = None):
        c = conn()
        st = {r["key"]: r["value"] for r in c.execute("SELECT * FROM settings")}
        years = {
            r["year"]: TaxYearConfig(
                year=r["year"], rate=Decimal(r["rate"]), base_exemption=Decimal(r["base_exemption"]),
                carry_slice=Decimal(r["carry_slice"]), carry_validity_years=r["carry_validity_years"],
                source=r["source"])
            for r in c.execute("SELECT * FROM tax_years")
        }
        cfg = EngineConfig(
            years=years,
            historic_method=method or HistoricMethod(st["historic_method"]),
            fifo_scope=FifoScope(st["fifo_scope"]),
        )
        refs = {r["isin"]: Decimal(r["ref_value_eur"])
                for r in c.execute("SELECT isin, ref_value_eur FROM assets WHERE ref_value_eur IS NOT NULL")}
        withheld = {(r["owner"], r["year"]): Decimal(r["amount"]) for r in c.execute("SELECT * FROM withheld")}
        txs = [
            Transaction(
                trade_date=date.fromisoformat(r["trade_date"]), type=TxType(r["type"]), asset=r["asset"],
                quantity=Decimal(r["quantity"]), price=Decimal(r["price"]), currency=r["currency"],
                fx_per_eur=Decimal(r["fx_per_eur"]), fees=Decimal(r["fees"]), taxes=Decimal(r["taxes"]),
                owner=r["owner"], broker=r["broker"],
                split_ratio=Decimal(r["split_ratio"]) if r["split_ratio"] else None,
                historic_proven=bool(r["historic_proven"]), cost_known=bool(r["cost_known"]),
                reynders_eur=Decimal(r["reynders_eur"]), amount=Decimal(r["amount"]),
                source=f"transactie #{r['id']}",
            )
            for r in c.execute("SELECT * FROM transactions ORDER BY trade_date, id")
        ]
        return txs, refs, cfg, withheld

    def run(method=None):
        txs, refs, cfg, withheld = load_engine_inputs(method)
        try:
            return calculate(txs, refs, cfg, withheld), cfg
        except (ValueError, KeyError) as e:
            raise ApiError(str(e).strip("'\""), 422)

    @app.get("/api/report")
    def report():
        rep, cfg = run()
        other = next(m for m in HistoricMethod if m != cfg.historic_method)
        try:
            alt, _ = run(other)
            alt_years = {k: v for k, v in alt.years.items()}
        except ApiError:
            alt_years = {}
        years = []
        for (owner, year), y in sorted(rep.years.items()):
            a = alt_years.get((owner, year))
            years.append({
                "owner": owner, "year": year,
                **{k: s(getattr(y, k)) for k in (
                    "gains_eur", "losses_eur", "net_eur", "lost_losses_eur", "exemption_available_eur",
                    "carry_used_eur", "base_used_eur", "carry_generated_eur", "taxable_eur", "tax_eur",
                    "withheld_eur", "refund_eur", "dividends_eur")},
                "sale_count": y.sale_count,
                "carry_detail": {str(k): s(v) for k, v in y.carry_detail.items()},
                "alternative": None if a is None or a.tax_eur == y.tax_eur and a.net_eur == y.net_eur else {
                    "method": other.value, "net_eur": s(a.net_eur), "tax_eur": s(a.tax_eur)},
            })
        sales = [{
            "trade_date": x.trade_date.isoformat(), "owner": x.owner, "broker": x.broker, "asset": x.asset,
            "quantity": s(x.quantity), "proceeds_eur": s(x.proceeds_eur), "fees_eur": s(x.fees_eur),
            "reynders_deduction_eur": s(x.reynders_deduction_eur), "result_eur": s(x.result_eur),
            "warnings": x.warnings, "source": x.source,
            "lines": [{
                "acquired": l.acquired.isoformat() if l.acquired else None, "quantity": s(l.quantity),
                "proceeds_eur": s(l.proceeds_eur), "basis_eur": s(l.basis_eur),
                "basis_used": l.basis_used.value, "result_eur": s(l.result_eur), "note": l.note,
            } for l in x.lines],
        } for x in rep.sales]
        return jsonify(
            settings={"historic_method": cfg.historic_method.value, "fifo_scope": cfg.fifo_scope.value},
            years=years, sales=sales, warnings=rep.warnings, disclaimer=rep.disclaimer,
        )

    @app.get("/api/report/sales.csv")
    def report_csv():
        rep, _ = run()
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(["eigenaar", "broker", "verkoopdatum", "actief", "aankoopdatum lot", "aantal",
                    "opbrengst_eur", "basis_eur", "basis", "resultaat_eur", "opmerking"])
        for x in rep.sales:
            for l in x.lines:
                w.writerow([x.owner, x.broker, x.trade_date, x.asset, l.acquired or "", l.quantity,
                            l.proceeds_eur, l.basis_eur, l.basis_used.value, l.result_eur, l.note])
            if x.reynders_deduction_eur:
                w.writerow([x.owner, x.broker, x.trade_date, x.asset, "", "", "", "", "REYNDERS",
                            -x.reynders_deduction_eur, "Aftrek belastbare interestcomponent"])
        return Response("﻿" + buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=verkopen.csv"})

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
